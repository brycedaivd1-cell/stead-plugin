// does: Map a Google Form in one call: every question on this page with its type, choices, whether it is required, what is filled in now and any error shown, plus the Next/Submit buttons. Use it before filling a Google Form; then click choices with target role=radio[name="<choice>"] or role=checkbox[name="<choice>"].
// args: {}
// site: docs.google.com/forms
async () => {
  // Read through ARIA roles and labels, which Forms keeps for screen readers, not its class names,
  // which change. Tested on public forms while signed out; a form that needs sign-in says so.
  const clip = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  if (/accounts\.google\.com/.test(location.host)) return 'The form wants them signed in: call browser_login with this page, then run gforms-map again.';
  if (!/docs\.google\.com$/.test(location.host) || !/\/forms\//.test(location.pathname)) return 'Open the Google Form first (a docs.google.com/forms/... link; forms.gle links redirect there).';
  const label = (el) => el.getAttribute('aria-label') || el.getAttribute('data-value') || el.getAttribute('data-answer-value') || el.innerText;
  const choice = (el) => (el.getAttribute('data-value') === '__other_option__' || label(el) === '__other_option__' ? 'Other (type it)' : clip(label(el), 40));
  const on = (el) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';
  const out = [];
  const title = [...document.querySelectorAll('[role=heading][aria-level="1"]')].find(vis)?.innerText || document.title.replace(/ - Google Forms$/, '');
  const page = (document.body.innerText.match(/Page \d+ of \d+/) || [])[0];
  out.push(`${clip(title, 100)}${page ? ` (${page})` : ''} — ${location.href.split('?')[0]}`);

  // A question is a list item with its own heading; the choices inside it are list items too, without one.
  const qs = [...document.querySelectorAll('[role=listitem]')].filter((li) => vis(li) && li.querySelector('[role=heading]')
    && ![...li.querySelectorAll('[role=listitem]')].some((x) => x.querySelector('[role=heading]')));
  let n = 0;
  for (const q of qs) {
    const head = q.querySelector('[role=heading]');
    let name = clip(head.innerText.replace(/\s*\*\s*$/, ''), 120);
    const required = /\*\s*$/.test(head.innerText.trim()) || !!q.querySelector('[aria-required=true], [aria-label="Required question"]');
    let type = '';
    let opts = [];
    let now = '';
    const radios = [...q.querySelectorAll('[role=radio]')];
    const boxes = [...q.querySelectorAll('[role=checkbox]')];
    const list = q.querySelector('[role=listbox]');
    const rows = [...q.querySelectorAll('[role=radiogroup], [role=group]')].filter((g) => g.querySelector('[role=radio], [role=checkbox]'));
    if (rows.length > 1) {
      // Grid: one row per sub-question. Forms labels each cell "<column>, response for <row>".
      type = 'grid';
      const cells = (g) => [...g.querySelectorAll('[role=radio], [role=checkbox]')];
      opts = cells(rows[0]).map((c) => clip(label(c).split(/, response for /)[0], 25));
      now = rows.map((g) => { const c = cells(g); const row = (label(c[0]).split(/, response for /)[1] || '').trim(); const picked = c.filter(on).map((x) => label(x).split(/, response for /)[0]); return `${clip(row, 30)}: ${picked.join('+') || '-'}`; }).join('; ');
    } else if (radios.length) {
      const nums = radios.every((r) => /^\d+$/.test(label(r)));
      type = nums ? 'scale' : 'choose one';
      opts = radios.map(choice);
      now = radios.filter(on).map(choice).join('');
    } else if (boxes.length) {
      type = 'choose any';
      opts = boxes.map(choice);
      now = boxes.filter(on).map(choice).join(', ');
    } else if (list) {
      type = 'dropdown';
      const o = [...list.querySelectorAll('[role=option]')];
      opts = o.map((x) => x.getAttribute('data-value') ?? x.innerText).filter((v) => v && v.trim()).map((v) => clip(v, 40));
      now = o.filter((x) => on(x) && x.getAttribute('data-value')).map((x) => x.getAttribute('data-value')).join('');
    } else if (q.querySelector('textarea')) {
      type = 'paragraph';
      now = clip(q.querySelector('textarea').value, 60);
    } else if (q.querySelector('input[type=date]')) {
      type = 'date';
      now = q.querySelector('input[type=date]').value;
    } else if (q.querySelector('input[type=text], input[type=email], input[type=number], input[type=url], input:not([type])')) {
      const ins = [...q.querySelectorAll('input[type=text], input[type=email], input[type=number], input[type=url], input:not([type])')].filter(vis);
      type = ins.length > 1 ? `text boxes (${ins.map((i) => i.getAttribute('aria-label') || '?').join(', ')})` : (ins[0]?.type === 'email' ? 'email' : 'short answer');
      now = ins.map((i) => i.value).filter(Boolean).join(' ');
    } else if ([...q.querySelectorAll('[role=button]')].some((b) => /add file/i.test(b.innerText))) type = 'file upload (needs sign-in)';
    else { type = 'text only'; name = clip(q.innerText, 120); }
    if (type === 'text only') { out.push(`   (${name})`); continue; }
    const err = [...q.querySelectorAll('[role=alert]')].map((e) => e.innerText.trim()).filter(Boolean)[0];
    const many = opts.length > 25 ? `${opts.slice(0, 25).join(' / ')} / …${opts.length} total` : opts.join(' / ');
    out.push(`${++n}. ${name}${required ? ' · required' : ''} · ${type}${opts.length ? ` [${many}]` : ''} = ${now || '(empty)'}${err ? `  ! ${clip(err, 60)}` : ''}`);
  }
  if (!n) {
    // Closed form, "already responded", or a page this tool doesn't know: give the words instead.
    const main = document.querySelector('[role=main]') || document.body;
    out.push('No questions found on this page. It says:', clip(main.innerText, 600));
  }
  const buttons = [...document.querySelectorAll('[role=button], button')].filter(vis).map((b) => b.innerText.trim()).filter((t) => /^(Next|Back|Submit|Clear form|Send|Weiter|Siguiente|Enviar|Suivant|Envoyer)$/i.test(t));
  if (buttons.length) out.push(`BUTTONS: ${[...new Set(buttons)].join(' · ')}${buttons.some((b) => /submit|send|enviar|envoyer/i.test(b)) ? '  (Submit sends it: an official form needs their yes first)' : ''}`);
  const signedIn = [...document.querySelectorAll('a, div')].some((e) => /^Switch account$/i.test(e.innerText?.trim() || ''));
  if (document.querySelector('input[type=email]') || /Record .* email/i.test(document.body.innerText)) out.push(signedIn ? 'The form records their email.' : 'The form asks for an email.');
  return out.join('\n');
}
