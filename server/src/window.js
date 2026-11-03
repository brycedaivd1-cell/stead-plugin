// Keeping the Stead window off the user's screen.
//
// The obvious approach, minimizing, is wrong: Chrome restores a minimized window
// every time it activates it, and Playwright activates it on every new tab and every
// tab switch. That is why the browser kept popping onto the screen. So we never
// minimize. The window lives in normal state at an off-screen position; it can be
// activated all day and nothing appears. `show` moves it back when a human is needed.
//
// The moving is done through the browser itself (DevTools Browser.setWindowBounds), so it works for
// Chrome, Edge and Brave on Windows, Mac and Linux, and for every window, including a "Sign in with
// Google" popup, which is a window of its own. The PowerShell path below is only the fallback for
// when the debugging port can't be reached.
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { devtools } from './chrome.js';

const run = promisify(execFile);

export const OFFSCREEN = { x: -32000, y: -32000 };
export const ONSCREEN = { x: 80, y: 60 };

// The port: given, or the one `stead all` is serving (server.js sets STEAD_PORT at start), so
// callers that only pass the profile folder still get the DevTools path.
const portOf = (opts) => Number(opts.port || process.env.STEAD_PORT) || null;
const visibleRect = ({ L, T, R, B }) => R > 0 && B > 0 && L < 10000 && T < 10000;
const rectOf = (b) => ({ L: b.left, T: b.top, R: b.left + b.width, B: b.top + b.height });
const inView = (b) => b.windowState === 'maximized' || b.windowState === 'fullscreen' || (b.windowState === 'normal' && visibleRect(rectOf(b)));

// Every browser window, most recently used first. /json/list is sorted by last activity, so the
// first page is the one Claude (or the person) was just on.
async function cdpWindows(s, port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const pages = (await res.json()).filter((p) => p.type === 'page');
  const wins = new Map();
  for (const p of pages) {
    const w = await s.send('Browser.getWindowForTarget', { targetId: p.id }).catch(() => null);
    if (w && !wins.has(w.windowId)) wins.set(w.windowId, { id: w.windowId, bounds: w.bounds, page: p.id });
  }
  return [...wins.values()];
}

async function viaCdp(port, mode) {
  const s = await devtools(port);
  try {
    const wins = await cdpWindows(s, port);
    const set = (id, bounds) => s.send('Browser.setWindowBounds', { windowId: id, bounds });
    for (const w of wins) {
      const state = w.bounds.windowState;
      if (mode === 'hide') {
        // Bounds can only be set in normal state, and a minimized window is exactly what pops back.
        if (state !== 'normal') await set(w.id, { windowState: 'normal' });
        await set(w.id, { left: OFFSCREEN.x, top: OFFSCREEN.y });
      } else {
        if (state === 'minimized') await set(w.id, { windowState: 'normal' });
        // Maximized or full screen is already in view; a normal window moves only if it's parked off-screen.
        if (state === 'minimized' || (state === 'normal' && !visibleRect(rectOf(w.bounds)))) await set(w.id, { left: ONSCREEN.x, top: ONSCREEN.y });
      }
    }
    // Raise the window with the page they were just on, without switching its tab.
    if (mode === 'show' && wins.length) await s.send('Target.activateTarget', { targetId: wins[0].page }).catch(() => {});
    const after = await Promise.all(wins.map((w) => s.send('Browser.getWindowBounds', { windowId: w.id }).then((r) => r.bounds, () => w.bounds)));
    return { moved: wins.length, onScreen: after.some(inView), via: 'devtools' };
  } finally {
    s.close();
  }
}

// ---- fallback: Win32 calls through PowerShell, by process. Finds only each process's main window.

const PS_PRELUDE = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class HW {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
}
"@
function Wins {
  $m = $env:STEAD_MARKER.ToLower()
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($m) } |
    ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
    Where-Object { $_.MainWindowHandle -ne 0 }
}
`;

// The profile path goes in through the environment, never pasted into the script: a folder like
// C:\Users\O'Brien would otherwise break the quoting.
async function ps(script, marker) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_PRELUDE + script], { timeout: 20000, env: { ...process.env, STEAD_MARKER: String(marker) } });
  return stdout.trim();
}

// SWP_NOSIZE(1) | SWP_NOZORDER(4) | SWP_NOACTIVATE(16)
const MOVE_QUIET = 1 | 4 | 16;

// Both return { moved, via, onScreen?, error? }. moved 0 means no window was found: say so, don't
// tell the person it's on screen.
export async function hide(marker, opts = {}) {
  const port = portOf(opts);
  let error = null;
  if (port) { try { return await viaCdp(port, 'hide'); } catch (e) { error = e.message; } }
  if (platform() !== 'win32') return { moved: 0, via: 'none', error: error || 'No debugging port to reach the browser through.' };
  const out = await ps(`
    $n = 0
    foreach ($w in @(Wins)) {
      [HW]::ShowWindow($w.MainWindowHandle, 9) | Out-Null   # SW_RESTORE: never leave it minimized
      [HW]::SetWindowPos($w.MainWindowHandle, [IntPtr]::Zero, ${OFFSCREEN.x}, ${OFFSCREEN.y}, 0, 0, ${MOVE_QUIET}) | Out-Null
      $n++
    }
    $n`, marker);
  return { moved: Number(out) || 0, via: 'powershell', ...(error ? { error } : {}) };
}

export async function show(marker, opts = {}) {
  const port = portOf(opts);
  let error = null;
  if (port) { try { return await viaCdp(port, 'show'); } catch (e) { error = e.message; } }
  if (platform() !== 'win32') return { moved: 0, via: 'none', error: error || 'No debugging port to reach the browser through.' };
  const out = await ps(`
    $n = 0
    foreach ($w in @(Wins)) {
      [HW]::ShowWindow($w.MainWindowHandle, 9) | Out-Null
      [HW]::SetWindowPos($w.MainWindowHandle, [IntPtr]::Zero, ${ONSCREEN.x}, ${ONSCREEN.y}, 0, 0, 1 -bor 4) | Out-Null
      [HW]::SetForegroundWindow($w.MainWindowHandle) | Out-Null
      $n++
    }
    $n`, marker);
  return { moved: Number(out) || 0, via: 'powershell', ...(error ? { error } : {}) };
}

// Where is it? Used by tests and `doctor`. onScreen = any window in view.
export async function status(marker, opts = {}) {
  const port = portOf(opts);
  if (port) {
    try {
      const s = await devtools(port);
      try {
        const windows = (await cdpWindows(s, port)).map((w) => ({ id: w.id, rect: rectOf(w.bounds), state: w.bounds.windowState, onScreen: inView(w.bounds) }));
        return { windows, onScreen: windows.some((w) => w.onScreen), via: 'devtools' };
      } finally { s.close(); }
    } catch {}
  }
  if (platform() !== 'win32') return { windows: [], onScreen: false, via: 'none' };
  const out = await ps(`
    foreach ($w in @(Wins)) {
      $r = New-Object HW+RECT
      [HW]::GetWindowRect($w.MainWindowHandle, [ref]$r) | Out-Null
      "$($w.Id) $($r.L) $($r.T) $($r.R) $($r.B)"
    }`, marker);
  const windows = out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, L, T, R, B] = l.split(' ').map(Number);
    return { pid, rect: { L, T, R, B }, onScreen: visibleRect({ L, T, R, B }) };
  });
  return { windows, onScreen: windows.some((w) => w.onScreen), via: 'powershell' };
}
