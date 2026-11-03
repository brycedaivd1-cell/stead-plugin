// "Sign in with Google" for browser_login: press the site's Google button, pick their account in
// Google's chooser, and press Continue on Google's plain sign-in screen. Everything else on
// Google's side is the person's: a password, a 2FA step, a choice between accounts we weren't told,
// and any screen that asks for MORE than their name and email (Gmail, Drive, contacts...). Granting
// a site access to their data is their decision: that screen is pressed only after they said yes in
// chat to exactly what it asks for (approved: true), and its text goes back to Claude to show them.
// Nothing here reads or types a password, and the Stead profile must already be signed in to
// Google for the quiet path to work; if it isn't, Google asks for the password and they type it.

// Google's sign-in host. Tests point it at a local page.
const googleHost = () => process.env.STEAD_TEST_GOOGLE_HOST || 'accounts.google.com';
export const onGoogle = (u) => { try { return new URL(u).host === googleHost(); } catch { return false; } };

// What a Google button says: "Sign in with Google", "Continue with Google", "Log in using Google",
// or just "Google" in a row of provider buttons. Never "Google Play", "Google Drive", "Google Docs".
export const GOOGLE_LABEL = /^(?:(?:sign|log) ?(?:in|up|on)|login|continue|connect|register)\s+(?:with|using|via|through)\s+google(?:\s+account)?$|^google$/i;
// Google's own pages: the account chooser and the sign-in consent. A screen with any of these is
// asking for more than sign-in, so it is the person's.
const MORE_ACCESS = /wants (?:additional )?access to your google account|select what .{1,60} can access|see, edit|view and manage|read, compose|manage your|see your (?:contacts|calendar|email|google drive)|access your (?:contacts|calendar|gmail|drive)/i;
const PASSWORD_OR_CODE = 'input[type="password"], input[type="tel"], input[autocomplete="one-time-code"], input[name="totpPin"], input[name="Passwd"]';

const label = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// A real click, or a DOM click when the window can't render one (hidden on a locked screen).
const press = (el) => el.click({ timeout: 4000 }).catch(() => el.evaluate((n) => n.click())).catch(() => {});

// The site's Google button, visible only. Best first: Google's own button frame (gsi/button), then
// "Sign in with Google" wording, then a button that just says "Google". A link that just says
// "Google" is never it (menus are full of them).
export async function findGoogleButton(page) {
  let best = null, bestScore = 0;
  for (const f of page.frames()) {
    const gsi = /\/gsi\/button/.test(f.url());
    let els = [];
    try { els = await f.$$('button, a, [role=button], div[tabindex], input[type=submit], input[type=button]'); } catch { continue; }
    for (const el of els) {
      try {
        if (!(await el.isVisible())) continue;
        const [name, tag] = await el.evaluate((n) => [n.getAttribute('aria-label') || n.innerText || n.value || n.title || '', n.tagName]);
        const t = label(name);
        const score = gsi && /google/i.test(t) ? 3 : GOOGLE_LABEL.test(t) && !/^google$/i.test(t) ? 2 : /^google$/i.test(t) && tag !== 'A' ? 1 : 0;
        if (score > bestScore) { best = el; bestScore = score; }
        if (score === 3) return el;
      } catch { /* detached */ }
    }
  }
  return best;
}

// One step on a Google page. Returns 'clicked' (moved it along), 'wait' (loading), or
// { theirs: why } (the person has to do this one).
async function googleStep(page, account, approved) {
  if (page.isClosed()) return 'wait';
  for (const el of await page.$$(PASSWORD_OR_CODE).catch(() => [])) {
    if (await el.isVisible().catch(() => false)) return { theirs: 'Google is asking for their password or a code' };
  }
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (MORE_ACCESS.test(text) || (await page.$$('input[type=checkbox]').catch(() => [])).length) {
    if (approved) {
      // "Select all" (or each box) then Continue/Allow: what they agreed to is the whole screen.
      for (const box of await page.$$('input[type=checkbox]').catch(() => [])) {
        if (await box.isVisible().catch(() => false) && !(await box.isChecked().catch(() => true))) await box.check().catch(() => {});
      }
      const go = page.getByRole('button', { name: /^(continue|allow)$/i });
      if (await go.first().isVisible().catch(() => false)) { await press(go.first()); return 'clicked'; }
      return 'wait';
    }
    const asks = text.split('\n').map(label).filter((l) => l && l.length < 200 && /access|see|edit|manage|view|read|delete|create|contacts|calendar|drive|gmail|email/i.test(l)).slice(0, 8);
    return { theirs: `Google is asking them to give the site more than their name and email: "${asks.join(' / ')}". Show them exactly that and ask; only if they say yes, call browser_login again with the same url and approved_access true` };
  }
  // The account chooser: one row per signed-in account, each carrying its address.
  const rows = [];
  for (const el of await page.$$('[data-identifier], [data-email]').catch(() => [])) {
    if (!(await el.isVisible().catch(() => false))) continue;
    const id = await el.evaluate((n) => n.getAttribute('data-identifier') || n.getAttribute('data-email')).catch(() => '');
    if (id && id.includes('@')) rows.push({ el, id: id.toLowerCase() });
  }
  if (rows.length) {
    const want = String(account || '').trim().toLowerCase();
    const pick = want ? rows.find((r) => r.id === want) : rows.length === 1 ? rows[0] : null;
    if (!pick) {
      return { theirs: want
        ? `${account} isn't one of the Google accounts signed in to this browser (${rows.map((r) => r.id).join(', ')})`
        : `there are ${rows.length} Google accounts here (${rows.map((r) => r.id).join(', ')}); call again with account set to the one they use for this site, or let them pick` };
    }
    await press(pick.el);
    return 'clicked';
  }
  // The plain sign-in screen: "Sign in to <site>" / "Google will share your name, email address...".
  const cont = page.getByRole('button', { name: /^continue$/i });
  if (await cont.first().isVisible().catch(() => false)) {
    await press(cont.first());
    return 'clicked';
  }
  return 'wait';
}

// Press the Google button and walk Google's pages until it hands back to the site, or until a step
// is theirs. Returns { result: 'back' } or { result: 'theirs', why, page } (the page to put in
// front of them) or { result: 'no-button' }.
export async function signInWithGoogle(page, { account, approved, ms = 25000 } = {}) {
  // Google's own button (an iframe) loads a moment after the page: look for up to 6 s.
  let btn = null;
  for (const end = Date.now() + 6000; !btn && Date.now() < end; ) {
    btn = await findGoogleButton(page);
    if (!btn) await new Promise((r) => setTimeout(r, 500));
  }
  if (!btn) return { result: 'no-button' };
  const ctx = page.context();
  const popupP = ctx.waitForEvent('page', { timeout: 4000 }).catch(() => null);
  await press(btn);
  // Google opens in a popup on some sites and in the same tab on others.
  const popup = await Promise.race([popupP, new Promise((r) => setTimeout(() => r(null), 4000))]);
  return walkGoogle(popup || page, { popup: !!popup, account, approved, ms });
}

// Carry on through Google's pages from where they are (g: the popup, or the site's own tab).
export async function walkGoogle(g, { popup, account, approved, ms = 25000 } = {}) {
  const end = Date.now() + ms;
  let clicks = 0;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 700));
    if (popup && g.isClosed()) return { result: 'back' };
    if (!onGoogle(g.url())) {
      if (!popup) return { result: 'back' };
      continue; // the popup is somewhere else between steps
    }
    await g.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    const step = await googleStep(g, account, approved);
    if (step === 'clicked' && ++clicks > 6) return { result: 'theirs', why: 'Google kept asking for more steps', page: g };
    if (step && step.theirs) return { result: 'theirs', why: step.theirs, page: g };
  }
  return onGoogle(g.url()) && !g.isClosed()
    ? { result: 'theirs', why: 'Google\'s sign-in didn\'t finish on its own', page: g }
    : { result: 'back' };
}
