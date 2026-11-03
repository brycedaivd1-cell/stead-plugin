// browser_login: get the person signed in to a site without Claude ever seeing a password.
//
// Claude in Chrome feels good at logins because it lives in the person's everyday browser,
// where they're already signed in. Stead's profile is separate, so we close the gap two ways:
//   1. Chrome's own password manager. If they turned on sync in the Stead window, their saved
//      passwords are here, and Chrome fills them only on the real site (lookalike phishing
//      domains get nothing). We focus the field with a real click so Chrome releases the fill,
//      check that the fields are non-empty (length only, never the value), and submit.
//   2. Otherwise, or for 2FA, the window comes on screen and we wait until they've finished,
//      then hide it. No "tell me when you're done" round trip.
// Nothing here reads, returns or logs a field value.
import { show, hide } from './window.js';
import { CALL_BUDGET_MS, connect, targetIdOf, pageById, where, handoffTool, AWAY, claudesTab } from './handoff.js';
import { judge } from './approve.js';
import { signInWithGoogle, walkGoogle, findGoogleButton, onGoogle } from './google-sso.js';

const PASSWORD = 'input[type="password"]';
const OTP = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i][inputmode="numeric"]';
// A box for the account name. Narrow on purpose: a newsletter's email box in the footer is not one.
const USER = 'input[autocomplete="username"], input[name*="user" i], input[name*="login" i], input[id*="user" i]';
const SIGN_IN_PATH = /\/(login|log-in|signin|sign-in|sign_in|auth|sso|mfa|2fa|two-factor|challenge)\b/i;

// Sign-in services. Their steps after the password (approve it on your phone, "Stay signed in?",
// pick an account, allow access) have no password box and a harmless-looking URL, so without this
// list they look finished and the window gets hidden while the person is still approving.
const IDP = /(^|\.)(accounts\.google\.com|login\.live\.com|login\.microsoftonline\.com|login\.microsoft\.com|account\.live\.com|appleid\.apple\.com|idmsa\.apple\.com|login\.yahoo\.com|okta\.com|oktapreview\.com|auth0\.com|onelogin\.com|duosecurity\.com)$/i;
// The ones that are never the destination. An Okta or Apple ID page can be where they wanted to
// end up when that is the site they asked to sign in to.
const AUTH_ONLY = /^(accounts\.google\.com|login\.live\.com|login\.microsoftonline\.com|login\.microsoft\.com|idmsa\.apple\.com)$/i;

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
// The site a host belongs to (mail.example.co.uk -> example.co.uk), near enough without a suffix list.
const siteOf = (h) => {
  if (/^[\d.]+$|:/.test(h)) return h;
  const p = h.split('.');
  return p.slice(p.length > 2 && /^(co|com|net|org|gov|edu|ac)$/.test(p.at(-2)) && p.at(-1).length === 2 ? -3 : -2).join('.');
};

const onSignInPage = (u, want) => SIGN_IN_PATH.test(u.pathname) || (IDP.test(u.hostname) && (AUTH_ONLY.test(u.hostname) || u.hostname !== want));
export const isSignInPage = (url, requestedUrl) => { try { return onSignInPage(new URL(url), hostOf(requestedUrl)); } catch { return false; } };

// Is this URL still part of signing in? Exported for tests. Some sites show the sign-in form and the
// signed-in page at the same address (WooCommerce /my-account/, facebook.com/), so the same URL only
// counts as still signing in while an account-name box is on the page (formVisible).
export function stillSigningIn(now, startUrl, requestedUrl, { formVisible = true } = {}) {
  let u;
  try { u = new URL(now); } catch { return true; }
  const want = hostOf(requestedUrl), start = hostOf(startUrl);
  if ((now === startUrl && formVisible) || onSignInPage(u, want)) return true;
  // Sent to another site to sign in (a school or work account): done only once it sends them back.
  return siteOf(start) !== siteOf(want) && u.hostname === start;
}

async function visible(page, sel) {
  try {
    for (const el of await page.$$(sel)) if (await el.isVisible()) return el;
  } catch { /* page navigating mid-check */ }
  return null;
}

// Signed in = no visible password or one-time-code field, and we've left every sign-in page.
async function signedIn(page, startUrl, requestedUrl) {
  if (page.isClosed()) return false;
  if (onGoogle(page.url()) || await findGoogleButton(page).catch(() => null)) return false;
  if (await visible(page, PASSWORD)) return false;
  if (await visible(page, OTP)) return false;
  return !stillSigningIn(page.url(), startUrl, requestedUrl, { formVisible: !!(await visible(page, USER)) });
}

// Runs in the page: the button that submits the password box's own form, and what it says. Never a
// button elsewhere on the page (a header search, "Sign in with Google" above the form).
function FORM_SUBMIT(pw) {
  const form = pw.form;
  const vis = (n) => { const r = n.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(n).visibility !== 'hidden'; };
  const label = (b) => String(b.getAttribute('aria-label') || b.innerText || b.value || b.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const newPassword = pw.autocomplete === 'new-password';
  if (!form) {
    // No form (a script-driven page): the buttons in the box around the password are what Enter
    // is wired to.
    for (let p = pw.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) {
      const bs = [...p.querySelectorAll('button, [role=button], input[type=submit]')].filter(vis);
      if (bs.length) return { form: false, name: label(bs[0]), names: bs.map(label), newPassword };
    }
    return { form: false, name: '', names: [], newPassword };
  }
  const btn = [...form.querySelectorAll('button:not([type]), button[type=submit], input[type=submit], input[type=image]')].find(vis)
    || [...document.querySelectorAll('button[form], input[type=submit][form]')].find((b) => b.form === form && vis(b));
  return { form: true, name: btn ? label(btn) : '', names: btn ? [label(btn)] : [], newPassword };
}
// A sign-in button says so. Anything else on a form with a password box is a re-auth step for
// something else ("Delete account", "Confirm payment") and is the person's to press.
// No empty alternative: an icon-only button with no name says nothing, so it's theirs too.
const SIGN_IN_LABEL = /^(sign ?in|log ?in|login|log on|sign on|next|continue|submit|verify|go|enter|ok|→|>)$/i;

// Wait for the first of these to happen, or ms, whichever is sooner. A step that fails (a page
// navigating away mid-wait) just doesn't count: never an early return because of an error.
const firstOf = (ms, ...steps) => Promise.race([new Promise((r) => setTimeout(r, ms)), ...steps.map((p) => p.then(() => {}, () => new Promise(() => {})))]);
const hasValue = (pw, ms) => pw.evaluate((el, ms2) => new Promise((r) => {
  const end = Date.now() + ms2;
  (function check() { if (el.value.length > 0 || Date.now() > end) r(); else setTimeout(check, 50); })();
}), ms).catch(() => {});

async function tryPasswordManager(page) {
  const pw = await visible(page, PASSWORD);
  if (!pw) return 'no-form';
  const user = await visible(page, USER + ', input[type="email"], input[name*="email" i]');
  // A trusted click is what makes Chrome hand its autofilled values to the page.
  // Each wait ends as soon as the box has a value (length only), not after a fixed second or two.
  await (user || pw).click().catch(() => {});
  await hasValue(pw, 1200);
  await pw.click().catch(() => {});
  await hasValue(pw, 600);
  const filled = await pw.evaluate((el) => el.value.length > 0).catch(() => false);
  if (!filled) return 'not-saved';
  const f = await pw.evaluate(FORM_SUBMIT).catch(() => null);
  if (!f || f.newPassword) return 'theirs';
  // Judged the same way as any click, and a label that isn't plainly "sign in" is theirs to press.
  if ([f.name || 'Submit', ...f.names].some((name) => judge({ role: 'button', name, url: page.url() })) || !SIGN_IN_LABEL.test(f.name.toLowerCase())) return 'theirs';
  // Enter in the password box submits its own form (or does what the page wires Enter to there),
  // never a button somewhere else on the page.
  await pw.press('Enter').catch(() => {});
  return 'submitted';
}

// browser_login takes a site name too ("chase.com").
const asUrl = (u) => { const s = String(u || '').trim(); return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`; };

// A sign-in that ran out of call time, by the URL Claude asked for: its tab, where it started and
// when, so the next call keeps watching the same tab instead of opening another.
const waiting = new Map();
const STALE = 30 * 60000;

export function loginTools({ port, dir, ensureChrome, callBrowser }) {
  return [{
    name: 'browser_login',
    description: 'Sign them in to a website instead of asking for passwords: opens the sign-in page, Chrome fills a saved password (you never see it), else the window comes up while they sign in or do 2FA. With provider "google" it presses Sign in with Google and picks their account. "Not signed in yet": call again with the same url to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Sign-in page (best) or the site\'s home page' },
        wait_minutes: { type: 'number', description: 'Total, across calls (default 5)' },
        provider: { type: 'string', enum: ['auto', 'password', 'google'], description: 'google: they sign in to this site with Google (their memory says so, or they told you). auto (default): Google only when the page has no password or email box, just provider buttons' },
        account: { type: 'string', description: 'With google: the Google account to pick when several are signed in (an email address from their memory)' },
        approved_access: { type: 'boolean', description: 'With google: true ONLY after they said yes in chat to exactly what Google said the site wants (Gmail, Drive, contacts...). Never on your own' },
      },
      required: ['url'],
    },
    run: async ({ url: asked, wait_minutes = 5, provider = 'auto', account, approved_access = false }) => {
      const t0 = Date.now();
      const url = asUrl(asked);
      await ensureChrome();
      const b = await connect(port);
      const say = (t) => ({ content: [{ type: 'text', text: t }] });
      let page = null;
      let shown = false;
      let done = false;
      try {
        let job = waiting.get(url);
        if (job && Date.now() - job.since > STALE) job = null;
        page = job && (await pageById(b, job.id));
        const fresh = !page;
        if (!page && callBrowser) {
          // Opened through the browser tools, so it's their current tab afterwards: the next
          // browser_snapshot or click lands on the signed-in page, not the tab Claude was on before.
          const r = await callBrowser('browser_tabs', { action: 'new', url }).catch(() => null);
          if (r && !r.isError) page = await pageById(b, await claudesTab(port, callBrowser)).catch(() => null);
        }
        if (!page) {
          page = await b.contexts()[0].newPage();
          try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {
            await page.close().catch(() => {});
            page = null;
            return say(`Couldn't open ${url}: ${String(e.message).split('\n')[0]}. Check the address and call again.`);
          }
        }
        if (fresh) {
          // Until a password or code box shows (most sign-in pages: at once), at most 1.5 s.
          await firstOf(1500, page.waitForSelector(`${PASSWORD}, ${OTP}`, { state: 'visible', timeout: 1500 }));
          const start = page.url();
          // Sign in with Google: when asked, or when the page offers nothing but provider buttons.
          const boxes = (await visible(page, PASSWORD)) || (await visible(page, OTP)) || (await visible(page, USER + ', input[type="email"]'));
          if (provider === 'google' || (provider === 'auto' && !boxes)) {
            const g = await signInWithGoogle(page, { account, approved: approved_access });
            if (g.result === 'no-button' && provider === 'google') {
              return say(`No "Sign in with Google" button on ${where(start)}. Call again with the site's sign-in page, or with provider "auto". The tab is left open.`);
            }
            if (g.result !== 'no-button') {
              job = { id: await targetIdOf(page), start, since: Date.now(), pm: g.result === 'theirs' ? 'google' : 'google-back', why: g.why, front: g.page && !g.page.isClosed() ? await targetIdOf(g.page).catch(() => null) : null };
              waiting.set(url, job);
              if (g.result === 'back') {
                await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
                let twice = await signedIn(page, start, url);
                if (twice) { await page.waitForTimeout(2000); twice = await signedIn(page, start, url); }
                if (twice) {
                  done = true;
                  waiting.delete(url);
                  return say(`Signed in to ${hostOf(page.url())} with Google${account ? ` (${account})` : ''}. The tab is open on ${where(page.url())}.`);
                }
              }
            }
          }
          if (job) { /* Google path: wait for them below */ } else if (!(await visible(page, PASSWORD)) && !(await visible(page, OTP)) && !isSignInPage(start, url)) {
            // Some sites ask for the email first and only then show the password box. If neither
            // is on screen and this isn't a sign-in page, they're already in or it's the wrong page.
            return say(`No sign-in form on ${hostOf(start)}, so they're probably already signed in (or this isn't the sign-in page). Check the page, or call again with the site's sign-in URL. The tab is left open.`);
          }
          if (!job) {
            job = { id: await targetIdOf(page), start, since: Date.now(), pm: await tryPasswordManager(page) };
            waiting.set(url, job);
          }
          if (job.pm === 'submitted') {
            // Until the page leaves (a new address, or the password box goes), at most 2.5 s, then loaded.
            await firstOf(2500, page.waitForURL((u) => u.href !== start, { timeout: 2500 }),
              page.waitForFunction(() => ![...document.querySelectorAll('input[type=password]')].some((e) => e.getClientRects().length), null, { timeout: 2500 }));
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            // Twice, two seconds apart: a page between steps can look finished for a moment.
            let twice = await signedIn(page, start, url);
            if (twice) { await page.waitForTimeout(2000); twice = await signedIn(page, start, url); }
            if (twice) {
              done = true;
              waiting.delete(url);
              return say(`Signed in to ${hostOf(page.url())} with the password Chrome had saved. The tab is open on ${where(page.url())}.`);
            }
          }
        }

        // Called again for a Google step that was theirs: they named the account, or said yes to the
        // access Google asked for. Carry on from Google's page (the popup, or this tab).
        let front = job.front ? await pageById(b, job.front).catch(() => null) : null;
        if (!fresh && job.pm === 'google' && (account || approved_access)) {
          const g0 = front || page;
          if (onGoogle(g0.url())) {
            const g = await walkGoogle(g0, { popup: !!front && job.front !== job.id, account, approved: approved_access });
            if (g.result === 'theirs') job.why = g.why;
            else {
              await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
              let twice = await signedIn(page, job.start, url);
              if (twice) { await page.waitForTimeout(2000); twice = await signedIn(page, job.start, url); }
              if (twice) {
                done = true;
                waiting.delete(url);
                return say(`Signed in to ${hostOf(page.url())} with Google${account ? ` (${account})` : ''}. The tab is open on ${where(page.url())}.`);
              }
              job.pm = 'google-back';
            }
          }
        }

        // wait_minutes is for all calls together: the clock runs from the first one. Only a call after
        // this one gave up (they were told, and still want it) starts a new wait on the same tab.
        if (job.gaveUp) { job.since = Date.now(); job.gaveUp = false; }
        if (await signedIn(page, job.start, url)) {
          await page.waitForTimeout(2000);
          if (await signedIn(page, job.start, url)) {
            done = true;
            waiting.delete(url);
            return say(`Signed in to ${hostOf(page.url())}. The tab is open on ${where(page.url())}.`);
          }
        }
        if (AWAY()) {
          // Nobody is at the computer: don't put the window on screen for no one.
          return say(`Not signed in to ${hostOf(job.start)}: ${job.pm === 'not-saved' ? 'Chrome has no saved password for it' : job.pm === 'theirs' ? 'that form is theirs to submit' : job.pm === 'google' ? job.why : 'it needs them (maybe 2FA)'}, and nobody is at the computer right now (a scheduled job or a phone session). Stop here and tell them to sign in to ${hostOf(job.start)} in the Stead window when they're back.`);
        }

        // Hand it to the person: window on screen, wait until they're through.
        const host = hostOf(job.start);
        const total = Math.max(Number(wait_minutes) || 5, 0.05) * 60000;
        // show() raises the window on whatever tab it had: put the sign-in tab in front after it.
        if (Date.now() < job.since + total) shown = (await show(dir, { port }).catch(() => ({ moved: 0 }))).moved > 0;
        await (front && !front.isClosed() ? front : page).bringToFront().catch(() => {});
        const until = Math.min(t0 + CALL_BUDGET_MS, job.since + total);
        let streak = 0;
        while (Date.now() < until) {
          await new Promise((r) => setTimeout(r, 2000));
          if (page.isClosed()) { waiting.delete(url); return say('They closed the sign-in tab before finishing.'); }
          streak = (await signedIn(page, job.start, url)) ? streak + 1 : 0;
          if (streak >= 2) {
            done = true;
            waiting.delete(url);
            return say(`Signed in to ${host}. Chrome remembers it, so this shouldn't be needed again for a while. The tab is open on ${where(page.url())}.`);
          }
        }
        const why = job.pm === 'not-saved'
          ? 'Chrome had no saved password for it, so they need to type it themselves'
          : job.pm === 'theirs'
            ? 'the form\'s button isn\'t a plain sign-in (it may confirm something else), so they need to press it themselves'
            : job.pm === 'google'
              ? job.why
              : 'they haven\'t finished (maybe a 2FA step)';
        const mins = Math.round((Date.now() - job.since) / 6000) / 10;
        if (Date.now() >= job.since + total) {
          job.gaveUp = true;
          return say(`Not signed in to ${host} after ${mins} min, the wait_minutes limit: ${why}. Stopped waiting; the sign-in page is still open. Tell them; if they still want it, call browser_login again with the same url and it waits again on the same tab.`);
        }
        return say(`Not signed in to ${host} yet after ${mins} min: ${why}. The window is still on screen on the sign-in page. Tell them, then call browser_login again with the same url to keep waiting; it picks up the same tab.`);
      } finally {
        if (shown && done) await hide(dir, { port }).catch(() => {});
        await b.close().catch(() => {});
      }
    },
  }, handoffTool({ port, dir, ensureChrome, callBrowser })];
}
