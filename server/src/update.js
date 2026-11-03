// Updates straight from Stead's own site, no npm account in the loop. The site serves the current
// build as /stead-ai.tgz and its version in /latest.json (npm run deploy builds both). A site
// install lives in <home>/app/versions/<version>, and <home>/app/current is a junction to the one
// Claude starts. Updating installs the new version into its own folder and moves the junction:
// nothing a running Stead has open is touched, and the next Claude restart runs the new one.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME_DIR } from './paths.js';

export const SITE = process.env.STEAD_SITE || 'https://stead.stead-ai.workers.dev';
const APP = path.join(HOME_DIR, 'app');
const VERSIONS = path.join(APP, 'versions');
export const CURRENT = path.join(APP, 'current');
// The CLI as Claude should start it: through the junction, so an update needs no config change.
export const CURRENT_BIN = path.join(CURRENT, 'node_modules', 'stead-ai', 'bin', 'stead.js');
const LOG = path.join(APP, 'update.log');
const log = (m) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const ME = real(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

// This copy came from the site installer (it sits under app/versions).
export const isSiteInstall = (dir = ME) => real(dir).toLowerCase().startsWith(real(VERSIONS).toLowerCase() + path.sep);

export const newer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

export async function latest(site = SITE) {
  const r = await fetch(`${site}/latest.json`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
  if (!r.ok) throw new Error(`latest.json: HTTP ${r.status}`);
  return (await r.json()).version;
}

// npm is npm.cmd on Windows, which needs cmd /c to start without a shell.
const npm = (args) => (process.platform === 'win32' ? ['cmd', ['/c', 'npm', ...args]] : ['npm', args]);

// Install <version> from the site into its own folder and point app/current at it.
export function installVersion(version, { site = SITE, quiet = true } = {}) {
  const dir = path.join(VERSIONS, version);
  const bin = path.join(dir, 'node_modules', 'stead-ai', 'bin', 'stead.js');
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(dir, { recursive: true });
    const [c, a] = npm(['install', '--prefix', dir, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', `${site}/stead-ai.tgz`]);
    const r = spawnSync(c, a, { stdio: quiet ? 'pipe' : 'inherit', windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0 || !fs.existsSync(bin)) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`npm install failed: ${(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`}`);
    }
  }
  // Move the junction (rmdir on a junction removes the link, not what it points at).
  try { fs.rmSync(CURRENT, { recursive: false, force: true }); } catch { try { fs.unlinkSync(CURRENT); } catch {} }
  fs.symlinkSync(dir, CURRENT, 'junction');
  log(`now on ${version}`);
  prune(version);
  return CURRENT_BIN;
}

// Keep the current version and the one before it; an old one still open just stays until next time.
function prune(keep) {
  let all = [];
  try { all = fs.readdirSync(VERSIONS).filter((v) => /^\d+\.\d+\.\d+$/.test(v)); } catch { return; }
  all.sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
  for (const v of all.filter((v) => v !== keep).slice(1)) {
    try { fs.rmSync(path.join(VERSIONS, v), { recursive: true, force: true }); } catch {}
  }
}

// Called once when the server starts: if the site has a newer build, install it in the background.
// Only for site installs (npx, global and checkout copies update their own way).
export function checkSoon(version, { delayMs = 20000 } = {}) {
  if (!isSiteInstall() || process.env.STEAD_NO_UPDATE) return;
  setTimeout(async () => {
    try {
      const v = await latest();
      if (!newer(v, version)) return;
      log(`${version} -> ${v}: updating in the background`);
      spawn(process.execPath, [path.join(ME, 'bin', 'stead.js'), 'self-update'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (e) { log(`check failed: ${e.message}`); }
  }, delayMs).unref();
}
