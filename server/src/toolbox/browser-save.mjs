// does: Save something from the web to their computer using the Stead browser's logins: a file link (PDF, doc, image) as-is, or any page as a PDF. Returns the saved path (then print, attach or upload it).
// args: {url: "https://... (omit = the newest open tab; pass the url to be sure)", as: "file | pdf (default: file for direct file links, pdf for web pages)", folder: "~/Downloads", name: "optional file name"}
// Why a tool: school portals and banks put PDFs behind a login, so a plain download fails, and "save
// this page as a PDF" by hand is print dialog -> destination -> Save as PDF -> file picker. This uses the
// same logged-in browser, so both are one call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--(.+)$/);
  if (!m) continue;
  let v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) v = 'true'; else i++;
  try { args[m[1]] = JSON.parse(v); } catch { args[m[1]] = v; }
}
// toolbox_run also sends the exact args as JSON: Windows PowerShell strips the quotes inside the
// --name values above, so a list like ["~/School Work"] arrives broken there.
try { Object.assign(args, JSON.parse(process.env.STEAD_ARGS || '{}')); } catch {}
const fail = (m) => { console.log(m); process.exit(1); };
const expand = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
const folder = expand(args.folder || '~/Downloads');
fs.mkdirSync(folder, { recursive: true });
const clean = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'download';
// Never overwrite: "report.pdf" -> "report (2).pdf".
function freePath(name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(folder, name);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(folder, `${base} (${n})${ext}`);
  return p;
}

const b = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.STEAD_PORT || 9222}`).catch((e) => fail(`The Stead browser isn't reachable: ${e.message}`));
const ctx = b.contexts()[0];
let result;
try {
  let url = args.url;
  if (!url) {
    // The tab they're looking at: the last one that isn't blank or an internal page.
    const pages = ctx.pages().filter((p) => /^https?:|^file:/.test(p.url()));
    if (!pages.length) fail('No page is open. Give url.');
    url = pages.at(-1).url();
  }
  let as = args.as;
  if (!as) {
    const head = await ctx.request.fetch(url, { method: 'HEAD', timeout: 20000 }).catch(() => null);
    const type = head?.headers()['content-type'] || '';
    as = /text\/html/.test(type) || (!type && !/\.(pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|gif|csv|txt)(\?|$)/i.test(url)) ? 'pdf' : 'file';
  }
  if (as === 'file') {
    const r = await ctx.request.get(url, { timeout: 120000 });
    if (!r.ok()) fail(`The site answered ${r.status()} ${r.statusText()}. If it needs a login, log in in the Stead browser first.`);
    const type = r.headers()['content-type'] || '';
    if (/text\/html/.test(type) && !args.name) fail('That link is a web page (maybe a login page), not a file. Use as: "pdf" to save the page, or log in first.');
    const cd = r.headers()['content-disposition'] || '';
    const fromHeader = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i) || [])[1] || '');
    let name = clean(args.name || fromHeader || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download'));
    if (!path.extname(name)) {
      const ext = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'text/csv': '.csv', 'application/zip': '.zip' }[type.split(';')[0]];
      if (ext) name += ext;
    }
    const out = freePath(name);
    fs.writeFileSync(out, await r.body());
    result = `Saved ${out} (${Math.round(fs.statSync(out).size / 1024)} KB, ${type.split(';')[0] || 'unknown type'}).`;
  } else {
    // Its own tab, so whatever they have open is not disturbed.
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: 'load', timeout: 60000 });
    await p.waitForTimeout(1500);
    const title = await p.title();
    const s = await ctx.newCDPSession(p);
    const r = await s.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    await p.close();
    const name = clean(args.name || title || new URL(url).hostname);
    const out = freePath(name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`);
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    result = `Saved the page "${title}" as ${out} (${Math.round(fs.statSync(out).size / 1024)} KB).`;
  }
} finally {
  await b.close().catch(() => {});
}
console.log(result);
