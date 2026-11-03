// Safety layer around every tool call. Everything here is enforced in code, so it holds even if
// Claude is confused or a web page tries to talk it into something.
//   - consent: nothing that acts on the computer runs until the person has accepted the terms
//   - pause:   `stead pause` (or PAUSED in its folder) stops every acting tool instantly
//   - log:     every action is written to activity.log in its folder, which they can read any time
//   - held:    irreversible or dangerous commands need their yes, relayed by Claude
//   - fenced:  system folders, credential stores and the everyday browser profile are off limits
//   - secret:  passwords, keys and browser logins are never read, uploaded or sent anywhere
//   - guarded: files that decide what AI apps may do, or what runs at startup, need their yes to change
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME_DIR, BRAIN_DIR, termsAcceptedByEnv } from './paths.js';

export const HANDS_DIR = HOME_DIR; // old name, kept for hands-home
export const TERMS_VERSION = '2026-09-26';
const CONSENT = path.join(HANDS_DIR, 'consent.json');
const PAUSED = path.join(HANDS_DIR, 'PAUSED');
const LOG = path.join(HANDS_DIR, 'activity.log');
const WIN = process.platform === 'win32';

// Tools that only look (never change anything) stay available even when paused or before consent,
// so Claude can still explain what's going on.
const READ_ONLY = /^(browser_(snapshot|take_screenshot|console_messages|network_requests?|find|wait_for)|brain_(recall|search|read)|setup_check|desktop_(windows|read|read_text|find|screenshot)|clipboard_read|file_read|toolbox_list|later_list)$/;

export function hasConsent() {
  if (termsAcceptedByEnv()) return true;
  try { return JSON.parse(fs.readFileSync(CONSENT, 'utf8')).version === TERMS_VERSION; } catch { return false; }
}
export function recordConsent(how) {
  fs.mkdirSync(HANDS_DIR, { recursive: true });
  fs.writeFileSync(CONSENT, JSON.stringify({ version: TERMS_VERSION, acceptedAt: new Date().toISOString(), how }, null, 2));
}
export const isPaused = () => fs.existsSync(PAUSED);
export function setPaused(on) {
  fs.mkdirSync(HANDS_DIR, { recursive: true });
  if (on) fs.writeFileSync(PAUSED, `Paused ${new Date().toISOString()}. Delete this file or run "stead resume" to continue.\n`);
  else fs.rmSync(PAUSED, { force: true });
}

// One line per action: when, which tool, a short summary of what, and how it ended.
// Values that look like secrets are masked before they ever touch the disk.
const mask = (s) => String(s).replace(/\b(?:\d[ -]?){13,19}\b/g, '[number]').replace(/(password|passcode|token|secret)\S*\s*[:=]\s*\S+/gi, '$1=[hidden]');
export function logAction(name, args, outcome) {
  try {
    fs.mkdirSync(HANDS_DIR, { recursive: true });
    const what = args?.command || args?.url || args?.path || args?.element || args?.target || args?.file || args?.name || args?.text || '';
    fs.appendFileSync(LOG, `${new Date().toISOString()}  ${name.padEnd(22)} ${outcome.padEnd(8)} ${mask(String(what).replace(/\s+/g, ' ')).slice(0, 240)}\n`);
  } catch {}
}

// ---------- where a path really points ----------
// A path is judged as the file system sees it, not as typed: an 8.3 short name (SSH~1), a \\?\
// prefix, a junction or a symlink reaches the same folder as the long name, so it must get the
// same answer. realpath only works on what exists, so resolve the deepest folder that does and
// put the rest back. Lowercase with forward slashes, so one rule fits Windows, Mac and Linux.
// \\?\Volume{guid}\ is a drive by another name: which one, from mountvol, asked once.
let volumes = null;
const volumeDrive = (guid) => {
  if (!volumes) {
    volumes = new Map();
    const r = WIN ? spawnSync('mountvol', [], { encoding: 'utf8', windowsHide: true, timeout: 5000 }) : null;
    let vol = null;
    for (const line of String(r?.stdout || '').split(/\r?\n/)) {
      const v = line.match(/\\\\\?\\Volume\{([0-9a-f-]+)\}\\/i);
      if (v) { vol = v[1].toLowerCase(); continue; }
      const d = line.match(/^\s+([A-Z]:\\)\s*$/i);
      if (d && vol) { volumes.set(vol, d[1]); vol = null; }
    }
  }
  return volumes.get(String(guid).toLowerCase()) || null;
};

export function canonical(p) {
  let s0 = String(p);
  // A device path: the volume's drive letter, or else somewhere every write is refused (the
  // Windows folder), so no rule can be walked around by spelling a path this way.
  const dev = s0.match(/^[\\/]{2}[?.][\\/](?:volume\{([0-9a-f-]+)\}|(globalroot|device|harddisk|physicaldrive|pipe)[^\\/]*)[\\/]?(.*)$/i);
  if (dev) {
    const drive = dev[1] && volumeDrive(dev[1]);
    s0 = drive ? drive + dev[3] : path.join(process.env.SystemRoot || 'C:\\Windows', 'stead-device-path', dev[3] || '');
  }
  const s = s0.replace(/^\\\\[?.]\\unc\\/i, '\\\\').replace(/^\\\\[?.]\\/, '');
  // A network path is never looked up: a server that's offline would stall every check for half a
  // minute. An admin share (\\pc\c$\Windows) is that drive's own folder, so it's judged as one.
  if (/^[\\/]{2}[^\\/]/.test(s)) return path.win32.normalize(s).replace(/\\/g, '/').toLowerCase().replace(/^\/\/[^/]+\/([a-z])\$(?=\/|$)/, '$1:');
  let abs = path.resolve(s);
  if (WIN) {
    // Windows drops trailing dots and spaces from a name, and "x::$DATA" is the file x itself.
    const root = path.parse(abs).root;
    abs = root + abs.slice(root.length).replace(/:[^\\/]*/g, '').replace(/[. ]+(?=[\\/]|$)/g, '');
  }
  let cur = abs;
  let tail = '';
  for (;;) {
    try { abs = tail ? path.join(fs.realpathSync.native(cur), tail) : fs.realpathSync.native(cur); break; } catch {}
    const up = path.dirname(cur);
    if (up === cur) break;
    tail = tail ? path.join(path.basename(cur), tail) : path.basename(cur);
    cur = up;
  }
  return abs.replace(/\\/g, '/').toLowerCase();
}
// Stead's own files, worked out once its folder exists (every command check asks about them).
const steadFiles = new Map();
const steadFile = (name) => {
  if (steadFiles.has(name)) return steadFiles.get(name);
  const c = canonical(path.join(HANDS_DIR, name));
  if (fs.existsSync(HANDS_DIR)) steadFiles.set(name, c);
  return c;
};

// Passwords, keys and logged-in sessions: never read, uploaded, texted or written. A web page that
// talks Claude into reading one of these could send it anywhere, so the answer is always no.
const SECRET = [
  /(^|\/)\.(ssh|aws|azure|gnupg)(\/|$)/, /(^|\/)\.config\/gcloud(\/|$)/, /(^|\/)\.kube\/config$/, /(^|\/)\.docker\/config\.json$/,
  /(^|\/)(\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc)$/,
  /(^|\/)\.claude\/\.credentials\.json$/, /(^|\/)\.codex\/auth\.json$/,
  // everyday browsers' profiles (saved passwords, cookies, history) and Stead's own logged-in one
  /\/appdata\/local\/(google\/chrome[^/]*|microsoft\/edge[^/]*|bravesoftware\/brave-browser[^/]*|vivaldi|chromium)\/user data(\/|$)/,
  /\/appdata\/roaming\/(mozilla|opera software)(\/|$)/,
  /\/library\/application support\/(google\/chrome[^/]*|microsoft edge[^/]*|bravesoftware|firefox|arc|vivaldi|chromium)(\/|$)/,
  /(^|\/)\.config\/(google-chrome[^/]*|chromium|microsoft-edge[^/]*|bravesoftware|vivaldi)(\/|$)/, /(^|\/)\.mozilla(\/|$)/,
  /(^|\/)\.(hands|otto|stead)-profile[^/]*(\/|$)/,
  // the Claude app's own login (cookies, tokens); its config file is guarded below and its logs are fine
  /\/appdata\/roaming\/claude\/(?!claude_desktop_config\.json$|logs(\/|$))/,
  /\/appdata\/local\/packages\/claude_[^/]*\/localcache\/roaming\/claude\/(?!claude_desktop_config\.json$|logs(\/|$))/,
  /\/library\/application support\/claude\/(?!claude_desktop_config\.json$|logs(\/|$))/,
  // the operating system's own password stores
  /\/appdata\/(roaming|local)\/microsoft\/(credentials|protect|vault)(\/|$)/, /\/library\/keychains(\/|$)/,
  // Stead's license and the phone bot's token
  /\/\.(hands|otto|stead)\/(license\.key|phone(-pairing)?\.json)$/,
];
const SECRET_FILES = ['license.key', 'phone.json', 'phone-pairing.json'];

// System folders and Stead's own controls (consent, pause, log, standing grants, their permission
// choices, the undo journal, the trigger watcher's state): never written by a tool. Stead's own code
// writes them directly.
const SYSTEM = [
  /^[a-z]:\/windows(\/|$)/, /^[a-z]:\/program files( \(x86\))?(\/|$)/, /^[a-z]:\/programdata(\/|$)/,
  /\/\.(hands|otto|stead)\/(consent\.json|activity\.log|paused|grants\.json|permissions\.json|watch-state\.json)$/,
  /\/\.(hands|otto|stead)\/undo(\/|$)/,
];
// A name ending in / is a folder: everything in it counts.
const CONTROL_FILES = ['consent.json', 'activity.log', 'PAUSED', 'grants.json', 'permissions.json', 'watch-state.json', 'undo/'];
const isControl = (abs) => CONTROL_FILES.some((f) => (f.endsWith('/') ? (abs === steadFile(f.slice(0, -1)) || abs.startsWith(steadFile(f.slice(0, -1)) + '/')) : abs === steadFile(f)));

// Files that decide what AI apps may do, or what runs by itself: changing one needs their yes.
// writeOnly: only file_write is held there (toolbox_run runs those tools through computer_command).
// Stead's own scheduler and phone listener are copied into its folder and started every minute by
// the computer, with nobody watching: rewriting one would run anything, forever.
// settings.json too: the runner runs its notify_command and passes its claude_env to every job.
const SELF_RUNNING = ['later-tick.mjs', 'later-tick.vbs', 'phone.mjs', 'watch.mjs', 'attention.mjs', 'onscreen/attention.js', 'later.json', 'later-scheduler.json', 'server-entry.json', 'settings.json'];
// Stead's own code: the scheduler is copied from here and runs with nobody watching, and the rules
// in this file are what hold everything else.
const PACKAGE = (() => { try { return canonical(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')); } catch { return null; } })();
const GUARDED = [
  { why: 'controls what Claude and other AI apps are allowed to do', re: /(^|\/)\.claude\/settings(\.local)?\.json$|(^|\/)\.claude\.json$|\/claude_desktop_config\.json$|(^|\/)\.codex\/config\.toml$|(^|\/)\.cursor\/mcp\.json$/ },
  { why: 'runs by itself whenever the computer starts or a terminal opens', re: /\/start menu\/programs\/startup(\/|$)|\/library\/launch(agents|daemons)(\/|$)|(^|\/)\.config\/autostart(\/|$)|\/documents\/(windows)?powershell\/[^/]*profile\.ps1$|(^|\/)\.(bashrc|bash_profile|zshrc|zprofile|zshenv|profile)$/ },
  { why: 'runs by itself on a schedule, with nobody watching', test: (abs) => SELF_RUNNING.some((f) => abs === steadFile(f)) },
  { why: "is Stead's own code, which runs by itself with nobody watching", writeOnly: true, test: (abs) => !!PACKAGE && (abs === PACKAGE || abs.startsWith(PACKAGE + '/')) && !/\/node_modules\/(?!stead-ai\/)/.test(abs.slice(PACKAGE.length)) },
  { why: "is one of Stead's saved tools (change those with toolbox_save)", writeOnly: true, test: (abs) => abs.startsWith(steadFile('tools') + '/') },
  // The undo journal: undo copies a kept file back to the path its entry names, so a planted entry
  // would write anything anywhere. Only computer.js writes it, directly; tools and commands ask.
  { why: "is Stead's undo journal, which undo copies back over their files", test: (abs) => abs === steadFile('undo') || abs.startsWith(steadFile('undo') + '/') },
  // Standing grants let held steps go ahead without asking, and the watcher's state decides which
  // triggers fire: a command that writes either would hand out a yes nobody gave.
  { why: 'lets Stead go ahead without asking them (standing grants, their permission choices, trigger state)', test: (abs) => ['grants.json', 'permissions.json', 'watch-state.json'].some((f) => abs === steadFile(f)) },
  // Rules and lessons are read at the start of every task as standing orders. brain_save asks
  // before changing them; writing the file directly must not be the way around that.
  { why: 'holds their standing rules and lessons, which every later task follows', test: (abs) => ['rules.md', 'lessons.md'].some((f) => abs === canonical(path.join(BRAIN_DIR, f))) },
];

const hits = (abs, list) => list.some((re) => re.test(abs));

// Never read, uploaded or sent: passwords, keys, browser logins.
const isSecret = (abs) => hits(abs, SECRET) || SECRET_FILES.some((f) => abs === steadFile(f));
export const secretPath = (p) => isSecret(canonical(p));

// Places file_write must never touch, and files never uploaded or sent, whatever it's told.
export function fencedPath(p) {
  const abs = canonical(p);
  if (hits(abs, SYSTEM) || isSecret(abs) || isControl(abs)) return true;
  const home = canonical(os.homedir());
  return /^\/(etc|usr|bin|sbin|system|library|private\/etc)\//.test(abs) && !abs.startsWith(home + '/');
}

// Why writing this file needs the person's yes, or null when it doesn't.
export function guardedReason(p, { command = false } = {}) {
  return guardOf(canonical(p), command);
}
function guardOf(abs, command) {
  const g = GUARDED.find((x) => !(command && x.writeOnly) && (x.re ? x.re.test(abs) : x.test(abs)));
  return g ? g.why : null;
}

// ---------- commands that need the person's yes ----------
// Text rules can't be airtight (a determined attacker can spell a command a hundred ways); they are
// there to stop a confused Claude and the usual tricks a web page or email might try.
// The command word itself: not docker's --rm, fs.rm, a folder called "del" or a file "rm-notes".
const RM = String.raw`(?<![\w$.\-\\/*])(?:\/(?:usr\/)?bin\/)?(Remove-Item|rm|del|erase|rd|rmdir|ri)\b(?![-.])`;
const EXE = /\.(exe|msi|msix|appx|ps1|bat|cmd|vbs|vbe|js|mjs|cjs|jar|py|sh|scr|com|dmg|pkg)$/i;

// "Download a file, then run it" in one command: the downloaded file's name shows up again later.
function downloadsThenRuns(command) {
  const targets = [...command.matchAll(/(?:-OutFile|-Destination|\s-o|\s--output)\s+(['"]?)([^'"\s;|&]+)\1|DownloadFile\(\s*['"][^'"]+['"]\s*,\s*['"]?([^'")]+)/gi)]
    .map((m) => (m[2] || m[3] || '').trim()).filter((t) => EXE.test(t));
  return targets.some((t) => {
    const after = command.slice(command.indexOf(t) + t.length);
    const name = t.split(/[\\/]/).pop();
    return /(;|&&|\|\||\n)/.test(after) && after.toLowerCase().includes(name.toLowerCase());
  }) && /\b(iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|DownloadFile)\b/i.test(command);
}

// A delete aimed at a whole drive, the home folder or one of its big folders, even without -Recurse:
// "Remove-Item C:" tries to delete the folder the command is standing in (measured: it went for
// C:\Users\<name> and only stopped because the folder was in use).
const BIG_FOLDERS = /^(desktop|documents|downloads|pictures|music|videos|onedrive[^\\/]*|appdata)$/i;
function deletesSomethingBig(command) {
  for (const m of command.matchAll(new RegExp(`${RM}([^|;&\\n]*)`, 'gi'))) {
    const targets = (m[2].match(/'[^']*'|"[^"]*"|[^\s,]+/g) || []).map((t) => t.replace(/^['"]|['"]$/g, '')).filter((t) => t && !/^[-/]/.test(t));
    for (const raw of targets) {
      const t = fillIn(raw);
      if (/^[a-z]:[\\/]?$/i.test(t) || /^(\.|\.\.|~|\/|\\)[\\/]?$/.test(t)) return true;
      const abs = path.resolve(os.homedir(), t).replace(/[\\/]+$/, '').toLowerCase();
      const home = os.homedir().toLowerCase();
      if (abs === home || abs === path.dirname(home) || (path.dirname(abs) === home && BIG_FOLDERS.test(path.basename(abs)))) return true;
    }
  }
  return false;
}

const HELD = [
  ['cannot be undone', [
    deletesSomethingBig,
    new RegExp(String.raw`${RM}([^|;&\n]*\s(-r(e(c(u(r(se?)?)?)?)?)?\b|-[fdiv]*r[fdiv]*\b|--recursive\b)|([^|;&\n]*\s|(?<=\b(rd|rmdir)))\/s\b)`, 'i'), // recursive delete, any spelling (cmd takes rd/s/q with no spaces)
    new RegExp(String.raw`(\||\bxargs\s+(-\S+\s+)*)\s*${RM}`, 'i'), // whatever a pipeline hands it
    new RegExp(String.raw`(ForEach-Object\b|%|foreach\b)[^|;\n]*\{[^}]*${RM}`, 'i'), // in a loop
    new RegExp(String.raw`(?<![\w$.*-])(Remove-Item|rm|del|erase|ri)\b[^|;&\n]*\*`, 'i'), // wildcards
    // Deleting file by file: .Delete() on each file in a loop or pipeline, or on a whole collection.
    /(\||ForEach-Object\b|foreach\b)[^;\n]*\.Delete\(|\)\.Delete\(\s*\)|(\||^|;)\s*(%|ForEach-Object)\s+Delete\b|(ForEach-Object\b|%|foreach\b)[^;\n]*\{[^}]*\[(System\.)?IO\.File\]::Delete/im,
    // robocopy /MIR and /PURGE delete whatever the source doesn't have; emptying files in bulk.
    /\brobocopy\b[^\n]*\s\/(mir|purge)\b|\|\s*Clear-Content\b/i,
    /-exec\s+rm\b|\bfind\b[^|;&\n]*\s-delete\b|\[(System\.)?IO\.Directory\]::Delete\b|\.Delete\(\s*\$true\s*\)|FileSystem\]::DeleteDirectory\b|shutil\.rmtree|\brm(dir)?(Sync)?\([^)]*recursive\s*:\s*true/i,
    /\bformat\s+[a-z]:|\bdiskpart\b|Clear-Disk|Initialize-Disk|Format-Volume|\breg\s+delete\b|Remove-ItemProperty\b|Clear-RecycleBin|\bcipher\s+\/w|\bbcdedit\b/i,
    /\bgit\s+push\b[^|;&\n]*(\s-f\b|\s--force|\s\+\S)|\bgit\s+reset\s+--hard|\bgit\s+clean\b[^|;&\n]*\s-(-force|[a-z]*f)/i,
    /\bshutdown\b|Stop-Computer|Restart-Computer/i,
  ]],
  ['runs code downloaded from the internet', [
    /(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b[^\n]*\|\s*(iex|Invoke-Expression|sh|bash|powershell|pwsh)\b|\bIEX\s*\(|Invoke-Expression|\|\s*iex\b|DownloadString|DownloadFile[^\n]*;\s*(Start-Process|&)|bitsadmin/i,
    /\bmshta\b|\bregsvr32\b[^\n]*\/i:|\brundll32\b[^\n]*javascript:|\bcertutil\b[^\n]*-urlcache/i,
    downloadsThenRuns,
  ]],
  // A hidden PowerShell or cmd window, not a hidden app or server (Start-Process node ... -WindowStyle Hidden).
  ['hides what it does', [/\s-(e|ec|en[a-z]*)\s+['"]?[A-Za-z0-9+/=]{20,}|FromBase64String|\b(powershell|pwsh|cmd)(\.exe)?['"]?\s[^\n|;]*-w[a-z]*\s+['"]?h(i(d(d(en?)?)?)?)?\b/i]],
  ['turns off the computer\'s protection', [/Set-MpPreference\b[^\n]*-Disable|Add-MpPreference\b[^\n]*-Exclusion|netsh\b[^\n]*(firewall|advfirewall)[^\n]*(off|disable)|Set-NetFirewallProfile\b[^\n]*-Enabled\s+False|EnableLUA|Set-ExecutionPolicy\s+(Unrestricted|Bypass)\b[^\n]*-Scope\s+LocalMachine|vssadmin\b[^\n]*delete|wbadmin\b[^\n]*delete/i]],
  ['touches passwords or saved logins', [/cmdkey|vaultcmd|Get-StoredCredential|Login Data|(Chrome|Edge|Brave-Browser)[\\/]User Data|Web Data|Local State|\.ssh\b|\bid_(rsa|dsa|ecdsa|ed25519)\b|\.aws[\\/]|\.azure[\\/]|\.config[\\/]gcloud|\.credentials\.json|\.git-credentials|\.netrc\b|Keychains|security\s+(find|dump)-\w*password|Microsoft[\\/](Credentials|Protect)|Get-Credential/i]],
  // A saved tool marked "overrides: built-in" takes the place of one of Stead's own tools; only
  // toolbox_save may add that mark, after the person's own yes.
  ['replaces one of Stead\'s built-in tools', [/overrides:\s*built-in/i]],
  ['changes what runs at startup or what AI apps may do', [/Start Menu[\\/]Programs[\\/]Startup|shell:startup|Launch(Agents|Daemons)|CurrentVersion[\\/]Run(Once)?\b|Register-ScheduledTask|schtasks(\.exe)?\s+\/create|New-Service\b|\bsc(\.exe)?\s+create\b|crontab\s+(?!-l)|\.claude[\\/]settings|\.claude\.json|claude_desktop_config|\.codex[\\/]config\.toml/i]],
];
const ruleHit = (text) => HELD.find(([, tests]) => tests.some((t) => (typeof t === 'function' ? t(text) : t.test(text))))?.[0] || null;

// Paths named in a command, with ~ and the usual variables filled in, so a short name or a junction
// to a protected file is caught by where it leads, not by how it's spelled.
const VARS = { home: () => os.homedir(), userprofile: () => os.homedir(), temp: () => os.tmpdir(), tmp: () => os.tmpdir() };
const fillIn = (raw) => raw.replace(/^~(?=$|[\\/])/, os.homedir())
  .replace(/\$\{?(?:env:)?(\w+)\}?|%(\w+)%/gi, (all, a, b) => VARS[(a || b).toLowerCase()]?.() ?? process.env[a || b] ?? all);
const unquote = (m) => (m[1] != null ? m[1].replace(/''/g, "'") : (m[2] ?? m[3]));
function pathsIn(command) {
  // Commands start in the home folder, but "cd Desktop; .\clean.ps1" runs Desktop\clean.ps1:
  // a relative name is tried from every folder the command moves to.
  const bases = [os.homedir()];
  for (const m of command.matchAll(/(?:^|[;&|\n{(]\s*)(?:cd|chdir|Set-Location|sl|Push-Location|pushd)\s+(?:-(?:Literal)?Path\s+)?(?:'((?:[^'\n]|'')+)'|"([^"\n]+)"|([^\s'";|&)}]+))/gi)) {
    const d = fillIn(unquote(m));
    if (!/[$%]/.test(d) && bases.length < 6) bases.push(path.resolve(bases.at(-1), d));
  }
  const out = [];
  for (const m of command.matchAll(/'((?:[^'\n]|'')+)'|"([^"\n]+)"|([^\s'"|;&(){}<>,]+)/g)) {
    const raw = unquote(m);
    if (!(/[\\/]/.test(raw) || SCRIPT.test(raw)) || /^[a-z]+:\/\//i.test(raw) || raw.length > 400) continue;
    const t = fillIn(raw);
    if (/[$%]/.test(t)) continue;
    for (const b of path.isAbsolute(t) ? [os.homedir()] : bases) out.push(path.resolve(b, t));
    if (out.length > 200) break;
  }
  return out;
}

const SCRIPT = /\.(ps1|psm1|bat|cmd|vbs|vbe|js|mjs|cjs|py|pyw|sh|bash|zsh|command)$/i;
const readScript = (f) => {
  try {
    if (!fs.statSync(f).isFile() || fs.statSync(f).size > 2e6) return null;
    const b = fs.readFileSync(f);
    return b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8');
  } catch { return null; }
};

function reasonFor(command, depth, seen) {
  const direct = ruleHit(command);
  if (direct) return direct;
  for (const f of pathsIn(command)) {
    let key;
    try { key = canonical(f); } catch { continue; }
    if (isSecret(key)) return 'touches passwords or saved logins';
    const g = guardOf(key, true);
    if (g) return `touches a file that ${g}`;
    // A command that runs a script is judged by what the script says, not just its name: otherwise
    // "save it as cleanup.ps1, then run cleanup.ps1" walks around every rule above.
    if (SCRIPT.test(f) && depth < 3 && !seen.has(key) && !key.startsWith('//')) {
      seen.add(key);
      const body = readScript(f);
      const inner = body && reasonFor(body, depth + 1, seen);
      if (inner) return `runs ${path.basename(f)}, a script that ${inner.replace(/^runs [^,]+, a script that /, '')}`;
    }
  }
  return null;
}

// The script files a command runs (and the scripts those run), as they are spelled on disk, so a
// scheduled job can be refused when one changed after it was checked.
export function scriptsIn(command, depth = 0, seen = new Set(), out = []) {
  for (const f of pathsIn(String(command ?? ''))) {
    if (!SCRIPT.test(f) || depth >= 3) continue;
    let key;
    try { key = canonical(f); } catch { continue; }
    if (seen.has(key) || key.startsWith('//')) continue;
    const body = readScript(f);
    if (body == null) continue;
    seen.add(key);
    out.push(f);
    scriptsIn(body, depth + 1, seen, out);
  }
  return out;
}

export function heldReason(command) {
  try { return reasonFor(String(command ?? ''), 0, new Set()); } catch { return ruleHit(String(command ?? '')); }
}

// For opening or running a file directly (not through a command): what the script would do.
export function fileHeldReason(file) {
  if (!SCRIPT.test(String(file))) return null;
  const body = readScript(path.resolve(String(file)));
  return body ? heldReason(body) : null;
}

// browser_tabs lists and closes: only the list is a look. Closing a tab is acting (it can lose their work).
export const isReadOnly = (name, args = {}) => READ_ONLY.test(name) || (name === 'browser_tabs' && (args?.action || 'list') === 'list');
