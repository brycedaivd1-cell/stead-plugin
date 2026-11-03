// does: List their Google Classroom work as "title | class | due" lines, grouped the way Classroom groups it (this week, next week, later, no due date). Open https://classroom.google.com/a/not-turned-in/all first (missing work: /a/missing/all, done: /a/turned-in/all).
// args: {max: 60}
// site: classroom.google.com
async ({ max = 60 } = {}) => {
  // Reads work items by their links (/c/<class>/a/<item>/details), not Classroom's class names, and
  // falls back to the page's words when that finds nothing. Written against the signed-out page
  // and Classroom's URLs; not yet run on a signed-in account, so check the first result.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  if (/accounts\.google\.com/.test(location.host)) return 'Classroom wants them signed in: call browser_login with https://classroom.google.com, then run classroom-due again.';
  if (location.host !== 'classroom.google.com') return 'Open https://classroom.google.com/a/not-turned-in/all first.';
  const main = () => document.querySelector('[role=main]') || document.body;
  const isItem = (el) => el.tagName === 'A' && /\/c\/[^/]+\/(a|sa|q|mc|m)\/[^/]+/.test(el.getAttribute('href') || '');
  const items = () => [...main().querySelectorAll('a[href]')].filter(isItem);
  for (let t = 0; t < 32 && !items().length; t++) await sleep(250);
  if (!items().length && /Sign in|Go to Classroom/i.test(main().innerText) && !document.querySelector('a[href*="/c/"]')) return 'Not signed in to Classroom: call browser_login with https://classroom.google.com, then run classroom-due again.';
  // Classroom folds "Next week" and "Later" shut; open them so their work is on the page.
  for (const b of [...main().querySelectorAll('[aria-expanded=false]')].filter((x) => x.offsetParent).slice(0, 6)) { b.click(); await sleep(400); }
  const seen = new Set();
  const out = [];
  // Headings and items in page order: each item belongs to the last heading above it ("This week"...).
  for (const el of main().querySelectorAll('h1, h2, h3, [role=heading], a[href]')) {
    if (!isItem(el)) {
      if (el.tagName !== 'A' && !el.closest('a') && el.offsetParent) out.push(`## ${clip(el.innerText, 40)}`);
      continue;
    }
    const href = el.href.split('?')[0];
    if (seen.has(href)) continue;
    seen.add(href);
    const lines = el.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
    out.push(`- ${lines.map((l) => clip(l, 60)).join(' | ') || clip(el.getAttribute('aria-label'), 120)} → ${href}`);
    if (seen.size >= max) { out.push('…more on the page (call with a bigger max)'); break; }
  }
  if (!seen.size) {
    const words = clip(main().innerText, 1500);
    return /No work|all caught up|Woohoo/i.test(words) ? `Nothing to do here. The page says: ${clip(words, 200)}` : `No work items found by link. The page says:\n${words}`;
  }
  // Drop headings with nothing under them.
  const shown = out.filter((l, i) => !l.startsWith('## ') || (out[i + 1] && !out[i + 1].startsWith('## ')));
  const where = location.pathname;
  const kind = where.includes('/missing') ? 'Missing' : where.includes('/turned-in') ? 'Turned in' : 'Assigned';
  return `${kind} work (${seen.size}):\n${shown.join('\n')}`;
}
