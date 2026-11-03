// Node side of desktop control: one persistent PowerShell host, JSON lines each way.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'host.ps1');
const READY_MS = 20000; // the first start compiles Desktop.cs (~5 s); a host that never says ready is stuck

// Each host keeps its own calls: when an old one dies after a restart, only its calls fail, never
// the ones already queued on the fresh host (a timed-out call then a quick retry used to both fail).
let host = null;
let seq = 0;

function start() {
  const me = { proc: null, pending: new Map(), ready: null };
  let errText = '';
  me.failAll = (e) => { for (const p of me.pending.values()) p.reject(e); me.pending.clear(); };
  const gone = (why) => {
    if (host === me) host = null;
    me.failAll(new Error(`desktop host ${why} ${errText.slice(-400)}`.trim()));
  };
  me.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST], { windowsHide: true });
  me.proc.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
  me.ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error(`desktop host did not start within ${READY_MS / 1000}s ${errText.slice(-400)}`.trim())); kill(me); }, READY_MS);
    me.pending.set(0, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
  });
  me.ready.catch(() => {}); // a failed start is reported to the call that's waiting, not as a crash
  me.proc.on('exit', (code) => gone(`exited (${code})`));
  me.proc.on('error', (e) => gone(`failed to start: ${e.message}`));
  me.proc.stdin.on('error', (e) => gone(`stopped taking input: ${e.message}`));
  readline.createInterface({ input: me.proc.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = me.pending.get(msg.id);
    if (!p) return;
    me.pending.delete(msg.id);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
  });
  host = me;
  return me;
}

// Kill one host (stuck inside an app that stopped responding); the next call starts a fresh one.
function kill(me) {
  if (host === me) host = null;
  me.failAll(new Error('desktop host was restarted after a call timed out; read the window again'));
  spawnSync('taskkill', ['/PID', String(me.proc.pid), '/T', '/F'], { windowsHide: true });
  try { me.proc.kill(); } catch {}
}

// macOS answers the same calls through System Events (mac.js, experimental).
const MAC = process.platform === 'darwin';
let mac = null;

export async function call(op, args = {}, timeoutMs = 30000) {
  if (MAC) { mac ??= await import('./mac.js'); return mac.call(op, args); }
  const me = host || start();
  await me.ready;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    // Waiting behind a stuck call would stall every later one (and a half-finished action could keep
    // going), so its host is killed.
    const t = setTimeout(() => {
      me.pending.delete(id);
      reject(new Error(`${op} timed out after ${Math.round(timeoutMs / 1000)}s: the app may have stopped responding. The desktop helper was restarted; read the window again before acting.`));
      kill(me);
    }, timeoutMs);
    me.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    try { me.proc.stdin.write(JSON.stringify({ id, op, args }) + '\n'); } catch (e) { me.pending.delete(id); clearTimeout(t); reject(e); }
  });
}

export function stop() { const h = host; host = null; try { h?.proc.kill(); } catch {} }

export const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
