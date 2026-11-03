// Finding, launching and health-checking the Chrome that Claude drives.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // School and work Macs without admin rights install apps into the user's own Applications.
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    join(homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ],
};

// STEAD_CHROME (set by `init --chrome <path>` and saved into the Claude config) wins, for a
// browser installed somewhere we don't look.
export function findChrome() {
  const own = process.env.STEAD_CHROME;
  if (own && existsSync(own)) return own;
  const list = CANDIDATES[platform()] || CANDIDATES.linux;
  return list.find((p) => p && existsSync(p)) || null;
}

import { profileDir } from './paths.js';
export { profileDir };

// Is a Chrome already listening for us on this port?
export async function probe(port, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// One browser-level DevTools connection (not a page): windows, targets, version. Works the same for
// Chrome, Edge and Brave on every OS. Node 22+ has WebSocket built in; Node 20 borrows Playwright's
// connection, which is already installed. Every call times out, so a hung browser can't hang us.
export async function devtools(port, timeoutMs = 5000) {
  const v = await probe(port, timeoutMs);
  if (!v?.webSocketDebuggerUrl) throw new Error(`No browser is answering on port ${port}.`);
  const timed = (p, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} timed out`)), timeoutMs).unref())]);
  if (typeof globalThis.WebSocket !== 'function') {
    const { chromium } = await import('playwright-core');
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: timeoutMs });
    const s = await b.newBrowserCDPSession();
    return { send: (m, p = {}) => timed(s.send(m, p), m), close: () => b.close().catch(() => {}) };
  }
  const ws = new globalThis.WebSocket(v.webSocketDebuggerUrl);
  await timed(new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error(`Could not connect to the browser on port ${port}.`)); }), 'Connecting');
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiting.get(m.id);
    if (!w) return; // an event: we never subscribe, but don't trip on one
    waiting.delete(m.id);
    m.error ? w.no(new Error(m.error.message)) : w.ok(m.result);
  };
  ws.onclose = () => { for (const w of waiting.values()) w.no(new Error('The browser closed the connection.')); waiting.clear(); };
  return {
    send: (method, params = {}) => timed(new Promise((ok, no) => {
      const i = ++id;
      waiting.set(i, { ok, no });
      ws.send(JSON.stringify({ id: i, method, params }));
    }), method),
    close: () => { try { ws.close(); } catch {} },
  };
}

// These three flags are not optional. Windows reports a minimized or off-screen
// window as occluded, so Chrome stops compositing and throttles the renderer —
// and Playwright then hangs forever waiting for an element to become "visible
// and stable". Without them, hiding the window silently breaks driving it.
const ANTI_THROTTLE = [
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

// visible:false starts the window off-screen in NORMAL state (not minimized — see
// window.js for why minimizing is what made it keep popping up). `init` passes
// visible:true because the user has to log in there; everything else stays hidden.
export async function launch({ port = 9222, dir = profileDir(), startUrl = 'about:blank', visible = false, waitMs = 30000 } = {}) {
  const running = await probe(port);
  if (running) return { alreadyRunning: true, version: running.Browser };

  const chrome = findChrome();
  if (!chrome) {
    const err = new Error('No Chrome or Edge found.');
    err.hint = 'Install Google Chrome (google.com/chrome), then try again. If it is installed somewhere unusual, run: npx stead-ai init --chrome "<path to chrome>"';
    throw err;
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const child = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session',
    ...ANTI_THROTTLE,
    ...(visible ? ['--window-position=80,60'] : ['--window-position=-32000,-32000']),
    '--window-size=1400,900',
    startUrl,
  ], { detached: true, stdio: 'ignore' });
  // A browser that hands the profile to a copy already open exits at once; one blocked by a policy
  // keeps running without the port. The two need different fixes.
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; });
  child.unref();

  // Chrome opens the debugging port a beat after the process starts. A first start on a slow
  // laptop (antivirus scanning a new profile) can take well over 10 seconds, so wait by the clock.
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const v = await probe(port, 500);
    if (v) return { alreadyRunning: false, version: v.Browser, chrome };
    await new Promise((r) => setTimeout(r, 250));
  }
  // Don't leave it running: an off-screen browser that never opened the port holds the profile, so
  // every later start hands off to it and fails the same way, and nobody can see it to close it.
  if (!exited) try { process.kill(child.pid); } catch {}
  const err = new Error(`The browser started but never opened the debugging port on ${port}.`);
  err.hint = exited
    ? `Another copy of the browser is already using Stead's profile (${dir}). Close every Chrome and Edge window, then try again.`
    : 'On a school or work computer an administrator setting can block this. Try another browser: npx stead-ai init --chrome "<path to Edge or Chrome>"';
  throw err;
}
