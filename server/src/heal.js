// Click/type rescue, shared by `serve --heal` (line proxy) and `stead all` (combined server).
// Playwright's error says WHY an action failed; each reason gets the fix that works on real sites.
//
// Every rescue runs inside the browser child (browser_run_code_unsafe: hidden from Claude, callable
// here), so it acts on the exact tab Claude is working in. The old second CDP connection had to
// guess the tab and clicked in the wrong one, and just being connected it cancelled every confirm()
// and sent downloads to a temp folder.
//
// A rescue first DECIDES (no side effects), then acts. When it would press something other than what
// Claude named (a label, a wrapping control, the one visible match of an ambiguous selector), that
// control is judged by the same approval rules as a normal click: the gate in front of Stead only saw
// Claude's target, so a rescue must never be the way a "Place order" gets pressed unasked.
import { judge } from './approve.js';

const REASONS = [
  ['disabled', /element is not enabled|element is disabled/],
  ['readonly', /element is not editable|is readonly|is read-only/],
  ['covered', /intercepts pointer events/],
  ['hidden', /outside of the viewport|element is not visible|not visible/],
  ['unstable', /not stable/],
  ['timeout', /Timeout \d+ms exceeded/],
];
const diagnose = (err) => (REASONS.find(([, re]) => re.test(err)) || [null])[0];
// Playwright: "<div class=overlay>…</div> intercepts pointer events" or
// "<button>Accept all</button> from <div>…</div> subtree intercepts pointer events".
const interceptor = (err) => (err.match(/(<[^<>]{1,160}>(?:[^<>]{0,80}<\/\w+>)?)(?: from <[^<>]+>(?:[^<>]{0,80}<\/\w+>)? subtree)? intercepts pointer events/) || [])[1] || '';
const isRef = (t) => /^(f\d+)?e\d+$/.test(String(t));

// The click (or the Enter after typing) already reached the page; Playwright was only waiting for
// the next page to load. Doing it again is how a slow bank or checkout takes a second payment.
const WENT_THROUGH = /\b(click|dblclick) action done|waiting for scheduled navigations|locator\.press: Timeout|elementHandle\.press\("Enter"\)/;
// A rescue that already clicked and then lost the page: the click navigated, so it went through.
const NAVIGATED = /Execution context was destroyed|most likely because of a navigation|frame was detached|Target page, context or browser has been closed/;

// In the page: what a control is called, the way the approval rules read it, plus where it sits.
function DESCRIBE(e) {
  const tag = e.tagName.toLowerCase(), type = (e.getAttribute('type') || '').toLowerCase();
  const role = e.getAttribute('role') || ({ a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', label: 'label' })[tag]
    || (tag === 'input' ? (['submit', 'button', 'reset', 'image'].includes(type) ? 'button' : ['checkbox', 'radio'].includes(type) ? type : 'textbox') : tag);
  const name = (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('title') || e.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return { role, name, url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 4000) };
}

// Decides the fix for the failing element, without doing anything (apart from scrolling it into
// view). Returns what it would do, the element it would press ("on"), and a description of it.
function PLAN(el, reason) {
  const vis = (n) => { if (!n) return false; const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05; };
  const CONTROL = 'button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=menuitem], [role=tab], [role=option], [onclick]';
  const DESCRIBE = __DESCRIBE__;
  const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
  const plan = (did, on, note) => ({ did, on, note, other: !!on && on !== el, onDesc: on ? DESCRIBE(on) : null });
  if (tag === 'input' && type === 'file') return { did: 'file-input', note: 'This is a file upload. Use browser_file_upload with the file path.' };
  // Styled checkbox/radio/select: the real input is hidden and its label is the visible control.
  const label = (el.labels && [...el.labels].find(vis)) || el.closest('label');
  if (!vis(el) && label && vis(label)) return plan('mouse', label, 'clicked its visible label');
  if (!vis(el)) {
    // Editors that route keystrokes through a hidden box (Google Docs, some rich text fields):
    // focusing it is what a click would have done.
    if (el.isContentEditable || tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'button', 'submit'].includes(type))) return plan('focus', null, 'focused the hidden text box');
    // A visible wrapper only counts if it is itself a control: the middle of a plain toolbar div can
    // be a different button ("Delete" next to a hover-only "Archive").
    const shown = [el.parentElement, el.parentElement?.parentElement].find((n) => vis(n) && n.matches(CONTROL));
    if (shown) return plan('mouse', shown, 'clicked the visible control wrapping it');
    return plan('dispatch', null, 'sent the click directly');
  }
  // Covered: a real control (button, link, field) gets the click sent straight to it, since a mouse
  // click would land on whatever sits on top. A plain area (a canvas page like Google Docs) is the
  // opposite: the thing on top IS the real surface, so a real mouse click is right, unless what's on
  // top is itself a control (a cookie banner's "Accept all"): then nothing is clicked.
  if ((reason === 'covered' || reason === 'timeout') && !el.matches(CONTROL)) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (hit && hit !== el && !el.contains(hit) && (hit.closest(CONTROL) || hit.closest('[role=dialog], [role=alertdialog], dialog'))) {
      return { did: 'blocked', note: 'something else is on top of it', blockerDesc: DESCRIBE(hit.closest(CONTROL) || hit) };
    }
    return plan('mouse', el, 'real mouse click at its center');
  }
  return plan('dispatch', null, 'sent the click directly');
}

// The rescue as Playwright code for the child. act=false only plans; act=true plans again (the
// page may have moved) and does it. Everything Claude passed goes in as JSON data, never as code.
const rescueCode = (sel, reason, typing, text, submit, act) => `async (page) => {
  const [sel, reason, typing, text, submit, act] = ${JSON.stringify([sel, reason, typing, String(text ?? ''), !!submit, !!act])};
  const PLAN = ${String(PLAN).replace('__DESCRIBE__', String(DESCRIBE))};
  const el = await page.locator(sel).elementHandle({ timeout: 2000 });
  const plan = await el.evaluateHandle(PLAN, reason);
  const out = await plan.evaluate((p) => ({ did: p.did, note: p.note, other: p.other, onDesc: p.onDesc, blockerDesc: p.blockerDesc }));
  if (!act || out.did === 'file-input' || out.did === 'blocked') return out;
  try {
    if (out.did === 'mouse') {
      const on = (await plan.getProperty('on')).asElement();
      await on.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      // Smooth-scrolling pages keep moving it for a few hundred ms: aim once it has stopped.
      let box = null;
      for (let i = 0; i < 12; i++) {
        const b = await on.boundingBox();
        if (b && box && b.x === box.x && b.y === box.y) break;
        box = b; await page.waitForTimeout(50);
      }
      if (!box) return { did: 'nobox' };
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else if (out.did === 'focus') await el.evaluate((e) => e.focus());
    else if (out.did === 'dispatch') await el.evaluate((e) => { e.focus(); e.click(); });
  } catch (e) {
    // The click happened and the page went away (it navigated): that's done, not failed.
    if (/Execution context was destroyed|navigation|detached/i.test(String(e.message || e))) return { ...out, navigated: true };
    throw e;
  }
  if (!typing) return out;
  try {
    if (out.did === 'mouse') await page.waitForTimeout(150);
    // End up where a normal browser_type would: the field holds exactly this text. Editors that
    // take keystrokes (Docs, rich text) get typed into at the caret instead. Line breaks go in as
    // text, never as Enter presses (Enter sends a message in a chat box; only submit presses it).
    const kind = await el.evaluate((e) => e.isContentEditable ? 'editor' : !/^(input|textarea)$/i.test(e.tagName) ? 'editor'
      : e.getBoundingClientRect().width > 2 ? 'field' : 'hidden-field');
    let filled = false;
    if (kind === 'field') filled = await el.fill(text, { force: true, timeout: 2000 }).then(() => true, () => false);
    if (!filled) {
      if (kind !== 'editor') await el.evaluate((e) => { e.focus(); if (e.value) try { e.select(); } catch {} });
      if (/[\\r\\n]/.test(text)) await page.keyboard.insertText(text); else await page.keyboard.type(text);
    }
    // Check it landed: a read-only or masked field can swallow everything without an error.
    const now = await el.evaluate((e) => ('value' in e && typeof e.value === 'string' ? e.value : e.innerText || e.textContent || ''));
    const want = text.replace(/\\s+/g, ' ').trim().slice(0, 40);
    if (want && !String(now).replace(/\\s+/g, ' ').includes(want)) return { ...out, typeFailed: 'the text did not end up in the field (it may be read-only or need a picker)' };
    if (submit) await page.keyboard.press('Enter');
  } catch (e) {
    if (/Execution context was destroyed|navigation|detached/i.test(String(e.message || e)) && submit) return { ...out, navigated: true };
    return { ...out, typeFailed: String(e.message || e).split('\\n')[0].slice(0, 200) };
  }
  return out;
}`;

// Visible matches of an ambiguous selector, described well enough for Claude to pick the right one.
const CANDIDATES = (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== 'hidden'; })
  .slice(0, 8).map((e) => {
    const own = (e.innerText || e.value || e.getAttribute('aria-label') || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 60);
    const row = e.closest('tr, li, [role=row], [role=listitem], article, fieldset, form');
    const ctx = row && row !== e ? row.innerText.replace(/\s+/g, ' ').trim().slice(0, 90) : '';
    return ctx ? `"${own}" (in: ${ctx})` : `"${own}"`;
  });

// The one on-page control an ambiguous selector matches, described (not clicked), or how many there were.
const ONLY_CONTROL = (sel) => `async (page) => {
  const DESCRIBE = ${DESCRIBE};
  const loc = page.locator(${JSON.stringify(sel)});
  const n = await loc.count(), good = [];
  for (let i = 0; i < n && i < 30; i++) {
    const hit = await loc.nth(i).evaluate((e) => {
      const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      const onPage = r.width > 2 && r.height > 2 && r.right > 0 && r.bottom > 0 && r.left < Math.max(innerWidth, document.documentElement.scrollWidth) && s.visibility !== 'hidden' && s.display !== 'none';
      return onPage && e.matches('button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=radio], [onclick]');
    }).catch(() => false);
    if (hit) good.push(i);
  }
  if (good.length !== 1) return { n: good.length };
  return { index: good[0], desc: await loc.nth(good[0]).evaluate(DESCRIBE) };
}`;

export function createHealer({ ask, record = () => {}, log = () => {} }) {
  const text = (result) => (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const ok = (msg) => ({ content: [{ type: 'text', text: msg }] });
  const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
  // run_code puts the snippet's return value, JSON-encoded, on the line after "### Result".
  const resultOf = (r) => { try { return JSON.parse((text(r).match(/### Result\n(.*)/) || [])[1]); } catch { return null; } };
  const run = (code) => ask('browser_run_code_unsafe', { code });
  // A control the rescue would press instead of Claude's target, as the approval rules see it.
  const gated = (desc) => (desc ? judge(desc) : null);
  const askFirst = (v, how) => fail(`Stead didn't do that: ${how} "${v.name}", which would ${v.what}${v.why ? ` (${v.why})` : ''}. Ask them first, then click it by its ref from a fresh snapshot with confirmed: true.`);

  const wentThrough = async (name) => {
    await ask('browser_wait_for', { time: 3 }).catch(() => {});
    record({ tool: name, reason: 'slow-nav', outcome: 'went-through' });
    return ok(name === 'browser_type'
      ? 'Typed it and pressed Enter; the site is still loading the next page. Take a snapshot before doing anything else, and do NOT type or submit it again.'
      : 'The click went through; the site is still loading the next page. Take a snapshot before doing anything else, and do NOT click it again.');
  };

  return async function heal(name, args, result) {
    if (name !== 'browser_click' && name !== 'browser_type') return null;
    const err = text(result);
    const key = args && ('target' in args ? 'target' : 'ref' in args ? 'ref' : null);
    if (!key) return null;
    if (WENT_THROUGH.test(err)) return wentThrough(name);
    // A rescue is a plain left click. A right or middle click, a modifier or a double-click would
    // turn into a different action (a middle-click "open in new tab" on Unsubscribe would unsubscribe).
    if (name === 'browser_click' && ((args.button && args.button !== 'left') || args.modifiers?.length || args.doubleClick)) return null;

    // A selector matched several elements. text=Male also matches "Female", so try the exact text,
    // then the only visible match (the same name often sits in a hidden toast too). Never "the first
    // one": with several visible matches nobody knows which row Claude meant, and guessing is how
    // the wrong item gets deleted. Whatever is narrowed to is judged before it's pressed.
    if (/strict mode violation/.test(err) && !isRef(args[key])) {
      const sel = String(args[key]);
      const loose = sel.match(/^text=(?!")(.+)$/);
      const exact = loose ? `text="${loose[1].replace(/"/g, '\\"')}"` : null;
      const tries = [...new Set([exact, `${exact || sel} >> visible=true`, `${sel} >> visible=true`].filter(Boolean))];
      for (const t of tries) {
        const d = await run(`async (page) => { const l = page.locator(${JSON.stringify(t)}); if (await l.count() !== 1) return null; return l.evaluate(${DESCRIBE}); }`).catch(() => null);
        const desc = d && !d.isError ? resultOf(d) : null;
        if (!desc) continue;
        const v = gated(desc);
        if (v) { record({ tool: name, reason: 'ambiguous', outcome: 'gated' }); return askFirst(v, `${sel} matched several elements, and the only one it could mean is`); }
        const r = await ask(name, { ...args, [key]: t });
        if (r?.isError && WENT_THROUGH.test(text(r))) return wentThrough(name);
        if (!r?.isError) {
          record({ tool: name, reason: 'ambiguous', outcome: t.endsWith('visible=true') ? 'only-visible' : 'exact' });
          return { ...r, content: [{ type: 'text', text: `${sel} matched several elements, so Stead used ${t}, which matched exactly one.` }, ...(r.content || [])] };
        }
      }
      // Pages park copies of a label off to the side (screen-reader text at left:-9999px) that count
      // as "visible". If exactly one match is both on the page and something you can click, it's that one.
      if (name === 'browser_click') {
        const one = await run(ONLY_CONTROL(sel)).catch(() => null);
        const found = one && !one.isError ? resultOf(one) : null;
        if (found?.desc) {
          const v = gated(found.desc);
          if (v) { record({ tool: name, reason: 'ambiguous', outcome: 'gated' }); return askFirst(v, `${sel} matched several elements, and the only control among them is`); }
          const c = await run(`async (page) => { await page.locator(${JSON.stringify(sel)}).nth(${found.index}).click({ timeout: 2500 }); return { clicked: true }; }`).catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] }));
          if (c?.isError && (WENT_THROUGH.test(text(c)) || NAVIGATED.test(text(c)))) return wentThrough(name);
          if (c && !c.isError && resultOf(c)?.clicked) {
            record({ tool: name, reason: 'ambiguous', outcome: 'only-clickable' });
            return ok(`${sel} matched several elements; only one was a control on the page ("${found.desc.name}"), and Stead clicked it.`);
          }
        }
      }
      const c = await run(`async (page) => page.locator(${JSON.stringify(sel)}).evaluateAll(${CANDIDATES})`).catch(() => null);
      const list = c && !c.isError ? resultOf(c) : null;
      record({ tool: name, reason: 'ambiguous', outcome: list?.length ? 'listed' : 'failed' });
      if (!list?.length) return null;
      return fail(`${sel} matches ${list.length} visible elements, so Stead did not guess which one: ${list.join('; ')}. Take a snapshot and use the ref of the one you mean.`);
    }

    const reason = diagnose(err);
    if (!reason) return null;

    if (reason === 'disabled') {
      record({ tool: name, reason, outcome: 'explained' });
      return fail('That control is disabled. Usually a required field above it is still empty or invalid: snapshot the page and look for an error message or an unfilled required field.');
    }
    if (reason === 'readonly') {
      record({ tool: name, reason, outcome: 'explained' });
      return fail('That field can\'t be typed into (it is read-only). It is usually filled by a picker next to it (a calendar, a dropdown): click that instead.');
    }
    if (reason === 'unstable') await new Promise((r) => setTimeout(r, 400));

    const sel = isRef(args[key]) ? `aria-ref=${args[key]}` : String(args[key]);
    const typing = name === 'browser_type';
    // Decide first. If the rescue would press something else, that something is judged now.
    const p = await run(rescueCode(sel, reason, typing, args.text, args.submit, false));
    const plan = p && !p.isError ? resultOf(p) : null;
    if (plan?.did === 'blocked') {
      record({ tool: name, reason, outcome: 'blocked' });
      const b = plan.blockerDesc;
      return fail(`Stead didn't click: something is on top of it${b?.name ? `: "${b.name}" (${b.role})` : ''}. If that's a cookie banner or popup, deal with it first (take a snapshot), then try again.`);
    }
    if (plan?.other) {
      const v = gated(plan.onDesc);
      if (v) { record({ tool: name, reason, outcome: 'gated' }); return askFirst(v, 'the control it would press instead is'); }
    }
    const r = await run(rescueCode(sel, reason, typing, args.text, args.submit, true));
    if (r?.isError && (WENT_THROUGH.test(text(r)) || (plan && NAVIGATED.test(text(r))))) return wentThrough(name);
    const out = r && !r.isError ? resultOf(r) : null;
    if (out?.navigated) return wentThrough(name);
    if (!out) {
      // A dialog opened mid-rescue: the click landed, and Claude has to answer the dialog next.
      const modal = (text(r).match(/### Modal state\n([\s\S]*?)(?:\n### |$)/) || [])[1];
      if (modal && !r?.isError) {
        record({ tool: name, reason, outcome: 'dialog' });
        return ok(`${typing ? 'Typed' : 'Clicked'}: Playwright couldn't (${reason}), so Stead did it directly, and a dialog opened:\n${modal.trim()}`);
      }
      // Nothing was done, so Claude gets the original error rather than a success that didn't happen.
      record({ tool: name, reason, outcome: 'rescue-failed' });
      log(`self-heal ${name} (${reason}) failed: ${text(r).split('\n').find((l) => l && !l.startsWith('###')) || 'no result'}`);
      return null;
    }
    if (out.did === 'file-input') {
      record({ tool: name, reason, outcome: 'file-input' });
      return fail(out.note);
    }
    if (out.did === 'nobox') { record({ tool: name, reason, outcome: 'nobox' }); return null; }
    const blocker = reason === 'covered' ? interceptor(err) : '';
    record({ tool: name, reason, outcome: out.did, blocker });
    log(`self-heal ${name} (${reason}): ${out.note}`);
    if (out.typeFailed) {
      return fail(`Playwright couldn't type there (${reason}). Stead ${out.note}, but typing then failed: ${out.typeFailed}. Take a snapshot before trying again.`);
    }
    return ok(`${typing ? 'Typed' : 'Clicked'}: Playwright couldn't (${reason}), so Stead ${out.note}${typing ? ' and typed the text' : ''}.` +
      (blocker ? ` Something was covering it: ${blocker}. If that's a popup or banner, close it.` : '') +
      ' Take a snapshot to confirm it worked.');
  };
}
