// does: List every newsletter/bulk sender Gmail knows about (Gmail's own Manage subscriptions page)
// args: {}
// site: mail.google.com
async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!location.host.includes('mail.google.com')) return 'Open https://mail.google.com first.';
  if (location.hash !== '#sub') location.hash = '#sub';
  for (let t = 0; t < 40; t++) {
    const m = document.querySelector('[role=main]');
    if (m && /Subscriptions/.test(m.innerText) && /@/.test(m.innerText)) {
      return m.innerText.split('\n').filter((l) => l.includes('@')).map((l) => l.trim().replace(/\t+/g, ' | ')).join('\n');
    }
    await sleep(250);
  }
  return 'Subscriptions page did not load.';
}
