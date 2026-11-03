// does: Find links on the current page by words, including ones hidden inside closed menus and dropdowns, and return their real URLs, so you can browser_navigate straight there instead of clicking through menus. No words = the site's main menu.
// args: {find: "grades | settings | download pdf (words; omit for the menu)", limit: 20}
// site: any
async ({ find = '', limit = 20 } = {}) => {
  const words = String(find).toLowerCase().split(/\s+/).filter(Boolean);
  const clip = (s, n = 70) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const region = (a) => (a.closest('nav, [role=navigation], header') ? 'menu' : a.closest('footer') ? 'footer' : a.closest('aside') ? 'sidebar' : 'page');
  const seen = new Set();
  const rows = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!href || href.startsWith('javascript:') || seen.has(href)) continue;
    const text = clip(a.innerText || a.getAttribute('aria-label') || a.title || a.querySelector('img')?.alt || '', 60);
    const hay = `${text} ${href} ${a.getAttribute('aria-label') || ''}`.toLowerCase();
    const r = a.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0;
    let score = 0;
    if (words.length) {
      for (const w of words) { if (text.toLowerCase().includes(w)) score += 3; else if (hay.includes(w)) score += 1; else { score = -1; break; } }
      if (score < 0) continue;
    } else if (region(a) !== 'menu') continue;
    seen.add(href);
    const file = /\.(pdf|docx?|xlsx?|pptx?|zip|csv)(\?|#|$)/i.exec(href)?.[1];
    rows.push({ score, line: `${text || '(no text)'} → ${href}${file ? ` [${file.toUpperCase()} file: toolbox_run browser-save]` : ''}${visible ? '' : ' (hidden in a menu)'} · ${region(a)}${a.target === '_blank' ? ' · opens new tab' : ''}` });
  }
  rows.sort((x, y) => y.score - x.score);
  if (!rows.length) return words.length ? `No link matching "${find}" among ${document.querySelectorAll('a[href]').length} links. It may be a button, not a link: try page-map or browser_find.` : 'No menu links found; try with words.';
  return rows.slice(0, limit).map((r) => r.line).join('\n') + (rows.length > limit ? `\n…${rows.length - limit} more` : '');
}
