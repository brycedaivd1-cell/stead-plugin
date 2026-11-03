// does: Tidy a messy folder (Downloads by default) into subfolders by type: Documents, PDFs, Images, Installers, Archives... Shows the plan first; apply: true moves the files (never deletes); undo: true puts everything back.
// args: {folder: "~/Downloads", older_than_days: 0, apply: false, undo: false}
// safe: read (with no args it only shows the plan for Downloads; apply and undo move files)
// Why a tool: sorting 400 downloads by hand is hundreds of moves; this is one call, reversible.
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
const folder = path.resolve(String(args.folder || '~/Downloads').replace(/^~(?=$|[\\/])/, home));
const undoFile = path.join(folder, '.stead-tidy-undo.json');
const GROUPS = {
  PDFs: ['.pdf'], Documents: ['.doc', '.docx', '.odt', '.rtf', '.txt', '.md', '.pages'],
  Spreadsheets: ['.xls', '.xlsx', '.csv', '.ods', '.numbers'], Presentations: ['.ppt', '.pptx', '.odp', '.key'],
  Images: ['.png', '.jpg', '.jpeg', '.gif', '.heic', '.webp', '.bmp', '.svg', '.ico'], Videos: ['.mp4', '.mov', '.avi', '.mkv', '.webm'],
  Audio: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg'], Archives: ['.zip', '.rar', '.7z', '.tar', '.gz'],
  Installers: ['.exe', '.msi', '.dmg', '.pkg', '.appx', '.msix'], Code: ['.js', '.py', '.html', '.css', '.json', '.ts', '.java', '.c', '.cpp', '.ipynb'],
};
const groupOf = (f) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(path.extname(f).toLowerCase())) || 'Other';

if (args.undo) {
  if (!fs.existsSync(undoFile)) { console.log('Nothing to undo in that folder.'); process.exit(0); }
  const moves = JSON.parse(fs.readFileSync(undoFile, 'utf8'));
  let n = 0;
  for (const { from, to } of moves.reverse()) {
    if (fs.existsSync(to) && !fs.existsSync(from)) { fs.renameSync(to, from); n++; }
  }
  for (const g of [...Object.keys(GROUPS), 'Other']) { try { fs.rmdirSync(path.join(folder, g)); } catch {} } // only removes empty ones
  fs.rmSync(undoFile);
  console.log(`Put ${n} file(s) back where they were.`);
  process.exit(0);
}

if (!fs.existsSync(folder)) { console.log(`No folder ${folder}.`); process.exit(1); }
const cutoff = Date.now() - Number(args.older_than_days || 0) * 86400e3;
const plan = {};
for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
  if (!e.isFile() || e.name.startsWith('.') || /\.(crdownload|part|tmp)$/i.test(e.name) || /^desktop\.ini$/i.test(e.name)) continue;
  const p = path.join(folder, e.name);
  if (fs.statSync(p).mtimeMs > cutoff) continue;
  (plan[groupOf(e.name)] ||= []).push(e.name);
}
const total = Object.values(plan).reduce((a, b) => a + b.length, 0);
if (!total) { console.log(`Nothing to tidy in ${folder}.`); process.exit(0); }
const summary = Object.entries(plan).sort((a, b) => b[1].length - a[1].length)
  .map(([g, f]) => `${g}/ (${f.length}): ${f.slice(0, 4).join(', ')}${f.length > 4 ? ', …' : ''}`).join('\n');
if (!args.apply) {
  console.log(`Plan for ${folder}: ${total} file(s) into subfolders (moves only, nothing deleted, undo: true reverses it):\n${summary}\n\nShow them this and run again with apply: true if they agree.`);
  process.exit(0);
}
const moves = [];
for (const [g, files] of Object.entries(plan)) {
  fs.mkdirSync(path.join(folder, g), { recursive: true });
  for (const f of files) {
    const from = path.join(folder, f);
    const ext = path.extname(f);
    let to = path.join(folder, g, f);
    for (let n = 2; fs.existsSync(to); n++) to = path.join(folder, g, `${f.slice(0, f.length - ext.length)} (${n})${ext}`);
    try { fs.renameSync(from, to); moves.push({ from, to }); } catch {}
  }
}
const prior = fs.existsSync(undoFile) ? JSON.parse(fs.readFileSync(undoFile, 'utf8')) : [];
fs.writeFileSync(undoFile, JSON.stringify([...prior, ...moves]));
console.log(`Moved ${moves.length} of ${total} file(s) in ${folder}:\n${summary}\nUndo any time with undo: true.`);
