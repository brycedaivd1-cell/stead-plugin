// does: List Outlook's detected newsletter senders. Navigate to https://outlook.live.com/mail/0/options/mail/brandsSubscriptions first.
// args: {}
// site: outlook.live.com
async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let t = 0; t < 60; t++) {
    const p = [...document.querySelectorAll('[role=dialog]')].find((d) => d.innerText.includes('Your current subscriptions'));
    if (p) {
      const [cur, done = ''] = p.innerText.split("Lists you've unsubscribed from");
      const mails = (s) => s.match(/[\w.+-]+@[\w.-]+/g) || [];
      return { subscribed: mails(cur), alreadyUnsubscribed: mails(done) };
    }
    // The "add a recovery method" nag can cover the page.
    const nag = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Not now' && b.offsetParent);
    if (nag) nag.click();
    await sleep(250);
  }
  return 'Subscriptions list not found: navigate to https://outlook.live.com/mail/0/options/mail/brandsSubscriptions';
}
