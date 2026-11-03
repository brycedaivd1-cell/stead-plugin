// Health checks for the two failures that make Stead look broken for no reason, plus the setup
// checks (setupChecks, serverStarts) that catch what breaks a first install silently.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe, profileDir, findChrome } from './chrome.js';
import { CONFIG_PATH, desktopConfigPaths, codexConfigPath, entryState } from './config.js';
import { status as windowStatus } from './window.js';

const run = promisify(execFile);

// Every browser process (Chrome, Edge or Brave) whose command line mentions this profile directory.
// Heavy session churn leaves these piling up — 18 processes for 3 open tabs was
// the real cause of Playwright hanging on "visible, enabled and stable" forever.
// They starve the renderer of CPU until frame-stability checks never resolve.
// Matched on the exact --user-data-dir, never a substring: ".stead-profile" is inside
// ".stead-profile-personal", and `doctor --fix` killed the person's other Chrome (with their logins
// and unsaved work) because of it. A command line that can't be read for sure is left alone.
const samePath = (a, b) => {
  const n = (p) => resolve(String(p).replace(/[\\/]+$/, ''));
  return platform() === 'win32' || platform() === 'darwin' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
export function usesProfile(cmdline, dir) {
  const at = String(cmdline || '').search(/--user-data-dir=/i);
  if (at < 0) return false;
  const rest = cmdline.slice(at + '--user-data-dir='.length);
  // Node quotes a whole argument with a space ("--user-data-dir=C:\John Smith\x"); others quote the
  // value; ps shows it bare. Try each way the value can end; any exact hit is it.
  const v = rest.startsWith('"') ? [rest.slice(1).split('"')[0]] : [rest.split('"')[0], rest.split(/\s/)[0], rest.split(/\s+--/)[0].trimEnd()];
  return v.some((x) => x && samePath(x, dir));
}

export async function chromeProcs(profileDirPath) {
  const dir = String(profileDirPath);
  try {
    let rows;
    if (platform() === 'win32') {
      const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe'" | Where-Object { $_.CommandLine } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`;
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
      rows = stdout.split(/\r?\n/);
    } else {
      const { stdout } = await run('ps', ['ax', '-o', 'pid=,command='], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
      rows = stdout.split('\n');
    }
    return rows.map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter((m) => m && usesProfile(m[2], dir)).map((m) => Number(m[1]));
  } catch {
    return [];
  }
}

export async function killProcs(pids) {
  if (!pids.length) return 0;
  try {
    if (platform() === 'win32') {
      await run('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue`], { timeout: 20000 });
    } else {
      await run('/bin/sh', ['-c', `kill -9 ${pids.join(' ')} 2>/dev/null || true`], { timeout: 20000 });
    }
    return pids.length;
  } catch {
    return 0;
  }
}

// A wedged blank tab sitting at index 0 makes every navigate throw
// "Frame has been detached" — the page looks fine, the whole server looks dead.
export async function pages(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) return [];
    const all = await res.json();
    return all.filter((p) => p.type === 'page');
  } catch {
    return [];
  }
}

async function closePage(port, id) {
  try { await fetch(`http://127.0.0.1:${port}/json/close/${id}`); } catch {}
}

// fix: false = report only; 'tabs' = close wedged blank tabs only (safe, used by serve);
// true = tabs AND kill runaway processes (destructive — only from an explicit `doctor --fix`).
export async function diagnose({ port = 9222, profileMarker = profileDir(), fix = false } = {}) {
  const report = { port, up: false, tabs: 0, wedged: [], procs: 0, actions: [], warnings: [], ok: true };

  const version = await probe(port);
  if (!version) {
    report.ok = false;
    report.problem = `Nothing is listening on port ${port}.`;
    report.hint = 'Start it with: npx stead-ai launch   (on a new computer: npx stead-ai init)';
    return report;
  }
  report.up = true;
  report.browser = version.Browser;

  const open = await pages(port);
  report.tabs = open.length;
  const isBlank = (p) => !p.url || p.url === 'about:blank' || p.url === 'chrome://newtab/';
  // A blank tab is only "wedged" when there are real tabs beside it. A freshly launched
  // browser has exactly one blank tab, and closing Chrome's last tab exits Chrome — so
  // the self-heal would kill the browser it just started. Leave a lone blank tab alone.
  const real = open.filter((p) => !isBlank(p));
  report.wedged = real.length ? open.filter(isBlank) : [];

  const procs = await chromeProcs(profileMarker);
  report.procs = procs.length;
  // Something answers on the port, but no browser runs with Stead's profile: another program
  // (a developer tool, another browser add-on) holds the port, and Claude would drive that instead.
  if (!procs.length) report.warnings.push(`The browser on port ${port} isn't using Stead's profile (${basename(String(profileMarker))}). Another program may be using that port: close it, or set Stead up on another one with npx stead-ai init --port 9333`);

  // Chrome normally runs ~5 base processes (browser, GPU, network, storage, crashpad)
  // plus ~3 per tab. 5 tabs at 14-20 processes is HEALTHY. 2026-09-06 the old threshold
  // (12) flagged exactly that and the auto-reaper killed a live browser mid-login.
  // Only flag genuine churn: several times the normal count.
  const normal = 5 + report.tabs * 3;
  const bloated = procs.length > Math.max(40, normal * 3);

  if (report.wedged.length) {
    report.ok = false;
    if (fix === true || fix === 'tabs') {
      for (const p of report.wedged) await closePage(port, p.id);
      report.actions.push(`closed ${report.wedged.length} blank/wedged tab(s)`);
    }
  }
  if (bloated) {
    report.ok = false;
    report.problem = `${procs.length} browser processes for ${report.tabs} tab(s) — renderer starvation likely.`;
    report.hint = 'Run npx stead-ai doctor --fix to close them, then npx stead-ai launch to come back clean.';
    if (fix === true) {
      const n = await killProcs(procs);
      report.actions.push(`killed ${n} browser process(es): run npx stead-ai launch to restart clean`);
    }
  }
  return report;
}

// ---- setup: the silent failures of a first install, each with one plain fix line ----

export const NODE_MIN = 20; // Playwright exits on anything older
export const nodeMajor = (v = process.versions.node) => Number(String(v).split('.')[0]);

// Claude Desktop extensions (the .mcpb) live in their own folder, not in the config file.
function desktopExtension(file) {
  try { return fs.readdirSync(join(dirname(file), 'Claude Extensions')).some((d) => /stead/i.test(d)); } catch { return false; }
}

// [{ ok, text, fix? }]: ok true, false (a problem, with the line that fixes it), or null (just
// information). Cheap (no browser start), so setup_check can run it too.
export async function setupChecks({ name = 'stead', port = 9222, dir = profileDir(), node = process.versions.node } = {}) {
  const { hasConsent, isPaused } = await import('./safety.js');
  const out = [];
  const add = (ok, text, fix) => out.push({ ok, text, ...(fix && ok === false ? { fix } : {}) });

  add(nodeMajor(node) >= NODE_MIN, `Node.js ${node}${nodeMajor(node) >= NODE_MIN ? '' : ` is too old: Stead needs ${NODE_MIN} or newer`}`,
    'Install the current Node.js from nodejs.org (the big green button), then run: npx stead-ai init');
  const chrome = findChrome();
  add(Boolean(chrome), chrome ? `Browser: ${chrome}` : 'No Chrome or Edge found', 'Install Google Chrome from google.com/chrome, then run: npx stead-ai init');
  add(hasConsent(), hasConsent() ? 'Terms accepted' : 'Terms not accepted yet, so Claude can only look, not act', 'Run this and type I agree: npx stead-ai accept');
  add(!isPaused(), isPaused() ? 'Paused: Claude can\'t change anything' : 'Not paused', 'Run: npx stead-ai resume');

  // Which Claude apps can see Stead. Only one has to; a stale one (its node or folder was deleted) is a problem.
  const apps = [{ app: 'Claude Code', file: CONFIG_PATH }, ...desktopConfigPaths()];
  if (fs.existsSync(codexConfigPath())) apps.push({ app: 'ChatGPT/Codex', file: codexConfigPath(), toml: true });
  let anywhere = false;
  for (const a of apps) {
    if (a.toml) {
      let has = false;
      try { has = fs.readFileSync(a.file, 'utf8').includes(`[mcp_servers.${name}]`); } catch {}
      anywhere ||= has;
      add(has || null, `${a.app}: ${has ? 'set up' : 'not set up'}`);
      continue;
    }
    const s = entryState(a.file, name);
    const ext = a.app.startsWith('Claude Desktop') && desktopExtension(a.file);
    if (s.state === 'ok' || ext) { anywhere = true; add(true, `${a.app}: set up${ext && s.state !== 'ok' ? ' (extension)' : ''}`); }
    else if (s.state === 'stale') add(false, `${a.app}: set up, but ${s.missing} is gone`, 'Run: npx stead-ai init   (it points Claude at this copy again)');
    else if (s.state === 'broken') add(false, `${a.app}: its settings file isn't valid JSON (${a.file})`, 'Fix or move that file, then run: npx stead-ai init');
    // The Store version reads only its own copy, so Stead missing there is the bug that hides it.
    // Any other app without Stead is fine as long as one has it (checked below).
    else if (s.state === 'absent') add(a.app === 'Claude Desktop (Store version)' ? false : null, `${a.app}: not set up`, 'Run: npx stead-ai init   (then restart Claude)');
    // missing-file: that app isn't used here; nothing to say.
  }
  if (!anywhere) add(false, 'Stead isn\'t in any Claude app\'s settings', 'Run: npx stead-ai init   (then restart Claude)');

  if (await probe(port)) {
    const w = await windowStatus(dir, { port }).catch(() => ({ windows: [] }));
    add(w.windows.length > 0, w.windows.length ? `Browser window: ${w.onScreen ? 'on screen' : 'hidden (off screen)'}` : 'The browser is running but no window was found',
      'Run: npx stead-ai show   (if nothing appears, close the browser and run npx stead-ai launch)');
  }
  return out;
}

// Start `stead all` the way Claude does and list its tools: catches what only shows up there (the
// Playwright child failing on old Node, a broken install), which Claude reports only as
// "Server disconnected".
export async function serverStarts({ port = 9222, timeoutMs = 25000, env = {} } = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'stead.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'all', ...(port !== 9222 ? ['--port', String(port)] : [])],
    env: { ...process.env, ...env },
    stderr: 'pipe',
  });
  let errText = '';
  transport.stderr?.on('data', (d) => { errText = (errText + d).slice(-2000); });
  const client = new Client({ name: 'stead-doctor', version: '1' });
  let timer;
  try {
    const tools = await Promise.race([
      client.connect(transport).then(() => client.listTools()).then((r) => r.tools.length),
      new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no answer in ${timeoutMs / 1000}s`)), timeoutMs); }),
    ]);
    return { ok: tools > 0, tools };
  } catch (e) {
    const last = errText.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    return { ok: false, error: last || e.message };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
