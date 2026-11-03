// does: List the newest Gmail inbox emails as "unread? | from | subject | snippet | date" lines (Primary tab). Open https://mail.google.com/mail/u/0/#inbox first. Read the rows; open one only when the line isn't enough.
// args: {max: 30, unread_only: false}
// site: mail.google.com
async ({ max = 30, unread_only = false } = {}) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  if (/accounts\.google\.com/.test(location.host)) return 'Gmail wants them signed in: call browser_login with https://mail.google.com, then run gmail-inbox again.';
  if (!location.host.includes('mail.google.com')) return 'Open https://mail.google.com/mail/u/0/#inbox first.';
  if (!/^#inbox/.test(location.hash)) location.hash = '#inbox';
  // Gmail's list rows are tr.zA (unread ones also .zE); the sender is the [email] span, the subject .bog.
  const rows = () => [...document.querySelectorAll('[role=main] tr.zA')].filter((r) => r.offsetParent);
  for (let t = 0; t < 40 && !rows().length; t++) await sleep(250);
  if (!rows().length) return `No inbox rows found. The page says: ${clip(document.querySelector('[role=main]')?.innerText || document.body.innerText, 300)}`;
  const out = [];
  for (const r of rows()) {
    const unread = r.classList.contains('zE');
    if (unread_only && !unread) continue;
    const from = r.querySelector('[email]');
    const sender = from ? `${from.getAttribute('name') || from.innerText} <${from.getAttribute('email')}>` : clip(r.querySelector('.yX')?.innerText, 40);
    const subject = clip(r.querySelector('.bog')?.innerText, 100);
    const snippet = clip(r.querySelector('.y2')?.innerText.replace(/^\s*-\s*/, ''), 140);
    const date = r.querySelector('td.xW span[title]')?.getAttribute('title') || clip(r.querySelector('td.xW')?.innerText, 30);
    out.push(`- ${unread ? 'UNREAD | ' : ''}${clip(sender, 60)} | ${subject} | ${snippet} | ${date}`);
    if (out.length >= max) break;
  }
  return `Inbox (${out.length} shown${unread_only ? ', unread only' : ''}):\n${out.join('\n') || '(nothing unread)'}`;
}
