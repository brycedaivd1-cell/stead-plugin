// does: Find their files fast by name words, type or recent date across Desktop, Documents, Downloads, Pictures, Videos, Music and OneDrive. Newest first, with size and folder.
// args: {query: "essay history (words in the name, any order; omit for 'recent')", type: "pdf | doc | sheet | slides | image | video | audio | zip | installer | or an extension like .psd", days: 30, folders: ["~/Somewhere/else"], limit: 25}
// Why a tool: "find that essay I wrote last week" otherwise means listing folders one by one.
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
const expand = (p) => path.resolve(String(p).replace(/^~(?=$|[\\/])/, home));
const TYPES = {
  pdf: ['.pdf'], doc: ['.doc', '.docx', '.odt', '.rtf', '.txt', '.md', '.pages'], sheet: ['.xls', '.xlsx', '.csv', '.ods', '.numbers'],
  slides: ['.ppt', '.pptx', '.odp', '.key'], image: ['.png', '.jpg', '.jpeg', '.gif', '.heic', '.webp', '.bmp', '.svg'],
  video: ['.mp4', '.mov', '.avi', '.mkv', '.webm'], audio: ['.mp3', '.wav', '.m4a', '.flac', '.aac'], zip: ['.zip', '.rar', '.7z', '.tar', '.gz'],
  installer: ['.exe', '.msi', '.dmg', '.pkg'],
};
const exts = args.type ? (TYPES[String(args.type).toLowerCase()] || [String(args.type).toLowerCase().replace(/^\.?/, '.')]) : null;
const words = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
const since = args.days ? Date.now() - Number(args.days) * 86400e3 : (words.length || exts ? 0 : Date.now() - 14 * 86400e3);
const limit = Number(args.limit || 25);

const roots = new Set([...(args.folders || []).map(expand)]);
for (const d of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music']) roots.add(path.join(home, d));
try { for (const d of fs.readdirSync(home)) if (/^OneDrive/i.test(d)) roots.add(path.join(home, d)); } catch {}
const SKIP = /^(node_modules|\.git|\.cache|AppData|Library|\$RECYCLE\.BIN|__pycache__|\.venv|venv|dist|build)$/i;

const hits = [];
let scanned = 0;
const deadline = Date.now() + 20000;
const seen = new Set();
function walk(dir, depth) {
  if (depth > 8 || Date.now() > deadline) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.test(e.name)) walk(p, depth + 1); continue; }
    if (!e.isFile()) continue;
    scanned++;
    const n = e.name.toLowerCase();
    if (exts && !exts.includes(path.extname(n))) continue;
    // Words can match the name or the folder it's in ("history essay" finds History/essay-final.docx).
    const hay = `${path.basename(dir)} ${n}`.toLowerCase();
    if (words.length && !words.every((w) => hay.includes(w))) continue;
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs < since) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ p, t: st.mtimeMs, s: st.size });
  }
}
for (const r of roots) if (fs.existsSync(r)) walk(r, 0);
hits.sort((a, b) => b.t - a.t);
const size = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const when = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
console.log(hits.length
  ? `${hits.length} match${hits.length === 1 ? '' : 'es'} (${scanned} files searched${Date.now() > deadline ? ', stopped at the time limit' : ''}), newest first:\n` +
    hits.slice(0, limit).map((h) => `${when(h.t)}  ${size(h.s).padStart(7)}  ${h.p}`).join('\n') + (hits.length > limit ? `\n…${hits.length - limit} more (narrow it with type/days, or raise limit)` : '')
  : ![...roots].some((r) => fs.existsSync(r)) ? `None of the usual folders (Desktop, Documents, Downloads...) exist here. Pass folders: ["C:/path"].` : `Nothing matched in ${[...roots].filter((r) => fs.existsSync(r)).map((r) => r.replace(home, '~')).join(', ')} (${scanned} files searched). Try fewer words, or add folders.`);
