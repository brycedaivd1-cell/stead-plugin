// "Later": reminders, scheduled jobs, to-dos and follow-ups that happen when the person isn't
// talking to Claude. Claude can only act while a chat is open, so without this "remind me the day
// before" or "check this every morning" silently never happened.
//
// This one file is both the library (imported by later.js) and the runner. The runner is copied to
// ~/.stead/later-tick.mjs and the OS scheduler starts it every minute (Task Scheduler on Windows,
// launchd on macOS, cron on Linux). It uses only Node built-ins, so it keeps working however Stead
// was installed (npx cache, global, a checkout) and starts in ~50 ms.
//   node later-tick.mjs            fire whatever is due (what the scheduler runs)
//   node later-tick.mjs run-queue  carry out queued jobs one at a time (started by the tick)
//   node later-tick.mjs run <id>   carry out one scheduled job now
//   node later-tick.mjs test       send a test notification
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as phone from './phone.mjs';
import * as W from './watch.mjs';

const SELF = fileURLToPath(import.meta.url);
// WP-B's attention gate, when it's there: in the repo at onscreen/attention.js, beside the runner copy
// as attention.mjs. Optional: without it (or if it fails to load) a fullscreen/exam check stands in.
const attention = await import('./onscreen/attention.js').catch(() => import('./attention.mjs')).catch(() => null);
const WIN = process.platform === 'win32';
const BOM = /^\uFEFF/;

// Same rule as resolveHome in paths.js (keep them in step): the folder that holds their data, not
// just the newest one that exists, so the scheduler never fires from an empty folder.
export function homeDir() {
  const env = process.env.STEAD_HOME || process.env.OTTO_HOME || process.env.HANDS_HOME;
  if (env) return env;
  // The copy the scheduler runs lives in the Stead folder itself.
  const here = path.dirname(SELF);
  if (fs.existsSync(path.join(here, 'consent.json')) || /^\.(stead|otto|hands)$/.test(path.basename(here))) return here;
  const has = (d, f) => fs.existsSync(path.join(d, f));
  const dirs = ['.stead', '.otto', '.hands'].map((d) => path.join(os.homedir(), d));
  return dirs.find((d) => has(d, 'consent.json'))
    || dirs.find((d) => ['brain', 'tools', 'later.json'].some((f) => has(d, f)))
    || dirs.find((d) => fs.existsSync(d))
    || dirs[0];
}
const file = (home, f) => path.join(home, f);
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(BOM, '')); } catch { return d; } };
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// A real Node to start the runner and jobs with. Inside Claude Desktop's built-in runtime (an
// extension install) process.execPath is Claude.exe. Registered bare, the scheduler would start the
// Claude app every minute, and ELECTRON_RUN_AS_NODE doesn't help: Claude Desktop switches it off
// (tested 2026-10-07: Claude.exe with it set opened the app). So find an installed node, or say
// plainly it's missing (missing: true) instead of registering something that can't run.
const nodeCache = new Map();
export const NO_NODE = 'needs Node.js, which isn\'t installed on this computer yet: install the LTS version from nodejs.org, then fully quit and reopen Claude';
export function nodeBin(exe = process.execPath) {
  if (nodeCache.has(exe)) return nodeCache.get(exe);
  let out = { bin: exe, env: {} };
  if (!/^node(js)?(\.exe)?$/i.test(path.basename(exe))) {
    const r = WIN ? spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true }) : spawnSync('/bin/sh', ['-lc', 'command -v node'], { encoding: 'utf8' });
    const spots = WIN
      ? [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'), 'C:\\Program Files\\nodejs\\node.exe']
      // A Mac app's PATH is only /usr/bin:/bin..., so look where Homebrew and the installer put it.
      : ['/opt/homebrew/bin/node', '/usr/local/bin/node', path.join(os.homedir(), '.volta', 'bin', 'node')];
    const hit = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s && (!WIN || /\.exe$/i.test(s)))
      || spots.find((p) => { try { return p && fs.statSync(p).isFile(); } catch { return false; } });
    out = hit ? { bin: hit, env: {} } : { bin: exe, env: { ELECTRON_RUN_AS_NODE: '1' }, missing: true };
  }
  nodeCache.set(exe, out);
  return out;
}
function spawnSelf(args, home) {
  const n = nodeBin();
  if (n.missing) { log(home, `can't start ${args[0] || 'the runner'}: no Node.js on this computer`); return; }
  const p = spawn(n.bin, [SELF, ...args], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...n.env, STEAD_HOME: home } });
  p.unref();
}

// ---------- store ----------
// later.json has several writers (the tick, the job runner, the MCP server, the phone listener,
// Claude editing it by hand), so every rule here is about never losing it.
const EMPTY = () => ({ next: 1, items: [] });

// Windows: antivirus or a backup tool can hold the file for a moment. That's a retry, never "empty".
function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= tries - 1 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      sleepMs(50 * (i + 1));
    }
  }
}

function parse(p) {
  const raw = retry(() => fs.readFileSync(p, 'utf8')).replace(BOM, '');
  if (!raw.trim()) return null;
  const d = JSON.parse(raw);
  if (!d || !Array.isArray(d.items)) throw new Error('it has no "items" list');
  if (!Number.isInteger(d.next)) d.next = Math.max(0, ...d.items.map((i) => Number(String(i.id).replace(/\D/g, '')) || 0)) + 1;
  return d;
}

// A file that can't be read must never turn into "no reminders": the next save would make that
// permanent. A leading BOM (PowerShell 5's Set-Content -Encoding UTF8 adds one) is just skipped.
// Anything else: the damaged file is kept aside and the copy from the last save takes over.
export function load(home = homeDir()) {
  const p = file(home, 'later.json');
  try {
    const d = parse(p);
    if (d) return d;
  } catch (e) {
    if (e.code === 'ENOENT') return EMPTY();
    if (e.code) throw e; // still locked after retries: this run fails, the next one retries
    return recover(home, e);
  }
  return recover(home, new Error('it is empty'));
}

function recover(home, why) {
  const p = file(home, 'later.json');
  let size = 0;
  let mtime = 0;
  try { ({ size, mtimeMs: mtime } = fs.statSync(p)); } catch {}
  const aside = `${p}.damaged-${Math.round(mtime)}`;
  if (size && !fs.existsSync(aside)) { try { fs.copyFileSync(p, aside); } catch {} }
  let bak = null;
  try { bak = parse(`${p}.bak`); } catch {}
  if (bak) {
    log(home, `later.json could not be read (${why.message}); using the last good copy. The damaged file is ${aside}`);
    // update() sees this and writes the good copy back, so the repair happens once.
    Object.defineProperty(bak, 'recovered', { value: size ? aside : 'empty', enumerable: false });
    return bak;
  }
  if (!size) return EMPTY(); // empty and no backup: there was nothing to lose
  const e = new Error(`The reminders file ${p} is damaged (${why.message}), so no reminder can fire. A copy is at ${aside}. Fix the JSON or move the file away.`);
  e.code = 'LATER_DAMAGED';
  throw e;
}

function writeAtomic(p, data) {
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Windows refuses the rename while an indexer or antivirus has the target open: wait and retry.
    retry(() => fs.renameSync(tmp, p), 6);
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}

export function save(data, home = homeDir()) {
  fs.mkdirSync(home, { recursive: true });
  const p = file(home, 'later.json');
  writeAtomic(p, data);
  // The last good copy, for when someone (or a tool) breaks later.json by hand.
  try { writeAtomic(`${p}.bak`, data); } catch {}
}

// One writer at a time across processes. Held for milliseconds, so a lock older than 10 s
// belongs to a process that died mid-write.
function withLock(home, fn) {
  fs.mkdirSync(home, { recursive: true });
  const lock = file(home, 'later.json.lock');
  const start = Date.now();
  const me = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let fd = null;
  while (fd === null) {
    try { fd = fs.openSync(lock, 'wx'); } catch (e) {
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(e.code)) throw e;
      if (Date.now() - start > 30000) throw new Error(`Could not lock ${lock}. Delete it if nothing is running.`);
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age <= 10000) { sleepMs(20); continue; }
      // Take a stale lock over by renaming it away: only one waiter's rename succeeds. Delete-then-create
      // let two waiters both "remove the stale lock", the second removing the first's fresh one.
      const aside = `${lock}.${me}.stale`;
      try { fs.renameSync(lock, aside); } catch { continue; }
      // Lost a race and moved someone's fresh lock? Put it back (link fails if the spot is taken).
      try { if (Date.now() - fs.statSync(aside).mtimeMs <= 10000) fs.linkSync(aside, lock); } catch {}
      try { fs.rmSync(aside, { force: true }); } catch {}
    }
  }
  try { fs.writeSync(fd, me); } catch {}
  fs.closeSync(fd);
  // Release only our own: if we ran past 10 s and another process took over, the lock is theirs now.
  try { return fn(); } finally { try { if (fs.readFileSync(lock, 'utf8') === me) fs.rmSync(lock, { force: true }); } catch {} }
}

// Read-modify-write in one locked step so the tick, a running job and Claude don't overwrite each other.
export function update(fn, home = homeDir()) {
  return withLock(home, () => {
    const data = load(home);
    const before = JSON.stringify(data);
    const out = fn(data);
    // Most ticks change nothing; skipping the write keeps the file and its backup still.
    if (data.recovered || JSON.stringify(data) !== before) save(data, home);
    return out;
  });
}
export function settings(home = homeDir()) {
  return readJson(file(home, 'settings.json'), {});
}
const log = (home, line) => { try { fs.appendFileSync(file(home, 'later.log'), `${new Date().toISOString()}  ${line}\n`); } catch {} };

// ---------- time ----------
// "1d" "2h" "30m" "1w" or a number of minutes -> minutes
export function minutes(v) {
  if (typeof v === 'number') return v;
  const m = String(v).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|weeks?)?$/);
  if (!m) throw new Error(`Can't read "${v}" as a length of time. Use e.g. 15m, 2h, 1d, 1w.`);
  const n = Number(m[1]);
  const u = (m[2] || 'm')[0];
  return Math.round(n * { m: 1, h: 60, d: 1440, w: 10080 }[u]);
}

// "2026-10-12T16:00" (their local time), "2026-10-12 4:00pm", "+30m", "+2h", "+3d" -> Date
export function parseWhen(s, now = new Date()) {
  const str = String(s).trim();
  const rel = str.match(/^(?:in\s+)?\+?\s*(\d+(?:\.\d+)?\s*[a-z]+)$/i);
  if (rel && /^\+|^in\s/i.test(str)) return new Date(now.getTime() + minutes(rel[1]) * 60000);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})\s*(am|pm)?)?$/i);
  if (m) {
    let h = Number(m[4] ?? 9);
    if (m[6]) h = (h % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, Number(m[5] ?? 0));
  }
  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) return d;
  throw new Error(`Can't read "${s}" as a time. Use their local time as YYYY-MM-DDTHH:MM (e.g. 2026-10-12T16:00), or +30m / +2h / +3d.`);
}

export const REPEATS = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
const MIN_EVERY = 5; // the runner wakes once a minute; anything tighter is a loop, not a schedule
const FIXED = { hourly: { unit: 'min', n: 60 }, daily: { unit: 'day', n: 1 }, weekdays: { unit: 'weekdays', n: 1 }, weekly: { unit: 'day', n: 7 }, monthly: { unit: 'month', n: 1 }, yearly: { unit: 'month', n: 12 } };

// A repeat as a step on the clock (minutes) or the calendar (days, months). Calendar steps keep
// 9:00 at 9:00 across daylight saving and "the 31st" on the last day of short months.
function stepOf(repeat) {
  if (!repeat) return null;
  const r = String(repeat).trim().toLowerCase();
  if (FIXED[r]) return FIXED[r];
  const bad = new Error(`Can't read the repeat "${repeat}". Use ${REPEATS.join(', ')}, or "every" and a length: every 30m, every 2 weeks, every 3 months.`);
  const m = /^every\s+(\d+(?:\.\d+)?\s*)?([a-z]+)$/.exec(r);
  if (!m) throw bad;
  const n = m[1] ? Number(m[1]) : 1;
  const u = m[2];
  const whole = Number.isInteger(n) && n > 0;
  if (whole && /^(months?|mos?)$/.test(u)) return { unit: 'month', n };
  if (whole && /^(years?|yrs?|y)$/.test(u)) return { unit: 'month', n: n * 12 };
  if (whole && /^(days?|d)$/.test(u)) return { unit: 'day', n };
  if (whole && /^(weeks?|wks?|w)$/.test(u)) return { unit: 'day', n: n * 7 };
  if (/^weekdays?$/.test(u) && !m[1]) return FIXED.weekdays;
  let min;
  try { min = minutes(`${n}${u}`); } catch { throw bad; }
  if (!(min > 0)) throw bad;
  return { unit: 'min', n: min };
}

// Why a repeat can't be scheduled, or null when it can. later_add checks this before saving.
export function repeatError(r) {
  if (!r) return null;
  try {
    const s = stepOf(r);
    return s.unit === 'min' && s.n < MIN_EVERY ? `Repeats must be at least ${MIN_EVERY} minutes apart.` : null;
  } catch (e) { return e.message; }
}
export const validRepeat = (r) => !repeatError(r);

// Day of month and time of day an item was first set for, so steps never drift from it.
export const anchorOf = (at) => { const d = new Date(at); return { dom: d.getDate(), h: d.getHours(), min: d.getMinutes() }; };

// The next occurrence after `after`. `anchor` (from anchorOf at creation) keeps a monthly item on
// the 31st and a daily one at 2:30 after a month or a day that didn't have them.
export function nextOccurrence(at, repeat, after = new Date(), anchor = null) {
  const step = stepOf(repeat);
  if (!step) return null;
  const start = new Date(at);
  const d = new Date(start);
  if (step.unit === 'min') {
    const ms = step.n * 60000;
    d.setTime(d.getTime() + Math.max(1, Math.floor((after - d) / ms) + 1) * ms);
    return d;
  }
  const a = anchor || anchorOf(start);
  let months = 0;
  let guard = 0;
  do {
    if (step.unit === 'month') {
      months += step.n;
      const y = start.getFullYear();
      const m = start.getMonth() + months;
      d.setTime(new Date(y, m, Math.min(a.dom, new Date(y, m + 1, 0).getDate()), a.h, a.min, start.getSeconds(), start.getMilliseconds()).getTime());
    } else {
      d.setDate(d.getDate() + (step.unit === 'day' ? step.n : 1));
      if (step.unit === 'weekdays') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
      d.setHours(a.h, a.min);
    }
  } while (d <= after && ++guard < 100000);
  return d;
}

export function fmt(d) {
  const date = new Date(d);
  return date.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fromNow(d, now = new Date()) {
  const min = Math.round((new Date(d) - now) / 60000);
  const a = Math.abs(min);
  const s = a < 60 ? `${a} min` : a < 1440 * 2 ? `${Math.round(a / 60)} hours` : `${Math.round(a / 1440)} days`;
  return min >= 0 ? `in ${s}` : `${s} ago`;
}
const lead = (m) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} min`);

// Every alert time of an item's current occurrence, earliest first.
export function alertsOf(item) {
  if (!item.at) return [];
  const at = new Date(item.at).getTime();
  return [...(item.before || []).map((m) => ({ t: at - m * 60000, before: m })), { t: at, before: 0 }].sort((a, b) => a.t - b.t);
}

// ---------- notify ----------
function desktopNotify(title, body) {
  if (process.env.STEAD_QUIET_NOTIFY === '1') return null; // tests
  try {
    if (WIN) {
      // A toast in the "reminder" scenario stays on screen until they dismiss it.
      const ps = `
$ErrorActionPreference='Stop'
$k='HKCU:\\Software\\Classes\\AppUserModelId\\Stead'
if(-not (Test-Path $k)){ New-Item $k -Force | Out-Null; New-ItemProperty $k -Name DisplayName -Value 'Stead' -Force | Out-Null }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$t=[Security.SecurityElement]::Escape($env:STEAD_T); $b=[Security.SecurityElement]::Escape($env:STEAD_B)
$x="<toast scenario='reminder'><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual><actions><action content='Got it' arguments='dismiss' activationType='system'/></actions><audio src='ms-winsoundevent:Notification.Reminder'/></toast>"
$d=New-Object Windows.Data.Xml.Dom.XmlDocument; $d.LoadXml($x)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Stead').Show([Windows.UI.Notifications.ToastNotification]::new($d))`;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { env: { ...process.env, STEAD_T: title, STEAD_B: body }, windowsHide: true, encoding: 'utf8', timeout: 20000 });
      return r.status === 0 ? null : (r.stderr || 'toast failed').trim().slice(0, 300);
    }
    if (process.platform === 'darwin') {
      const r = spawnSync('osascript', ['-e', 'on run a', '-e', 'display notification (item 2 of a) with title (item 1 of a) sound name "Glass"', '-e', 'end run', title, body], { timeout: 20000 });
      return r.status === 0 ? null : 'osascript failed';
    }
    const r = spawnSync('notify-send', ['-u', 'critical', title, body], { timeout: 20000 });
    return r.status === 0 ? null : 'notify-send failed';
  } catch (e) { return e.message; }
}

// Several at once. On Windows one PowerShell shows them all (the alerts go in as JSON on an env var);
// elsewhere the per-alert command is cheap. Returns the first error, or null.
function desktopNotifyMany(list) {
  if (!WIN || list.length < 2 || process.env.STEAD_QUIET_NOTIFY === '1') return list.map(([t, b]) => desktopNotify(t, b)).find(Boolean) || null;
  try {
    const ps = `
$ErrorActionPreference='Stop'
$k='HKCU:\\Software\\Classes\\AppUserModelId\\Stead'
if(-not (Test-Path $k)){ New-Item $k -Force | Out-Null; New-ItemProperty $k -Name DisplayName -Value 'Stead' -Force | Out-Null }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$n=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Stead')
foreach($m in (ConvertFrom-Json $env:STEAD_TOASTS)){
$t=[Security.SecurityElement]::Escape($m.t); $b=[Security.SecurityElement]::Escape($m.b)
$x="<toast scenario='reminder'><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual><actions><action content='Got it' arguments='dismiss' activationType='system'/></actions><audio src='ms-winsoundevent:Notification.Reminder'/></toast>"
$d=New-Object Windows.Data.Xml.Dom.XmlDocument; $d.LoadXml($x)
$n.Show([Windows.UI.Notifications.ToastNotification]::new($d)) }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { env: { ...process.env, STEAD_TOASTS: JSON.stringify(list.map(([t, b]) => ({ t, b }))) }, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    return r.status === 0 ? null : (r.stderr || 'toast failed').trim().slice(0, 300);
  } catch (e) { return e.message; }
}

// Desktop notification, plus their own extra channel if they set one (settings.json
// "notify_command": the message arrives on its stdin, e.g. a script that texts their phone).
// Quiet hours (settings.quiet_hours {from:"22:00", to:"07:00"}): news (job results, nudges) stays a
// toast only, no phone and no Stead-on-screen line. Reminders they set for a time still go everywhere.
export function inQuietHours(home = homeDir(), now = new Date()) {
  const q = settings(home).quiet_hours;
  const m = (s) => { const x = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
  const a = m(q?.from), b = m(q?.to);
  if (a === null || b === null || a === b) return false;
  const n = now.getHours() * 60 + now.getMinutes();
  return a < b ? n >= a && n < b : n >= a || n < b;
}
// The onscreen line waits out a test, a meeting or something full screen (the toast and phone still go).
const BUSY = new Set(['test', 'meeting', 'fullscreen']);
export function screenBusy(home = homeDir()) {
  try {
    const g = attention?.gateFile?.(home);
    if (g) return BUSY.has(typeof g === 'string' ? g : g.state);
  } catch {}
  const st = readJson(file(home, path.join('onscreen', 'state.json')), null);
  if (!st || Date.now() - Date.parse(st.at) > 120000) return false;
  const fg = st.fg || {};
  return !!(fg.full || st.inCall || /lockdown|respondus|safeexam|^seb$/i.test(fg.proc || ''));
}

export function notify(title, body, home = homeDir(), { toastErr, news = false } = {}) {
  const errs = [];
  const hush = news && inQuietHours(home);
  const e = toastErr !== undefined ? toastErr : desktopNotify(title, body);
  if (e) errs.push(`desktop: ${e}`);
  const cmd = settings(home).notify_command;
  if (cmd && !hush) {
    const r = spawnSync(cmd, { shell: true, input: `${title}\n${body}`, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) errs.push(`notify_command: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 200)}`);
  }
  log(home, `notify ${errs.length ? 'PARTIAL ' + errs.join('; ') : 'ok'} :: ${title} :: ${body.replace(/\s+/g, ' ').slice(0, 160)}`);
  // Stead on screen says it too, if she's up (same message format as src/onscreen/index.js send()).
  if (!hush && !screenBusy(home)) try {
    const bd = path.join(home, 'onscreen');
    const pid = Number(fs.readFileSync(path.join(bd, 'body.pid'), 'utf8'));
    if (pid > 0 && process.kill(pid, 0)) {
      const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      fs.writeFileSync(path.join(bd, 'inbox', `${name}.tmp`), JSON.stringify({ type: 'say', text: `${title}. ${body}`.slice(0, 300), kind: 'reminder', ttl: 60000, buttons: [{ id: 'ok', label: 'Got it' }] }));
      fs.renameSync(path.join(bd, 'inbox', `${name}.tmp`), path.join(bd, 'inbox', `${name}.json`));
    }
  } catch {}
  // A paired phone gets every alert too (sent in the background; the process stays up until it's out).
  if (!hush && phone.isPaired(home)) {
    phone.sendText(`${title}\n${body}`, home).catch((err) => log(home, `notify phone FAILED ${err.message}`));
  }
  return errs;
}

// ---------- the tick ----------
const MISSED_PRE_ALERT = 36 * 3600e3; // a "1 day before" alert that is 36h late is noise; skip it

function fire(it, now, fired, jobs) {
  it.fired = it.fired || [];
  for (const a of alertsOf(it)) {
    const key = new Date(a.t).toISOString();
    // The runner wakes once a minute; firing up to 30s early beats firing up to 59s late.
    if (a.t > now.getTime() + 30000 || it.fired.includes(key)) continue;
    // A job whose last run is still going stays due (not marked fired) so it runs once that one ends,
    // instead of this occurrence being dropped for good.
    if (!a.before && it.kind === 'do' && it.running && runningNow(it)) continue;
    it.fired.push(key);
    if (a.before && now.getTime() - a.t > MISSED_PRE_ALERT) continue;
    const late = now.getTime() - a.t > 10 * 60000;
    if (a.before) {
      const link = it.prep?.url && !it.started && a.before >= 20 * 60 && a.before <= 28 * 60 ? ` Not started yet? ${it.prep.url}` : '';
      fired.push([`In ${lead(a.before)}: ${it.what}`, `${fmt(it.at)}${late ? ' (this alert was late: the computer was off or asleep)' : ''}${link}`]);
    } else if (it.kind === 'do') {
      jobs.push(it);
    } else {
      const title = it.kind === 'follow_up' ? `Follow up: ${it.what}` : it.what;
      fired.push([late ? `Missed while the computer was off: ${title}` : title, it.note || (late ? `It was due ${fmt(it.at)}.` : fmt(it.at))]);
    }
    if (!a.before) {
      const next = it.repeat ? nextOccurrence(it.at, it.repeat, now, it.anchor) : null;
      // The next occurrence's early alerts that are already due ("1 day before" a daily one is right
      // now) count as fired: else the next tick says "In 1 day" the moment this one advanced.
      if (next) {
        it.at = next.toISOString();
        it.fired = alertsOf(it).filter((x) => x.before && x.t <= now.getTime() + 30000).map((x) => new Date(x.t).toISOString());
      } else if (it.kind !== 'do') { it.status = 'done'; it.closed = now.toISOString(); it.closedBy = 'fired'; }
    }
  }
}

// "Not started yet": an item with a prep link (a Classroom assignment) 24h before it's due and not
// marked started gets one nudge with the link, unless a ~1-day alert already went out for it.
const NUDGE_LEAD = 24 * 3600e3;
function prepNudge(it, now, fired) {
  if (it.kind === 'when' || !it.prep?.url || it.started || !it.at || it.nudged === it.at) return;
  const at = new Date(it.at).getTime();
  if (now.getTime() < at - NUDGE_LEAD || now.getTime() >= at) return;
  it.nudged = it.at;
  // Its 1-day alert carries the link, unless that alert was already past when the item was made.
  if ((it.before || []).some((m) => m >= 20 * 60 && m <= 28 * 60 && Date.parse(it.created || 0) < at - m * 60000)) return;
  fired.push([`Not started yet: ${it.what}`, `Due ${fmt(it.at)}. ${it.prep.url}`, true]);
}

// A trigger that fired becomes a one-shot job due now: the queue, history and pause rules apply as
// to any job. The trigger stays; what fired reaches the job as data only.
function cloneFor(d, it, data, now) {
  const task = it.task ? `${it.task}

${W.dataBlock(data)}` : null;
  d.items.push({ id: `l${d.next++}`, kind: 'do', what: it.what, at: now.toISOString(), before: [], repeat: null, anchor: null, task, command: it.command || null, shell: it.shell || null,
    until_success: false, quiet: Boolean(it.quiet), note: null, status: 'open', created: now.toISOString(), fired: [], from: it.id, trigger_data: data, ...(it.scripts ? { scripts: it.scripts } : {}) });
}

export function tick(home = homeDir(), now = new Date(), probes = {}) {
  const fired = [];
  const jobs = [];
  let items = [];
  let error = null;
  try {
    update((data) => {
      items = data.items;
      if (data.recovered) fired.push(['Stead repaired your reminders', `The reminders file couldn't be read, so the copy from the last change was put back.${data.recovered === 'empty' ? '' : ` The damaged file is kept as ${data.recovered}.`}`]);
      // Event triggers first, so a job they start is due in this same tick.
      try { for (const { it, data: what } of W.checkTriggers(home, data.items, now, probes)) { cloneFor(data, it, what, now); log(home, `trigger ${it.id} fired: ${JSON.stringify(what).slice(0, 200)}`); } }
      catch (e) { log(home, `triggers: ${e.message}`); }
      for (const it of data.items) {
        // A runner that died mid-job (shutdown, sleep, killed) would leave it "running now" for good.
        if (it.running && !runningNow(it)) delete it.running;
        if (it.status !== 'open' || !it.at) continue;
        // One bad item must never stop the rest: a throw here used to skip the save and every
        // other reminder, every minute, for good.
        try { prepNudge(it, now, fired); fire(it, now, fired, jobs); } catch (e) {
          it.status = 'broken';
          it.error = e.message;
          it.closed = now.toISOString();
          fired.push([`Reminder needs fixing: ${it.what}`, `Stead couldn't work out when it repeats (${it.repeat}). Ask Claude to set it up again.`]);
          log(home, `broken ${it.id}: ${e.message}`);
        }
      }
      // Due jobs join a queue that one runner works through in order: jobs that all came due
      // together (say, after the laptop woke) would otherwise fight over one Chrome.
      for (const it of jobs) {
        if (it.running && runningNow(it)) { log(home, `skipped ${it.id}: the last run is still going`); continue; }
        delete it.running;
        it.queued = it.queued || now.toISOString();
      }
    }, home);
  } catch (e) { error = e; }
  // One toast call per tick: each is a PowerShell start (~1s), and many due at once (after the laptop
  // woke) used to hold the tick for seconds. The other channels still get each alert.
  if (fired.length) {
    const toastErr = desktopNotifyMany(fired);
    for (const [t, b, news] of fired) notify(t, b, home, { toastErr, news: !!news });
  }
  try { phone.ensureListener(home); } catch (e) { log(home, `phone listener: ${e.message}`); }
  if (items.some((i) => i.queued && i.status === 'open') && !jobRunning(home) && process.env.STEAD_NO_JOB_RUNNER !== '1') spawnSelf(['run-queue'], home);
  try { scheduleWake(home, items, now); } catch (e) { log(home, `wake: ${e.message}`); }
  // The heartbeat: lets later_list and brain_recall tell "running" from "registered but stuck".
  const prev = readJson(file(home, 'last-tick.json'), {});
  if (error) {
    log(home, `tick FAILED ${error.message}`);
    // Say it once, not every minute.
    if (prev.error !== error.message) notify('Stead reminders are stuck', error.message.slice(0, 250), home);
  }
  try { fs.writeFileSync(file(home, 'last-tick.json'), JSON.stringify({ at: new Date().toISOString(), ok: !error, error: error?.message || null })); } catch {}
  return { fired: fired.length, jobs: jobs.length, ...(error ? { error: error.message } : {}) };
}

// When the tick last ran (null if never) and whether that's too long ago to be "running".
export function tickHealth(home = homeDir(), now = Date.now()) {
  const t = readJson(file(home, 'last-tick.json'), null);
  const at = t?.at ? new Date(t.at) : null;
  const ageMin = at ? (now - at.getTime()) / 60000 : null;
  return { at, ageMin, ok: t?.ok ?? null, error: t?.error || null, stale: ageMin === null || ageMin > 5 };
}

// A sleeping laptop runs nothing, so the every-minute task alone fires a 7am reminder when the lid
// opens. A one-shot "Stead wake" task with WakeToRun wakes it for the next alert instead (Windows;
// a laptop that ignores wake timers on battery still catches up when it wakes).
function scheduleWake(home, items, now) {
  if (!WIN || process.env.STEAD_NO_SCHEDULER === '1') return;
  const vbs = file(home, 'later-tick.vbs');
  if (!fs.existsSync(vbs)) return;
  const next = items.filter((i) => i.status === 'open' && i.at)
    .flatMap((i) => alertsOf(i).filter((a) => a.t > now.getTime() + 60000 && !(i.fired || []).includes(new Date(a.t).toISOString())).map((a) => a.t))
    .sort((a, b) => a - b)[0];
  const stateFile = file(home, 'later-scheduler.json');
  const st = readJson(stateFile, {});
  if (!next || st.wakeAt === next) return;
  // 20 s early: the tick fires anything due within 30 s, so the wake-up tick catches it.
  const d = new Date(next - 20000);
  const p2 = (n) => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const ps = `
$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $env:STEAD_VBS + '"')
$t = New-ScheduledTaskTrigger -Once -At ([datetime]$env:STEAD_AT)
$s = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'Stead wake' -Action $a -Trigger $t -Settings $s -Description 'Stead: wakes the computer for your next reminder.' -Force | Out-Null`;
  // Not detached: the tick waits for it, and wakeAt is written only once the task really registered.
  // Written up front, a failed registration was never retried (wakeAt already matched).
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { stdio: 'ignore', windowsHide: true, timeout: 60000, env: { ...process.env, STEAD_VBS: vbs, STEAD_AT: local } });
  p.on('error', (e) => log(home, `wake: ${e.message}`));
  p.on('exit', (code) => {
    if (code !== 0) return log(home, `wake: Register-ScheduledTask exited ${code}`);
    try { fs.writeFileSync(stateFile, JSON.stringify({ ...readJson(stateFile, {}), wakeAt: next }, null, 2)); } catch {}
  });
}

// ---------- scheduled jobs ----------
// Claude Desktop ships its own Claude Code (%APPDATA%\Claude\claude-code\<version>\<hash>\claude.exe),
// so a Desktop-only person may have one without ever installing it. Newest version first.
function desktopClaudes(base) {
  const ver = (v) => v.split('.').map((n) => Number(n) || 0);
  const newer = (a, b) => { const x = ver(a); const y = ver(b); for (let i = 0; i < 4; i++) if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
  try {
    return fs.readdirSync(base).sort(newer).flatMap((v) => {
      try { return fs.readdirSync(path.join(base, v)).map((h) => path.join(base, v, h, WIN ? 'claude.exe' : 'claude')); } catch { return []; }
    });
  } catch { return []; }
}

// A program on PATH (on Windows only a .cmd or .exe: `where` also lists the extensionless npm shim).
function onPath(name) {
  const r = WIN ? spawnSync('where', [name], { encoding: 'utf8', windowsHide: true }) : spawnSync('/bin/sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' });
  const hits = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return (WIN ? hits.find((h) => /\.(cmd|exe)$/i.test(h)) : hits[0]) || null;
}

export function findClaude() {
  // Tests and unusual installs; "none" stands for a computer without Claude Code.
  if (process.env.STEAD_CLAUDE_BIN) return process.env.STEAD_CLAUDE_BIN === 'none' ? null : process.env.STEAD_CLAUDE_BIN;
  const found = onPath('claude');
  if (found) return found;
  // Not on PATH. Known install spots, including one that only exists on Windows: an `npm i -g`
  // run from inside the Claude desktop app (an MSIX package) lands in the app's private copy of
  // AppData, invisible to Task Scheduler. It still runs fine from its real path.
  const h = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(h, 'AppData', 'Roaming');
  const msix = (() => { try { return fs.readdirSync(path.join(local, 'Packages')).filter((d) => /^Claude_/i.test(d)).map((d) => path.join(local, 'Packages', d, 'LocalCache', 'Roaming')); } catch { return []; } })();
  const spots = WIN
    ? [path.join(h, '.local', 'bin', 'claude.exe'), path.join(roaming, 'npm', 'claude.cmd'), ...msix.map((d) => path.join(d, 'npm', 'claude.cmd')),
      ...desktopClaudes(path.join(roaming, 'Claude', 'claude-code')), ...msix.flatMap((d) => desktopClaudes(path.join(d, 'Claude', 'claude-code')))]
    : [path.join(h, '.local', 'bin', 'claude'), path.join(h, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
      ...desktopClaudes(path.join(h, 'Library', 'Application Support', 'Claude', 'claude-code'))];
  return spots.find((p) => fs.existsSync(p)) || null;
}

// claude (or codex) is a .cmd (npm) or an .exe. On Windows it runs through cmd, which needs the path
// quoted (a space in the user name broke it) and the args already quoted by claudeArgs/codexArgs. Building the line
// ourselves also avoids Node's warning about passing args with shell: true.
export function claudeCommand(claude, args) {
  return WIN ? { cmd: [`"${claude}"`, ...args].join(' '), args: [], shell: true } : { cmd: claude, args, shell: false };
}

// ChatGPT and Codex people have no Claude Code: their Codex CLI can run the job instead, through the
// Stead that `stead init` put in ~/.codex/config.toml.
export function findCodex() {
  if (process.env.STEAD_CODEX_BIN) return process.env.STEAD_CODEX_BIN === 'none' ? null : process.env.STEAD_CODEX_BIN;
  const found = onPath('codex');
  if (found) return found;
  const npm = WIN ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'codex.cmd') : null;
  return npm && fs.existsSync(npm) ? npm : null;
}
// Codex's -c override only adds STEAD_UNATTENDED to an existing [mcp_servers.stead]; without that
// table it would describe a server with no command, so Codex can't run jobs here.
function codexHasStead() {
  const cfg = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  try { return /^\s*\[\s*mcp_servers\.("?)stead\1\s*\]/m.test(fs.readFileSync(cfg, 'utf8')); } catch { return false; }
}

// Who carries out a Claude job here: Claude Code first, else Codex. null = nobody, it waits for a chat.
export function jobRunner() {
  const claude = findClaude();
  if (claude) return { kind: 'claude', bin: claude };
  const codex = findCodex();
  return codex && codexHasStead() ? { kind: 'codex', bin: codex } : null;
}

// Can a job run by itself here? later_add asks before promising it will. Both checks are local and
// free (no model call). loggedIn null = couldn't tell (an older version): assume it can.
export function canRunJobs(home = homeDir()) {
  const run = jobRunner();
  if (!run) return { ok: false, why: 'no-claude' };
  const env = { ...process.env, ...(run.kind === 'claude' ? settings(home).claude_env || {} : {}) };
  const c = claudeCommand(run.bin, run.kind === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status']);
  const r = spawnSync(c.cmd, c.args, { shell: c.shell, env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  let loggedIn = null;
  if (run.kind === 'claude') { try { loggedIn = JSON.parse(String(r.stdout || '').trim()).loggedIn ?? null; } catch {} }
  else if (/not logged in/i.test(`${r.stdout}${r.stderr}`)) loggedIn = false; // untested: Codex's wording
  const base = { runner: run.kind, bin: run.bin, ...(run.kind === 'claude' ? { claude: run.bin } : {}) };
  return loggedIn === false ? { ok: false, ...base, why: 'logged-out' } : { ok: true, ...base, loggedIn };
}

// The same Stead Claude already uses, taken from Claude Code's config, marked unattended so nothing
// that needs a yes can happen while nobody is there to give it.
export function mcpConfigFor(home, env = { STEAD_UNATTENDED: '1' }, name = 'later-mcp.json') {
  let entry = null;
  try { entry = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers?.stead; } catch {}
  // Set up for Claude Desktop only (no Claude Code entry): start Stead the way it last started
  // (the server records that), else the published package.
  if (!entry) { try { entry = JSON.parse(fs.readFileSync(file(home, 'server-entry.json'), 'utf8')); } catch {} }
  // Else a Stead already on this computer, run by a real node: npx -y would download and run
  // whatever the registry serves at job time, unattended. npx only when there's no copy at all.
  if (!entry) {
    const npmRoot = WIN ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules') : null;
    const local = [path.join(path.dirname(SELF), '..', 'bin', 'stead.js'), npmRoot && path.join(npmRoot, 'stead-ai', 'bin', 'stead.js'),
      '/opt/homebrew/lib/node_modules/stead-ai/bin/stead.js', '/usr/local/lib/node_modules/stead-ai/bin/stead.js'].find((p) => p && fs.existsSync(p));
    const n = nodeBin();
    if (local && !n.missing) entry = { command: n.bin, args: [local, 'all'] };
  }
  if (!entry) entry = WIN ? { command: 'cmd', args: ['/c', 'npx', '-y', 'stead-ai', 'all'] } : { command: 'npx', args: ['-y', 'stead-ai', 'all'] };
  // The job's Stead uses the folder this runner serves (its own lookup could pick another one),
  // unless the entry names a folder itself.
  const own = ['STEAD_HOME', 'OTTO_HOME', 'HANDS_HOME'].some((k) => entry.env?.[k]) ? {} : { STEAD_HOME: home };
  const f = file(home, name);
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { stead: { ...entry, env: { ...own, ...(entry.env || {}), ...env } } } }, null, 2));
  return f;
}

// On Windows claude/codex are .cmd files run through the shell: quote what the shell would split.
const shellArgs = (args) => (WIN ? args.map((a) => (a === '' || /[\s&|<>^]/.test(a) ? `"${a}"` : a)) : args);

// Every built-in Claude Code tool is switched off (--tools ""): its Bash, PowerShell, file edits,
// WebFetch and sub-agents would act around Stead's safety layer (held commands, protected
// folders, pause, the activity log). Only Stead's own MCP tools remain (checked on claude 2.1.263:
// the session's tool list is just mcp__stead__*, and they run). A deny list kept missing new built-ins.
export function claudeArgs({ mcp, model, maxTurns = 100 }) {
  const args = ['-p', '--mcp-config', mcp, '--strict-mcp-config', '--setting-sources', '', '--tools', '', '--permission-mode', 'bypassPermissions',
    '--output-format', 'json', '--max-turns', String(maxTurns)];
  if (model) args.push('--model', model);
  return shellArgs(args);
}

// UNTESTED against a real Codex (none on the machine this was written on; the test uses a stand-in).
// The read-only sandbox and approval "never" are meant to keep Codex's own shell from changing
// anything, so it acts only through Stead, whose server gets STEAD_UNATTENDED like a Claude job's.
// Unverified: how strictly Codex's sandbox holds on Windows, where its support is newest. The values are
// TOML literal strings ('1'): a bare 1 would be a number, and env values must be strings. The reply
// is read from the -o file (the last message), not from stdout's progress log.
export function codexArgs(out, env = { STEAD_UNATTENDED: '1' }) {
  return shellArgs(['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-c', "approval_policy='never'",
    ...Object.entries(env).flatMap(([k, v]) => ['-c', `mcp_servers.stead.env.${k}='${v}'`]), '-o', out, '-']);
}

export function parseClaudeOutput(stdout) {
  try { return JSON.parse(String(stdout).trim().split('\n').at(-1)); } catch { return { is_error: true, result: String(stdout || 'no output').slice(-1500) }; }
}

const UNATTENDED = `You are carrying out a job the person scheduled earlier. They are not at the computer and nobody
can answer questions, so do not ask any. Use your Stead tools; call brain_recall first. Do the job fully,
check it worked, then reply with a short report (first line = the result in under 15 words; it becomes
their notification). Do not pay, buy, delete data, or submit official forms, and do not send messages or
emails as them unless the job below explicitly says to send exactly that. If the job needs any of those
or needs a login, prepare everything you can, stop, and say what is left for them.

The job:
`;

// The job couldn't run by itself: it waits for their next chat (brain_recall shows it as due).
function leaveForChat(home, it, why, body) {
  update((d) => { const x = d.items.find((y) => y.id === it.id); if (x) { x.pending = true; x.pendingWhy = why; } }, home);
  notify(`Time to: ${it.what}`, body, home, { news: true });
}

// A command job runs in Windows PowerShell, the shell Claude writes everywhere else (cmd mangled
// its single-quoted paths). From a script file: no quoting layer, plain-text errors, and the
// command's own exit code. Items saved before this ran under cmd and still do.
async function runCommand(it, home) {
  // A triggered run gets what fired as STEAD_TRIGGER (JSON): the command itself is never rewritten.
  const env = it.trigger_data ? { ...process.env, STEAD_TRIGGER: JSON.stringify(it.trigger_data) } : process.env;
  const opts = { timeout: 15 * 60000, cwd: os.homedir(), env, onBeat: () => beatJobs(home, it.id) };
  if (!(WIN && it.shell === 'powershell')) return runLimited(it.command, [], { ...opts, shell: true });
  const ps1 = file(home, `later-job-${it.id}.ps1`);
  const script = `$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${it.command}\n$ok = $?\nif (-not $ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE } exit 1 }\nexit 0\n`;
  fs.writeFileSync(ps1, '\uFEFF' + script); // the BOM makes PowerShell 5 read it as UTF-8
  try { return await runLimited('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], opts); } finally { fs.rmSync(ps1, { force: true }); }
}

// A file's fingerprint (sha256), or '' when it can't be read.
export function fingerprint(f) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; }
}

function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid); } catch { try { child.kill('SIGKILL'); } catch {} } }
}

// A job with a time limit that really holds. spawnSync's timeout kills only the shell on Windows
// (cmd.exe), and then waits on the real program for as long as it runs. This kills the whole tree,
// and beats the jobs lock while the job runs so a long job isn't taken for a dead runner.
export function runLimited(cmd, args, { timeout, input, shell = false, env = process.env, cwd = os.homedir(), onBeat } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let timedOut = false;
    let child;
    try { child = spawn(cmd, args, { shell, env, cwd, windowsHide: true, detached: !WIN }); } catch (e) { resolve({ status: null, stdout: '', stderr: '', error: e }); return; }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { if (out.length < 64 * 1024 * 1024) out += d; });
    child.stderr?.on('data', (d) => { if (err.length < 16 * 1024 * 1024) err += d; });
    const finish = (status, error) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      clearInterval(beat);
      resolve({ status, stdout: out, stderr: err, error: error || (timedOut ? new Error(`stopped after ${Math.round(timeout / 60000)} minutes (the time limit)`) : null) });
    };
    const limit = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => finish(null), 10000).unref(); // a grandchild that escaped the tree holds the pipes
    }, timeout);
    const beat = setInterval(() => onBeat?.(), 60000);
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(timedOut ? null : code));
    // A browser the job cold-started can inherit the pipes and hold them open for hours, so
    // 'close' never comes. Once the job itself has exited, give its output a moment and finish.
    child.on('exit', (code) => { setTimeout(() => finish(timedOut ? null : code), 3000).unref(); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

// Built-in jobs Stead set up itself (not something they asked for): skipped quietly when they can't
// run, instead of a "Time to: ..." nudge every day. builtin "plan" is the morning plan precompute:
// its prompt (plan.js planPrompt) is read-only, and the raw reply goes to plan-job.json, which
// plan.js turns into the pending plan the next time anything reads it.
const PLAN_PREFIX = 'You are running at a scheduled time and nobody is at the computer: do not ask anything, and only read.\n\n';
function builtinSkip(home, it, why) {
  log(home, `builtin ${it.builtin} ${it.id} skipped: ${why}`);
  update((d) => { const x = d.items.find((y) => y.id === it.id); if (x) x.history = [...(x.history || []), { at: new Date().toISOString(), ok: false, summary: `skipped: ${why}` }].slice(-10); }, home);
}

export async function runJob(id, home = homeDir()) {
  const it = load(home).items.find((x) => x.id === id);
  if (!it || it.status !== 'open') return;
  if (it.builtin && fs.existsSync(file(home, 'PAUSED'))) return builtinSkip(home, it, 'paused');
  if (it.builtin && !it.command && !jobRunner()) return builtinSkip(home, it, 'no Claude Code or Codex here');
  // `stead pause` stops every acting tool; a scheduled job is one too.
  if (fs.existsSync(file(home, 'PAUSED'))) {
    leaveForChat(home, it, 'paused', 'Stead is paused, so it did not run. It waits for your next chat with Claude.');
    return;
  }
  let ok = false;
  let summary = '';
  let full = '';
  if (it.command) {
    // A script it runs was changed after it was checked at scheduling time: nobody is here to
    // look at the new version, so it waits for them.
    const changed = Object.entries(it.scripts || {}).find(([f, h]) => fingerprint(f) !== h);
    if (changed) {
      leaveForChat(home, it, 'changed', `${path.basename(changed[0])} changed after this was scheduled, so Stead did not run it with nobody watching. Ask Claude to check it and schedule it again.`);
      return;
    }
    const r = await runCommand(it, home);
    ok = r.status === 0;
    full = `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`.trim();
    summary = full.split('\n').map((s) => s.trim()).filter(Boolean).at(-1) || (ok ? 'done' : `failed (exit ${r.status})`);
  } else {
    const run = jobRunner();
    if (!run) {
      leaveForChat(home, it, 'no-claude', 'Open Claude and say "do my scheduled jobs".');
      return;
    }
    const input = it.builtin === 'plan' ? PLAN_PREFIX + String(it.task || '').replace('{{NOW}}', new Date().toLocaleString()) : UNATTENDED + (it.task || it.what);
    const opts = { input, timeout: 25 * 60000, cwd: os.homedir(), onBeat: () => beatJobs(home, it.id) };
    if (run.kind === 'claude') {
      const c = claudeCommand(run.bin, claudeArgs({ mcp: mcpConfigFor(home), model: it.model }));
      // settings.json "claude_env" (e.g. {"CLAUDE_CONFIG_DIR": "..."}) picks which Claude login runs jobs.
      const r = await runLimited(c.cmd, c.args, { ...opts, shell: c.shell, env: { ...process.env, ...(settings(home).claude_env || {}) } });
      const j = parseClaudeOutput(r.stdout || r.stderr || r.error?.message);
      ok = !j.is_error;
      full = String(j.result || '');
    } else {
      const last = file(home, `later-job-${it.id}.codex.txt`);
      fs.rmSync(last, { force: true });
      const c = claudeCommand(run.bin, codexArgs(last));
      const r = await runLimited(c.cmd, c.args, { ...opts, shell: c.shell, env: process.env });
      let reply = '';
      try { reply = fs.readFileSync(last, 'utf8').trim(); } catch {}
      fs.rmSync(last, { force: true });
      ok = r.status === 0 && Boolean(reply);
      full = reply || `${r.stderr || ''}${r.stdout || ''}${r.error ? `\n${r.error.message}` : ''}`.trim().slice(-1500) || 'no output';
    }
    const lines = full.split('\n').map((s) => s.trim()).filter(Boolean);
    // The reply's first line is the result; a failed Codex run's error is its last line, after the banner.
    summary = (ok || run.kind === 'claude' ? lines[0] : lines.at(-1)) || (ok ? 'done' : 'failed');
    const app = run.kind === 'claude' ? 'Claude Code' : 'Codex';
    // Installed but logged out: don't lose the job, hand it to their next chat.
    // (Codex prints a banner first, so its error can be a few lines in.)
    if (!ok && /authenticat|oauth|\/login|not logged in|codex login/i.test(run.kind === 'claude' ? summary : full.slice(0, 600))) {
      if (it.builtin) return builtinSkip(home, it, `${app} is logged out`);
      leaveForChat(home, it, 'logged-out', `Open Claude and say "do my scheduled jobs". (${app} is logged out, so it could not run by itself.)`);
      return;
    }
    // Too old to know --tools: it would otherwise run with its own command tools switched on.
    if (!ok && run.kind === 'claude' && /unknown option/i.test(full)) summary = 'Claude Code on this computer is too old to run jobs safely. Update it (run: claude update) and it runs next time.';
  }
  const day = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const dir = file(home, 'later-results');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${id}-${day}.md`);
  fs.writeFileSync(out, `# ${it.what}\n\n${new Date().toString()}\n${ok ? 'Finished' : 'FAILED'}\n\n${full}\n`);
  if (it.builtin === 'plan') { try { fs.writeFileSync(file(home, 'plan-job.json'), JSON.stringify({ at: new Date().toISOString(), ok, result: full.slice(0, 20000) })); } catch {} }
  const stopNow = it.until_success && ok;
  update((d) => {
    const x = d.items.find((y) => y.id === id);
    if (!x) return;
    x.history = [...(x.history || []), { at: new Date().toISOString(), ok, summary: summary.slice(0, 300), file: out }].slice(-10);
    x.pending = false;
    delete x.pendingWhy;
    if (!x.repeat || stopNow) { x.status = 'done'; x.closed = new Date().toISOString(); x.closedBy = stopNow ? 'succeeded' : 'ran'; }
  }, home);
  // A repeating check that hasn't succeeded yet stays quiet: only news is worth a notification.
  // quiet: housekeeping jobs only speak up when something breaks.
  if (!(it.until_success && !ok) && !(it.quiet && ok)) notify(`${ok ? 'Done' : 'Could not finish'}: ${it.what}`, summary.slice(0, 250), home, { news: true });
}

// ---------- the job queue ----------
// One runner at a time works through queued jobs in order. Its lock names its pid and is beaten
// before each job; it is stale once that pid is gone or the beat is older than any job can take.
const JOBS_LOCK = (home) => file(home, 'later-jobs.lock');
const STALE_RUNNER = 40 * 60000; // longer than a job's 25-minute limit
// "Running" left behind by a shutdown: its pid may now be some other program (Windows reuses them),
// so a run older than any job can take is over too.
const runningNow = (it) => alive(it.running.pid) && !(Date.now() - Date.parse(it.running.since || 0) > STALE_RUNNER);
export function jobRunning(home = homeDir()) {
  const p = JOBS_LOCK(home);
  const l = readJson(p, null);
  if (!l) { try { return Date.now() - fs.statSync(p).mtimeMs < 5000; } catch { return false; } } // being written right now
  return alive(l.pid) && Date.now() - new Date(l.beat).getTime() < STALE_RUNNER;
}
const beatJobs = (home, job) => { try { fs.writeFileSync(JOBS_LOCK(home), JSON.stringify({ pid: process.pid, beat: new Date().toISOString(), job })); } catch {} };
function takeJobsLock(home) {
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(JOBS_LOCK(home), JSON.stringify({ pid: process.pid, beat: new Date().toISOString() }), { flag: 'wx' }); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (jobRunning(home)) return false;
    fs.rmSync(JOBS_LOCK(home), { force: true });
  }
  return false;
}

// A job they texted from their phone drives the same Chrome: let it finish (up to 30 min) first.
async function phoneIdle(home, waitMs = 15000) {
  for (let waited = 0; waited < 30 * 60000; waited += waitMs) {
    const b = readJson(file(home, 'phone-listener.json'), null);
    if (!(b?.state === 'working' && alive(b.pid) && Date.now() - new Date(b.beat).getTime() < 150000)) return;
    beatJobs(home, 'waiting for a phone job');
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

export async function runQueue(home = homeDir()) {
  if (!takeJobsLock(home)) return 0;
  const num = (id) => Number(String(id).replace(/\D/g, '')) || 0;
  let ran = 0;
  try {
    for (;;) {
      await phoneIdle(home);
      const next = load(home).items.filter((x) => x.queued).sort((a, b) => String(a.queued).localeCompare(String(b.queued)) || num(a.id) - num(b.id))[0];
      if (!next) break;
      beatJobs(home, next.id);
      const go = update((d) => {
        const x = d.items.find((y) => y.id === next.id);
        if (!x) return false;
        delete x.queued;
        if (x.status !== 'open') return false; // cancelled while it waited
        x.running = { pid: process.pid, since: new Date().toISOString() };
        return true;
      }, home);
      if (!go) continue;
      try { await runJob(next.id, home); ran++; } catch (e) {
        log(home, `job ${next.id} crashed: ${e.message}`);
        notify(`Could not finish: ${next.what}`, e.message.slice(0, 250), home, { news: true });
      } finally {
        update((d) => { const x = d.items.find((y) => y.id === next.id); if (x) delete x.running; }, home);
      }
    }
  } finally {
    try { if (readJson(JOBS_LOCK(home), {}).pid === process.pid) fs.rmSync(JOBS_LOCK(home), { force: true }); } catch {}
  }
  return ran;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const [cmd, arg] = process.argv.slice(2);
  const home = homeDir();
  if (cmd === 'run') await runJob(arg, home);
  else if (cmd === 'run-queue') await runQueue(home);
  else if (cmd === 'test') console.log(notify('Stead reminders are working', 'You will see alerts like this one.', home).join('\n') || 'sent');
  else tick(home);
}
