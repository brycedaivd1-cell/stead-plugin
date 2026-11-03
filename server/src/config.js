// Adding Stead to the person's Claude apps without clobbering anything else in their config.
//   Claude Code:    ~/.claude.json                       mcpServers.stead
//   Claude Desktop: %APPDATA%/Claude/claude_desktop_config.json (Windows)
//                   + the Microsoft Store version's private copy (see desktopConfigPaths)
//                   ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSiteInstall, CURRENT_BIN } from './update.js';

export const CONFIG_PATH = join(homedir(), '.claude.json');

export function desktopConfigPath() {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

const localAppData = () => process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');

// Claude Desktop from the Microsoft Store (MSIX) doesn't read %APPDATA%\Claude: once it has saved a
// setting, it reads its own copy under %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude,
// which hides the real file. init run from a normal Command Prompt wrote only the real one, so Claude
// never saw Stead. Every copy that exists gets the entry, plus the real path for the other installer.
export function desktopConfigPaths() {
  const main = { app: 'Claude Desktop', file: desktopConfigPath() };
  if (process.platform !== 'win32') return [main];
  const pkgs = join(localAppData(), 'Packages');
  let store = [];
  try {
    store = readdirSync(pkgs).filter((d) => /^Claude_/i.test(d))
      .map((d) => join(pkgs, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'))
      .filter((f) => existsSync(dirname(f)))
      .map((file) => ({ app: 'Claude Desktop (Store version)', file }));
  } catch {}
  return [main, ...store];
}

// Is the app on this computer at all? Only for the message: the entry is written either way, so an
// app installed later still finds it.
export function claudeDesktopInstalled() {
  if (desktopConfigPaths().some((p) => existsSync(dirname(p.file)))) return true;
  if (process.platform === 'win32') {
    if (existsSync(join(localAppData(), 'AnthropicClaude'))) return true;
    try { return readdirSync(join(localAppData(), 'Packages')).some((d) => /^Claude_/i.test(d)); } catch { return false; }
  }
  return process.platform === 'darwin' && ['/Applications', join(homedir(), 'Applications')].some((d) => existsSync(join(d, 'Claude.app')));
}
export const claudeCodeInstalled = () => existsSync(CONFIG_PATH) || existsSync(join(homedir(), '.claude'));

// Hand-edited configs: trailing commas and // or /* */ comments are the usual reason JSON.parse
// fails. Drop both (outside strings) so a stray comma doesn't stop setup.
export function looseJson(text) {
  const t = String(text).replace(/^\uFEFF/, '');
  try { return JSON.parse(t); } catch {}
  // Strings are set aside first, so a "//" in a URL or a ", }" inside a value is never touched.
  const strings = [];
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      let j = i + 1;
      while (j < t.length && t[j] !== '"') j += t[j] === '\\' ? 2 : 1;
      out += `"${strings.push(t.slice(i, j + 1)) - 1}"`;
      i = j;
    } else if (c === '/' && t[i + 1] === '/') {
      while (i < t.length && t[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && t[i + 1] === '*') {
      const end = t.indexOf('*/', i + 2);
      i = end === -1 ? t.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/"(\d+)"/g, (_, k) => strings[k]));
}

// ~/.claude.json is rewritten by Claude Code all the time; a half-written copy of it loses every
// project's history. Write a temp file beside it and rename it over (one step); if the rename is
// refused (the file held open on Windows), fall back to writing in place. A file with a second name
// (a hard link, as one test stands in for the Store app's redirect) is written in place: a rename
// would split it into two files.
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    if (statSync(file, { throwIfNoEntry: false })?.nlink > 1) throw new Error('linked');
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch {
    try { unlinkSync(tmp); } catch {}
    writeFileSync(file, text, 'utf8');
  }
}

function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    return looseJson(readFileSync(file, 'utf8'));
  } catch {
    const err = new Error(`${file} is not valid JSON, so it was left untouched.`);
    err.hint = 'Fix or move that file, then run init again.';
    throw err;
  }
}

// The entry runs our own CLI (not @playwright/mcp directly) so preflight, the heal layer, desktop
// and brain all come along. --local points at this checkout instead of the published package.
export function entryFor({ port = 9222, local = false } = {}) {
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'stead.js');
  const args = ['all', ...(port !== 9222 ? ['--port', String(port)] : [])];
  // A browser picked with `init --chrome` has to reach the server Claude starts later.
  const env = process.env.STEAD_CHROME ? { env: { STEAD_CHROME: process.env.STEAD_CHROME } } : {};
  // Run through npx only when this copy came from npx. A global or tarball install (npm i -g
  // stead-x.tgz, before or instead of the npm registry) points at itself, so it works offline and
  // never depends on the registry having this exact version.
  const viaNpx = /[\\/]_npx[\\/]/.test(bin);
  // A site install (setup.ps1) runs through app/current, the junction a self-update moves: the
  // config never names a version folder, so updates need no change here.
  if (!local && isSiteInstall()) return { command: stableNode(), args: [CURRENT_BIN, ...args], ...env };
  if (local || !viaNpx) return { command: stableNode(), args: [bin, ...args], ...env };
  // @latest: every time Claude starts Stead, npx checks for a newer release, so a publish reaches
  // everyone on their next restart (a bare name keeps reusing whatever npx cached first). Offline,
  // npm falls back to the cached copy, so it still starts.
  // npx is npx.cmd on Windows, which Claude can't spawn directly: it needs cmd /c.
  const npx = ['npx', '-y', 'stead-ai@latest', ...args];
  return process.platform === 'win32'
    ? { command: 'cmd', args: ['/c', ...npx], ...env }
    : { command: npx[0], args: npx.slice(1), ...env };
}

// Homebrew runs node from a versioned Cellar folder that `brew upgrade node` deletes; its
// <prefix>/bin/node link survives upgrades.
export function stableNode(exec = process.execPath) {
  const m = exec.match(/^(.*)[\\/]Cellar[\\/]node(@\d+)?[\\/]/);
  if (!m) return exec;
  const link = join(m[1], 'bin', 'node');
  return existsSync(link) ? link : exec;
}

const OLD_OURS = /hands-mcp|bin[\\/]hands\.js|otto-ai|bin[\\/]otto\.js/;

// The first backup is the one that matters (their config from before Stead), so it's never overwritten.
function backup(file) {
  if (!existsSync(file) || existsSync(file + '.stead-backup')) return null;
  copyFileSync(file, file + '.stead-backup');
  return file + '.stead-backup';
}

function merge(file, name, entry, extra = {}) {
  const cfg = readJson(file);
  const made = backup(file);
  if (!existsSync(file)) mkdirSync(dirname(file), { recursive: true });
  cfg.mcpServers = cfg.mcpServers || {};
  // Stead used to be called hands, then Otto: drop our own old entries so Claude doesn't load it
  // twice. Only ours: someone else's server that happens to be named "otto" stays.
  for (const n of ['hands', 'otto']) {
    const old = cfg.mcpServers[n];
    if (n !== name && old && OLD_OURS.test((old.args || []).join(' '))) delete cfg.mcpServers[n];
  }
  const old = cfg.mcpServers[name];
  const existed = Boolean(old);
  // Env they added themselves (STEAD_DEV, a proxy) survives running init again; ours wins on a clash.
  cfg.mcpServers[name] = { ...entry, ...extra, env: { ...old?.env, ...extra.env, ...entry.env } };
  if (!Object.keys(cfg.mcpServers[name].env).length && !('env' in extra)) delete cfg.mcpServers[name].env;
  writeAtomic(file, JSON.stringify(cfg, null, 2));
  return { file, existed, backup: made };
}

// Installs made before 0.5.4 run a bare `npx -y stead-ai`, which keeps reusing npx's first cached
// copy and never updates. Point those entries at @latest, once, so they get every release from now on.
// Only our own entries are touched, and only that one argument. Run by init and doctor, not on every
// server start: Claude Code may be writing ~/.claude.json at that very moment. dryRun only reports.
export function followLatest(files = [CONFIG_PATH, ...desktopConfigPaths().map((p) => p.file)], { dryRun = false } = {}) {
  const changed = [];
  for (const file of files) {
    try {
      if (!existsSync(file)) continue;
      const cfg = looseJson(readFileSync(file, 'utf8'));
      let hit = false;
      for (const e of Object.values(cfg.mcpServers || {})) {
        const i = Array.isArray(e?.args) ? e.args.indexOf('stead-ai') : -1;
        if (i !== -1) { e.args[i] = 'stead-ai@latest'; hit = true; }
      }
      if (hit) { if (!dryRun) writeAtomic(file, JSON.stringify(cfg, null, 2)); changed.push(file); }
    } catch {}
  }
  return changed;
}

// Uninstall: take our entry out of every Claude config, leave everything else in them alone.
export function uninstall({ name = 'stead' } = {}) {
  const out = [];
  for (const p of [{ app: 'Claude Code', file: CONFIG_PATH }, ...desktopConfigPaths()]) {
    if (!existsSync(p.file)) continue;
    try {
      const cfg = readJson(p.file);
      if (!cfg.mcpServers?.[name]) continue;
      delete cfg.mcpServers[name];
      writeAtomic(p.file, JSON.stringify(cfg, null, 2));
      out.push({ ...p, removed: true });
    } catch (e) { out.push({ ...p, error: e.message }); }
  }
  // ChatGPT/Codex: drop our [mcp_servers.<name>] table and its subtables, every other line untouched.
  const toml = codexConfigPath();
  if (existsSync(toml)) {
    try {
      const ours = new RegExp(`^\\s*\\[\\s*mcp_servers\\.("?)${name}\\1\\s*[.\\]]`);
      const chunks = [[]];
      for (const line of readFileSync(toml, 'utf8').split(/\r?\n/)) {
        if (/^\s*\[/.test(line)) chunks.push([]);
        chunks.at(-1).push(line);
      }
      const kept = chunks.filter((c) => !ours.test(c[0]));
      if (kept.length < chunks.length) {
        writeFileSync(toml, kept.flat().join('\n').replace(/\s+$/, '') + '\n', 'utf8');
        out.push({ app: 'ChatGPT / Codex', file: toml, removed: true });
      }
    } catch (e) { out.push({ app: 'ChatGPT / Codex', file: toml, error: e.message }); }
  }
  return out;
}

// The ChatGPT desktop app, Codex CLI and the Codex IDE extension share one MCP config:
// ~/.codex/config.toml, [mcp_servers.<name>]. CODEX_HOME moves it.
export const codexConfigPath = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
export const hasChatGPT = () => existsSync(dirname(codexConfigPath()));

// No TOML library: drop our own [mcp_servers.<name>] table (and its subtables) plus our old
// [mcp_servers.otto] one, append a fresh table, leave every other line exactly as it was.
function mergeToml(file, name, entry) {
  const existed = existsSync(file);
  const text = existed ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : '';
  const made = backup(file);
  if (!existed) mkdirSync(dirname(file), { recursive: true });
  const table = (n, line) => new RegExp(`^\\s*\\[\\s*mcp_servers\\.("?)${n}\\1\\s*[.\\]]`).test(line);
  // Split into [header + its lines] chunks; the first chunk is whatever comes before any header.
  const chunks = [[]];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) chunks.push([]);
    chunks.at(-1).push(line);
  }
  let found = false;
  const kept = chunks.filter((c) => {
    if (table(name, c[0])) return !(found = true);
    // An old Otto table (and its subtables) goes only if it really ran our package.
    if (name !== 'otto' && table('otto', c[0])) {
      const all = chunks.filter((d) => table('otto', d[0])).flat().join('\n');
      return !OLD_OURS.test(all);
    }
    return true;
  }).flat();
  const str = (s) => JSON.stringify(String(s));
  const block = [
    `[mcp_servers.${name}]`,
    `command = ${str(entry.command)}`,
    `args = [${entry.args.map(str).join(', ')}]`,
    ...(entry.env ? [`env = { ${Object.entries(entry.env).map(([k, v]) => `${k} = ${str(v)}`).join(', ')} }`] : []),
    // Cold starts (npx download, Chrome launch) and slow pages need more than the defaults.
    'startup_timeout_sec = 60',
    'tool_timeout_sec = 120',
  ];
  const body = kept.join('\n').replace(/\s+$/, '');
  writeFileSync(file, (body ? body + '\n\n' : '') + block.join('\n') + '\n', 'utf8');
  return { file, existed: found, backup: made };
}

// Two paths can be one file (inside the Store app's container the redirect makes them the same),
// so a file already written is skipped by identity, not by name.
const fileId = (f) => { try { const s = statSync(f, { bigint: true }); return s.ino ? `${s.dev}:${s.ino}` : null; } catch { return null; } };

// One result per config file. A file that can't be read is skipped ({ error, hint }) and the rest
// still get set up, so one broken config never leaves setup half done.
export function install({ name = 'stead', port = 9222, local = false, code = true, desktop = true, chatgpt = false } = {}) {
  const entry = entryFor({ port, local });
  const jobs = [];
  // Cold starts and slow pages blow past Claude Code's default tool timeout.
  if (code) jobs.push({ app: 'Claude Code', file: CONFIG_PATH, installed: claudeCodeInstalled(), run: () => merge(CONFIG_PATH, name, entry, { type: 'stdio', env: {}, timeout: 120000 }) });
  if (desktop) {
    const installed = claudeDesktopInstalled();
    for (const p of desktopConfigPaths()) jobs.push({ ...p, installed, run: () => merge(p.file, name, entry) });
  }
  if (chatgpt) jobs.push({ app: 'ChatGPT desktop + Codex', file: codexConfigPath(), installed: true, run: () => mergeToml(codexConfigPath(), name, entry) });
  const out = [];
  const seen = new Set();
  for (const { run, ...job } of jobs) {
    const id = fileId(job.file);
    if (id && seen.has(id)) continue;
    try {
      out.push({ ...job, ...run() });
    } catch (e) {
      out.push({ ...job, error: e.message, hint: e.hint });
    }
    const after = fileId(job.file);
    if (after) seen.add(after);
  }
  return out;
}

// Is Stead in this config, and does the program it runs still exist? For doctor and report.
export function entryState(file, name = 'stead') {
  if (!existsSync(file)) return { state: 'missing-file' };
  let cfg;
  try { cfg = looseJson(readFileSync(file, 'utf8')); } catch { return { state: 'broken' }; }
  const e = cfg.mcpServers?.[name];
  if (!e) return { state: 'absent' };
  // node <bin> entries break when that node or that copy of Stead is gone (an old nvm version,
  // a deleted checkout); npx and cmd entries resolve at start, so only those two are checked.
  const gone = [e.command, e.args?.[0]].find((p) => typeof p === 'string' && /^([a-zA-Z]:)?[\\/]/.test(p) && !existsSync(p));
  return gone ? { state: 'stale', missing: gone, entry: e } : { state: 'ok', entry: e };
}
