// does: Map the current page in one cheap call: what it is, its sections, every form field (label, type, required, current value, options), buttons, open dialogs/popups, errors shown, and iframes. Use it to orient on a new page instead of screenshots or a full snapshot.
// args: {max_fields: 80}
// site: any
async ({ max_fields = 80 } = {}) => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const clip = (s, n = 60) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const labelOf = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').trim(); if (t) return t; }
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l.innerText; }
    const wrap = el.closest('label');
    if (wrap) return wrap.innerText;
    if (el.title) return el.title;
    // Google Forms / many frameworks: the question text sits in a nearby heading.
    const q = el.closest('[role=listitem], fieldset, .form-group, .field, [data-params]');
    const h = q?.querySelector('legend, [role=heading], h1, h2, h3, h4, label');
    if (h?.innerText) return h.innerText;
    // Label in a sibling column (Bootstrap rows): the nearest ancestor that holds a label wins.
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const l = [...p.querySelectorAll('label, .label, [class*=label i]')].find((x) => !x.contains(el) && x.innerText.trim());
      if (l) return el.placeholder && !l.innerText.includes(el.placeholder) ? `${l.innerText.trim()}: ${el.placeholder}` : l.innerText;
    }
    if (el.placeholder) return el.placeholder;
    // Last resort: the field's id or name in words (dateOfBirthInput -> date of birth).
    return (el.id || el.name || '').replace(/(Input|Field|Container)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase();
  };
  const out = [];
  out.push(`${document.title} — ${location.href}`);
  const dialogs = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]')].filter(vis);
  if (dialogs.length) out.push(`OPEN DIALOG${dialogs.length > 1 ? 'S' : ''} (deal with first): ${dialogs.map((d) => `"${clip(d.getAttribute('aria-label') || d.innerText, 140)}"`).join(' | ')}`);
  // Cookie banners and similar overlays that block clicks without being real dialogs.
  const overlay = [...document.querySelectorAll('[id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i]')].filter((e) => vis(e) && e.innerText.length > 30).slice(0, 1);
  if (overlay.length && !dialogs.length) out.push(`BANNER: "${clip(overlay[0].innerText, 120)}"`);
  const errors = [...document.querySelectorAll('[role=alert], [aria-invalid=true], .error, .errors, .invalid-feedback, .field-error, [class*=error-message i]')].filter(vis).map((e) => clip(e.innerText || (e.getAttribute('aria-invalid') && `invalid: ${labelOf(e)}`), 90)).filter(Boolean);
  if (errors.length) out.push(`ERRORS SHOWN: ${[...new Set(errors)].slice(0, 8).join(' | ')}`);

  const heads = [...document.querySelectorAll('h1, h2, h3, [role=heading]')].filter(vis).map((h) => `${'  '.repeat(Math.max(0, (Number(h.tagName[1]) || Number(h.getAttribute('aria-level')) || 2) - 1))}${clip(h.innerText, 70)}`).filter((s) => s.trim());
  if (heads.length) out.push('SECTIONS:', ...heads.slice(0, 25));
  const nav = [...document.querySelectorAll('nav, [role=navigation]')].filter(vis).map((n) => [...n.querySelectorAll('a')].filter(vis).map((a) => clip(a.innerText, 25)).filter(Boolean).slice(0, 12).join(' · ')).filter(Boolean);
  if (nav.length) out.push(`NAV: ${nav.slice(0, 3).join('  ||  ')}`);

  // Fields: native inputs plus ARIA widgets (custom dropdowns, checkboxes, radios).
  const seen = new Set();
  const fields = [];
  const radioGroups = {};
  for (const el of document.querySelectorAll('input, select, textarea, [role=combobox], [role=listbox], [role=checkbox], [role=radio], [role=switch], [role=textbox], [contenteditable=true]')) {
    if (seen.has(el) || ['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type)) continue;
    seen.add(el);
    // Styled checkboxes/radios hide the real input; judge visibility by its label then.
    const shown = vis(el) || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`) && vis(document.querySelector(`label[for="${CSS.escape(el.id)}"]`))) || (el.closest('label') && vis(el.closest('label')));
    if (!shown) continue;
    const role = el.getAttribute('role');
    const type = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : role || el.type || 'text';
    const label = clip(labelOf(el), 50);
    const req = el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(labelOf(el).trim());
    if (type === 'radio') {
      const g = el.name || el.closest('[role=radiogroup]')?.getAttribute('aria-label') || label;
      (radioGroups[g] ||= { req, opts: [], chosen: null }).opts.push(label);
      if (el.checked || el.getAttribute('aria-checked') === 'true') radioGroups[g].chosen = label;
      continue;
    }
    let val = '';
    if (type === 'password') val = el.value ? '(filled)' : '';
    else if (type === 'checkbox' || type === 'switch') val = (el.checked || el.getAttribute('aria-checked') === 'true') ? '☑' : '☐';
    else if (el.tagName === 'SELECT') val = `${clip(el.selectedOptions[0]?.text, 30)} [options: ${[...el.options].slice(0, 12).map((o) => clip(o.text, 20)).join(', ')}${el.options.length > 12 ? `, …${el.options.length} total` : ''}]`;
    else val = clip(el.value ?? el.innerText, 40);
    fields.push(`- ${label || '(no label)'} · ${type}${req ? ' · required' : ''}${el.disabled || el.getAttribute('aria-disabled') === 'true' ? ' · disabled' : ''}${val ? ` = ${val}` : ' = (empty)'}`);
  }
  for (const [g, r] of Object.entries(radioGroups)) fields.push(`- ${clip(g, 40)} · choose one${r.req ? ' · required' : ''} = ${r.chosen || '(none)'} [${r.opts.slice(0, 10).join(' / ')}]`);
  if (fields.length) out.push(`FIELDS (${fields.length}):`, ...fields.slice(0, max_fields), ...(fields.length > max_fields ? [`…${fields.length - max_fields} more`] : []));

  const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit], input[type=button], a.btn, a.button')].filter(vis)
    .map((b) => clip(b.innerText || b.value || b.getAttribute('aria-label') || b.title, 30) + (b.disabled || b.getAttribute('aria-disabled') === 'true' ? ' (disabled)' : '')).filter((s) => s.trim());
  if (buttons.length) out.push(`BUTTONS: ${[...new Set(buttons)].slice(0, 30).join(' · ')}`);
  const frames = [...document.querySelectorAll('iframe')].filter(vis).map((f) => { try { return `${f.contentDocument ? 'same-site' : 'other-site'} ${clip(f.title || f.src, 60)}`; } catch { return `other-site ${clip(f.src, 60)}`; } });
  if (frames.length) out.push(`IFRAMES (contents not included above): ${frames.slice(0, 5).join(' | ')}`);
  const links = document.querySelectorAll('a[href]').length;
  const scroll = Math.round((document.documentElement.scrollHeight / innerHeight) * 10) / 10;
  out.push(`${links} links (page-links finds any of them) · page is ${scroll} screens tall, scrolled ${Math.round((scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)) * 100) || 0}%`);
  return out.join('\n');
}
