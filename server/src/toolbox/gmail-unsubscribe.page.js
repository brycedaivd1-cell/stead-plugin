// does: Unsubscribe from Gmail senders in one call (Gmail's one-click unsubscribe). Ask the person first.
// args: {emails: ["news@site.com", ...]}
// site: mail.google.com
async ({ emails = [] } = {}) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (location.hash !== '#sub') { location.hash = '#sub'; await sleep(2500); }
  const main = () => document.querySelector('[role=main]');
  const results = {};
  const deadline = Date.now() + 25000;
  for (const w of emails) {
    if (Date.now() > deadline) { results[w] = 'not tried (time budget): call again'; continue; }
    if (!main().innerText.includes(w)) { results[w] = 'not listed (already unsubscribed, or not a mailing list)'; continue; }
    const row = [...main().querySelectorAll('*')]
      .filter((e) => e.innerText && e.innerText.includes(w) && e.innerText.split('@').length === 2)
      .sort((a, b) => b.innerText.length - a.innerText.length)[0];
    const btn = row && [...row.querySelectorAll('button,[role=button]')].find((b) => b.innerText.trim() === 'Unsubscribe' && b.offsetParent);
    if (!btn) { results[w] = 'no unsubscribe button'; continue; }
    btn.click();
    let d;
    for (let t = 0; t < 20 && !d; t++) {
      await sleep(200);
      d = [...document.querySelectorAll('[role=alertdialog],[role=dialog]')].find((x) => x.offsetParent && /unsubscribe/i.test(x.innerText));
    }
    if (!d) { results[w] = 'no confirm dialog'; continue; }
    const ok = [...d.querySelectorAll('button')].filter((b) => /unsubscribe|go to website/i.test(b.innerText)).pop();
    if (!ok || /website/i.test(ok.innerText)) {
      [...d.querySelectorAll('button')].find((b) => /cancel/i.test(b.innerText))?.click();
      results[w] = "needs the sender's website: open one of their emails and use its unsubscribe link";
      continue;
    }
    ok.click();
    let gone = false;
    for (let t = 0; t < 20 && !gone; t++) { await sleep(250); gone = !main().innerText.includes(w); }
    results[w] = gone ? 'unsubscribed' : 'clicked, not confirmed: check the list';
  }
  return results;
}
