// does: Move every email matching a Gmail search to Trash (recoverable for 30 days), 50 at a time. Ask the person first.
// args: {query: "in:inbox from:(producthunt.com OR redditmail.com)"}
// site: mail.google.com
async ({ query } = {}) => {
  if (!query) return 'Pass a Gmail search query.';
  if (!location.host.includes('mail.google.com')) return 'Open https://mail.google.com first.';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const started = Date.now();
  // Gmail ignores a bare .click() on its toolbar; it listens for the full mouse sequence.
  const press = (el) => ['mousedown', 'mouseup', 'click'].forEach((t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, view: window })));
  const main = () => document.querySelector('[role=main]');
  const sample = () => (main()?.innerText || document.body.innerText).replace(/\s+/g, ' ').slice(0, 300);
  const rows = () => [...document.querySelectorAll('tr.zA')].filter((x) => x.offsetParent);
  const picked = (r) => r.classList.contains('x7') || !!r.querySelector('[role=checkbox][aria-checked=true]');
  const empty = () => /No messages matched|no messages match/i.test(main()?.innerText || '');
  const want = '#search/' + encodeURIComponent(query).replace(/%20/g, '+');
  // Gmail keeps the previous list (usually the inbox) on screen until the search results render.
  // Selecting then would trash emails nobody approved, so the rows only count once they are new
  // ones drawn after the search was asked for. Even when the address already shows the search (a
  // retry after a slow load), what's on screen may still be the inbox: step away and back, and
  // apply the same rule, every time.
  if (location.hash === want) {
    location.hash = '#inbox';
    await sleep(1500);
  }
  const before = new Set(rows());
  location.hash = want;
  const box = () => document.querySelector('input[name=q]')?.value?.trim();
  let ready = false;
  for (let t = 0; t < 60 && !ready; t++) {
    await sleep(250);
    const now = rows();
    ready = location.hash === want && (!box() || box() === query.trim()) && (empty() || (now.length > 0 && !now.some((r) => before.has(r))));
  }
  if (!ready) return { trashed: 0, error: 'the search did not load within 15 seconds, so nothing was touched: call again', sample: sample() };
  let trashed = 0;
  while (rows().length && Date.now() - started < 24000) {
    if (!rows().some(picked)) {
      const all = document.querySelector('[gh=tm] [role=checkbox]');
      if (!all) return { trashed, error: "couldn't find Gmail's select-all box", sample: sample() };
      press(all);
      await sleep(600);
    }
    const chosen = rows().filter(picked);
    if (!chosen.length) return { trashed, error: 'could not select messages', sample: sample() };
    // act=10 is Gmail's Delete action in any language; the English label is the fallback.
    const del = document.querySelector('[gh=tm] [act="10"]') || document.querySelector('[gh=tm] [aria-label="Delete"], [gh=tm] [data-tooltip="Delete"]');
    if (!del) return { trashed, error: "couldn't find Gmail's Delete button", sample: sample() };
    press(del);
    // Count what actually left the list, not what was selected.
    let gone = 0;
    for (let t = 0; t < 20; t++) {
      await sleep(250);
      gone = chosen.filter((r) => !r.isConnected || !r.offsetParent).length;
      if (gone === chosen.length) break;
    }
    if (!gone) return { trashed, error: 'pressed Delete but the emails are still listed', sample: sample() };
    trashed += gone;
    await sleep(800);
  }
  const left = rows().length;
  return { trashed, left, note: left ? 'more remain: call again' : 'search is now empty' };
}
