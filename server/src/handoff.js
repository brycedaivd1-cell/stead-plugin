// Handing a step to the person in the Stead window, and waiting until they've done it.
//
// Some steps are theirs, not Claude's: a CAPTCHA or "verify you're human", typing a card number,
// approving a payment, signing in. The window comes on screen on the tab Claude was using, with a
// note saying what's needed; Stead watches for the step to be finished, then hides the window and
// Claude carries on. browser_login (login.js) uses the same pieces for sign-ins.
import { show, hide } from './window.js';

// Claude Code and Codex give up on a tool call after 120 s, and the call then fails even though the
// person may finish a moment later. So one call waits at most this long, page load included, and
// says "still waiting"; calling again picks up where it left off.
export const CALL_BUDGET_MS = Number(process.env.STEAD_HANDOFF_BUDGET_MS) || 95000;

// A Playwright connection of our own to their Chrome, for the length of one tool call only.
// noDefaults leaves downloads alone (otherwise they land in a temp folder under GUID names), and
// the empty dialog listener stops this client cancelling every confirm() before Claude sees it.
export async function connect(port) {
  const { chromium } = await import('playwright-core');
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  for (const c of b.contexts()) c.on('dialog', () => {});
  return b;
}

// DevTools' own id for a tab: stable across connections, unlike Playwright's page order.
export async function targetIdOf(page) {
  const s = await page.context().newCDPSession(page);
  try { return (await s.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await s.detach().catch(() => {}); }
}

export async function pageById(b, id) {
  if (!id) return null;
  for (const p of b.contexts().flatMap((c) => c.pages())) {
    if (await targetIdOf(p).catch(() => null) === id) return p;
  }
  return null;
}

// The tab Claude is working in. Asked of the browser child when we can reach it; otherwise the
// DevTools list, which is in order of last use, so its first page is the one Claude was just on.
const TARGET_CODE = `async (page) => { const s = await page.context().newCDPSession(page);
  try { return (await s.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await s.detach().catch(() => {}); } }`;
export async function claudesTab(port, callBrowser) {
  if (callBrowser) {
    const r = await callBrowser('browser_run_code_unsafe', { code: TARGET_CODE }).catch(() => null);
    const t = (r?.content || []).map((c) => c.text || '').join('\n');
    const id = !r?.isError && (t.match(/### Result\n"([0-9A-Fa-f]+)"/) || [])[1];
    if (id) return id;
  }
  // Bounded: a Chrome stuck on a frozen tab can leave this request hanging past the call's budget.
  const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => []);
  return list.find((p) => p.type === 'page')?.id || null;
}

// An open alert() or confirm() freezes the page, and an evaluate would wait on it forever, past the
// client's timeout. Nothing here waits more than a few seconds.
const within = (p, ms = 3000) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms).unref())]);

// A strip along the bottom of the page saying what Stead is waiting for. Clicks go straight
// through it, and it is removed when the step is done.
const NOTE_ID = 'stead-needs-you';
export async function putNote(page, message) {
  await within(page.evaluate(([id, msg]) => {
    if (!document.body || document.getElementById(id)) return;
    const n = document.createElement('div');
    n.id = id;
    n.textContent = msg;
    n.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;background:#111;color:#fff;'
      + 'font:600 15px/1.4 system-ui,sans-serif;padding:10px 16px;text-align:center;box-shadow:0 -2px 8px rgba(0,0,0,.3)';
    document.body.appendChild(n);
  }, [NOTE_ID, message]).catch(() => {}));
}
export const removeNote = (page) => within(page.evaluate((id) => document.getElementById(id)?.remove(), NOTE_ID).catch(() => {}));

// What the page looks like now, for telling when the person has finished. CAPTCHA answers are
// checked by length only; nothing here reads a value.
const LOOK = (noteId) => {
  const note = document.getElementById(noteId);
  const all = document.body ? document.body.innerText : '';
  const tokens = [...document.querySelectorAll('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]')];
  const challenge = [...document.querySelectorAll('iframe')].some((f) => /recaptcha|hcaptcha|challenges\.cloudflare\.com|arkoselabs|funcaptcha/.test(f.src)
    && f.getBoundingClientRect().width > 2 && getComputedStyle(f).visibility !== 'hidden');
  return {
    text: (note ? all.replace(note.innerText, '') : all).replace(/\s+/g, ' ').toLowerCase(),
    captcha: tokens.length > 0,
    solved: tokens.some((t) => t.value.length > 0),
    challenge,
    loaded: document.readyState === 'complete',
  };
};
const look = (page) => within(page.evaluate(LOOK, NOTE_ID).catch(() => null));

// Why it's finished, or null. With a condition from Claude, only that counts.
async function finished(page, base, { done_when_text, done_when_url }) {
  const url = page.url();
  if (done_when_url) return url.includes(done_when_url) ? `the page is now at ${where(url)}` : null;
  const now = await look(page);
  if (!now) return null; // between pages
  if (done_when_text) return now.text.includes(String(done_when_text).replace(/\s+/g, ' ').toLowerCase()) ? `"${done_when_text}" is on the page` : null;
  if (url !== base.url) return `the page moved on to ${where(url)}`;
  if (base.captcha && !base.solved && now.solved) return 'the CAPTCHA is solved';
  if (base.challenge && !now.challenge && now.loaded) return 'the check is gone from the page';
  return null;
}

// Where they ended up, without the query or hash: those can carry tokens or form values.
export const where = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return '(the site)'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What each tab looked like when the hand-off started, so a "still waiting" call followed by one
// made after they finished still sees that something changed.
// Keyed by tab AND what was asked, so an old unfinished hand-off on the same tab can't make a new
// one look done the moment it starts.
const started = new Map();
const STALE = 30 * 60000;
// A scheduled job or a phone session: nobody is at the computer to do the step.
export const AWAY = () => process.env.STEAD_UNATTENDED === '1' || process.env.STEAD_PHONE === '1';

export function handoffTool({ port, dir, ensureChrome, callBrowser }) {
  return {
    name: 'browser_handoff',
    description: 'Hand a step on the current page to the person: a CAPTCHA, typing a card number or CVC, approving a payment, anything theirs to do. Never solve or fill these yourself. Shows the window with your note, waits until done_when_text is on the page or the URL contains done_when_url (with neither: the page moves on), then hides it. "still waiting": call again the same way. A file to choose: ask its path, browser_file_upload. Signing in: browser_login.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Shown to them, e.g. "Tick the I\'m not a robot box"' },
        done_when_text: { type: 'string', description: 'e.g. "Order confirmed"' },
        done_when_url: { type: 'string', description: 'e.g. "/confirmation"' },
        wait_seconds: { type: 'number', description: 'Max 90' },
      },
      required: ['reason'],
    },
    run: async ({ reason, done_when_text, done_when_url, wait_seconds = 90 }) => {
      const say = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
      if (AWAY()) return say(`Nobody is at the computer right now (this is a scheduled job or a phone session), so this step can't be handed to them: ${String(reason).trim()}. Stop here, leave the tab as it is, and tell them exactly what is left for them to do when they're back.`, true);
      const until = Date.now() + Math.min(Math.max(Number(wait_seconds) || 90, 2) * 1000, CALL_BUDGET_MS);
      await ensureChrome();
      const id = await claudesTab(port, callBrowser);
      const b = await connect(port);
      let page = null;
      let shown = false;
      let done = false;
      try {
        page = await pageById(b, id);
        if (!page) return say('There is no open page to hand over. Open it with browser_navigate first, then call browser_handoff.', true);
        const key = JSON.stringify([id, String(reason).trim(), done_when_text || '', done_when_url || '']);
        for (const [k, v] of started) if (Date.now() - v.at > STALE) started.delete(k);
        let base = started.get(key);
        if (!base) {
          base = { at: Date.now(), url: page.url(), ...(await look(page)) };
          started.set(key, base);
        }
        await page.bringToFront().catch(() => {});
        shown = (await show(dir, { port }).catch(() => ({ moved: 0 }))).moved > 0;
        const note = `Stead needs you: ${String(reason).trim()}. Do it in this window; Stead carries on by itself when it's done.`;
        for (;;) {
          if (page.isClosed()) { started.delete(key); return say('They closed that tab before it was done.', true); }
          await putNote(page, note);
          const why = await finished(page, base, { done_when_text, done_when_url });
          if (why) {
            done = true;
            started.delete(key);
            return say(`Done: ${why}. The window is hidden again; carry on, and take a snapshot first.`);
          }
          if (Date.now() >= until) break;
          await sleep(Math.min(2000, Math.max(until - Date.now(), 0)));
        }
        const secs = Math.round((Date.now() - base.at) / 1000);
        return say(`Still waiting for them (${secs} s so far): ${reason}. The window is on screen with a note telling them. Tell them in chat too, then call browser_handoff again with the same arguments to keep waiting; it picks up where it left off.`);
      } finally {
        if (done && page && !page.isClosed()) await removeNote(page);
        if (done && shown) await hide(dir, { port }).catch(() => {});
        await b.close().catch(() => {});
      }
    },
  };
}
