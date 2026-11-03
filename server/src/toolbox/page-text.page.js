// does: Read the page (or an open dialog) as compact text: far cheaper than a screenshot or full snapshot
// args: {selector?: "css", max?: 4000}
// site: any
async ({ selector, max = 4000 } = {}) => {
  // Not offsetParent: it's null for a position:fixed dialog, which is how most modals are drawn.
  const shown = (d) => { const r = d.getBoundingClientRect(), cs = getComputedStyle(d); return r.width * r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const open = [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].filter(shown).pop();
  const el = (selector && document.querySelector(selector)) || open || document.querySelector('main,[role=main]') || document.body;
  return el.innerText.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, max);
}
