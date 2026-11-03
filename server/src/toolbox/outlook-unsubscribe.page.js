// does: Unsubscribe Outlook senders from the Subscriptions settings page, checking each one left the list. Ask the person first.
// args: {emails: ["news@site.com", ...]}
// site: outlook.live.com
async ({ emails = [] } = {}) => {
  // The list re-renders after every unsubscribe, so clicking ahead makes later clicks miss while
  // still looking successful. Do one, wait until its row is gone, then the next.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panel = () => [...document.querySelectorAll('[role=dialog]')].find((d) => d.innerText.includes('Your current subscriptions'));
  if (!panel()) return 'Open https://outlook.live.com/mail/0/options/mail/brandsSubscriptions first.';
  const current = () => panel().innerText.split("Lists you've unsubscribed from")[0];
  const results = {};
  const deadline = Date.now() + 25000;
  for (const w of emails) {
    if (Date.now() > deadline) { results[w] = 'not tried (time budget): call again'; continue; }
    if (!current().includes(w)) { results[w] = 'not in the list'; continue; }
    const btn = [...panel().querySelectorAll('button')].filter((b) => b.innerText.trim() === 'Unsubscribe').find((b) => {
      let p = b;
      for (let i = 0; i < 5; i++) { p = p.parentElement; if (p.innerText.includes(w) && p.innerText.split('Unsubscribe').length <= 2) return true; }
      return false;
    });
    if (!btn) { results[w] = 'no button'; continue; }
    btn.click();
    let d;
    for (let t = 0; t < 15 && !d; t++) {
      await sleep(200);
      d = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].find((x) => x.innerText.startsWith('Unsubscribe?'));
    }
    if (!d) { results[w] = 'no confirm dialog'; continue; }
    const msg = d.innerText.split('\n').filter(Boolean)[1] || '';
    [...d.querySelectorAll('button')].find((b) => b.innerText.trim() === 'OK').click();
    let gone = false;
    for (let t = 0; t < 20 && !gone; t++) { await sleep(250); gone = !current().includes(w); }
    // Some senders only offer a web page: Outlook opens it in a new tab and the real opt-out is there.
    results[w] = !gone ? 'clicked, not confirmed'
      : /webpage/i.test(msg) ? "opened the sender's preferences page in a new tab: finish the opt-out there"
      : 'unsubscribed';
  }
  return results;
}
