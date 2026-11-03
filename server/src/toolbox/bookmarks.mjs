// does: Search their bookmarks in Chrome, Edge, Brave and the Stead browser, to find the exact site they mean ("my school portal", "the gym booking page") without guessing URLs. Read-only; never touches passwords or history.
// args: {query: "school portal (omit to list the bookmarks bar)", limit: 20}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const home = os.homedir();
const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
const mac = path.join(home, 'Library', 'Application Support');
const BROWSERS = process.platform === 'win32'
  ? { Chrome: path.join(local, 'Google', 'Chrome', 'User Data'), Edge: path.join(local, 'Microsoft', 'Edge', 'User Data'), Brave: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') }
  : process.platform === 'darwin'
    ? { Chrome: path.join(mac, 'Google', 'Chrome'), Edge: path.join(mac, 'Microsoft Edge'), Brave: path.join(mac, 'BraveSoftware', 'Brave-Browser') }
    : { Chrome: path.join(home, '.config', 'google-chrome'), Chromium: path.join(home, '.config', 'chromium'), Brave: path.join(home, '.config', 'BraveSoftware', 'Brave-Browser') };
for (const n of ['stead', 'otto', 'hands']) {
  const p = path.join(home, `.${n}-profile`);
  if (fs.existsSync(p)) { BROWSERS.Stead = p; break; }
}

const all = [];
for (const [browser, dir] of Object.entries(BROWSERS)) {
  let profiles = [];
  try { profiles = fs.readdirSync(dir).filter((d) => d === 'Default' || /^Profile \d+$/.test(d)); } catch { continue; }
  for (const prof of profiles) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, prof, 'Bookmarks'), 'utf8')); } catch { continue; }
    const walk = (node, trail) => {
      if (node.type === 'url') all.push({ name: node.name, url: node.url, where: `${browser}${profiles.length > 1 ? ` (${prof})` : ''} › ${trail.join(' › ')}`, bar: trail[0] === 'Bookmarks bar' });
      for (const c of node.children || []) walk(c, node.type === 'folder' && node.name ? [...trail, node.name] : trail);
    };
    for (const [k, root] of Object.entries(j.roots || {})) walk(root, [{ bookmark_bar: 'Bookmarks bar', other: 'Other bookmarks', synced: 'Mobile' }[k] || k]);
  }
}
const words = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
const score = (b) => {
  const hay = `${b.name} ${b.url} ${b.where}`.toLowerCase();
  return words.reduce((s, w) => s + (hay.includes(w) ? (b.name.toLowerCase().includes(w) ? 3 : 1) : -100), 0);
};
const seen = new Set();
const hits = (words.length ? all.map((b) => ({ ...b, s: score(b) })).filter((b) => b.s > 0).sort((a, b) => b.s - a.s) : all.filter((b) => b.bar))
  .filter((b) => !seen.has(b.url) && seen.add(b.url)).slice(0, Number(args.limit || 20));
console.log(hits.length
  ? hits.map((b) => `${b.name || '(no name)'}\n  ${b.url}\n  ${b.where}`).join('\n')
  : all.length ? `No bookmark matches "${args.query}" (${all.length} bookmarks searched).` : 'No bookmarks found in Chrome, Edge or Brave.');
