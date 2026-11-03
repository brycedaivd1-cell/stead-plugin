// The Claude Code half of Stead: agents, hooks and commands that cut credit spend.
// Shipped inside the npm package and installed as a local plugin marketplace, so it needs
// no GitHub or other host: `stead init` copies it to ~/.stead/marketplace and registers it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_DIR } from './paths.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MARKET_DIR = path.join(HOME_DIR, 'marketplace');

function claude(args) {
  // shell:true so Windows resolves claude.cmd; args are fixed strings plus our own path.
  const cmd = ['claude', ...args].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
  const r = spawnSync(cmd, {
    shell: true, encoding: 'utf8', timeout: 120000,
  });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

export function installPlugin() {
  if (!claude(['--version']).ok) return { ok: false, reason: 'Claude Code CLI not found (skipped the plugin)' };

  // Fresh copy every init, so an upgrade of stead-ai upgrades the plugin too.
  fs.rmSync(MARKET_DIR, { recursive: true, force: true });
  fs.mkdirSync(MARKET_DIR, { recursive: true });
  fs.cpSync(path.join(ROOT, '.claude-plugin'), path.join(MARKET_DIR, '.claude-plugin'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'plugin'), path.join(MARKET_DIR, 'plugin'), { recursive: true });

  const listed = claude(['plugin', 'marketplace', 'list']);
  const step = /\bstead\b/.test(listed.out)
    ? claude(['plugin', 'marketplace', 'update', 'stead'])
    : claude(['plugin', 'marketplace', 'add', MARKET_DIR]);
  if (!step.ok) return { ok: false, reason: step.out.split('\n').pop() };

  const inst = claude(['plugin', 'install', 'stead@stead']);
  if (!inst.ok && !/already installed/i.test(inst.out)) return { ok: false, reason: inst.out.split('\n').pop() };
  return { ok: true };
}
