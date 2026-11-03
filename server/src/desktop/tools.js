// Desktop apps as MCP tools (Windows). Same idea as the browser: read the app's accessibility
// tree and act on controls by id or by name. Screenshots + coordinates only when an app draws its own UI.
import fs from 'node:fs';
import path from 'node:path';
import { call, asList } from './desktop.js';

const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });
const fail = (t) => ({ ...text(t), isError: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const S = { type: 'string' }, N = { type: 'number' }, B = { type: 'boolean' };

// Stead on screen acts out each of these where it happens (../onscreen/director.js): the tool says
// where (a point, a control's rect, a window), she pops over and presses, types or scrolls there. The
// job never waits for her, and she only goes when she's up and showing.
const WALKS = new Set(['click', 'invoke', 'real_click', 'double_click', 'right_click', 'set_value', 'check', 'uncheck', 'select', 'expand']);
// Awaited: a place looked up through the desktop helper must be asked before the action itself, not
// queue behind a long one (the helper answers one call at a time). Nothing to look up: no wait.
const cue = (tool, args, where) => import('../onscreen/index.js').then((m) => m.perform(tool, args, where)).catch(() => {});
const rectOf = (s) => {
  const [x, y, w, h] = String(s || '').split(',').map(Number);
  return [x, y, w, h].every(Number.isFinite) && w > 0 ? { x: x + w / 2, y: y + h / 2 } : null;
};
// A window: she goes up on top of it (or hangs off its title bar when it's maximized).
const winOf = (w) => (w && w.w > 0 ? { rect: { x: w.x, y: w.y, w: w.w, h: w.h }, hwnd: w.hwnd } : null);
const winById = (hwnd) => (hwnd ? { key: `hwnd:${hwnd}`, resolve: async () => winOf((await windows()).find((w) => w.hwnd === hwnd)) } : null);
// A control by id: where it is, looked up only if she's going.
const ctlById = (id, hwnd) => (id ? { key: `${hwnd ? `hwnd:${hwnd}/` : ''}id:${id}`, resolve: async () => rectOf(await call('act', { id, action: 'where' }).catch(() => '')) } : null);
// A control by its name in a window: found (one extra UIA lookup) only if she's actually going to it.
const ctlByName = (hwnd, name, type, index) => ({
  key: `hwnd:${hwnd}/name:${name}|${type || ''}|${index}`,
  resolve: async () => rectOf(String(await call('act_name', { hwnd, name, type: type || '', index, action: 'where' }, 45000).catch(() => '')).split('|')[1]),
});
// She taps at a keyboard for about as long as the typing takes (ticks are 33ms).
const tapping = async (ticks) => {
  try { const { send, running } = await import('../onscreen/index.js'); if (running()) send({ type: 'type', ticks: Math.round(Math.max(15, Math.min(300, ticks))) }); } catch {}
};

let lastShot = null; // maps screenshot pixels back to screen pixels
const toScreen = (x, y) => {
  if (!lastShot) throw new Error('Take a desktop_screenshot first; coordinates are in screenshot pixels.');
  return [Math.round(lastShot.originX + x / lastShot.scale), Math.round(lastShot.originY + y / lastShot.scale)];
};

// What a desktop_click at these screenshot coordinates would press, for the approval gate:
// { role, name, app }, or null when there's no screenshot yet or nothing can be read there.
export async function controlAt(x, y) {
  if (!lastShot || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const [sx, sy] = toScreen(x, y);
  const hit = String(await call('at', { x: sx, y: sy }).catch(() => '') || '');
  if (!hit) return null;
  const [role, name = ''] = hit.split('\t');
  const w = (await windows().catch(() => [])).find((x2) => (lastShot.hwnd ? x2.hwnd === lastShot.hwnd : x2.active));
  return { role, name, app: w?.app || '' };
}

const fmtWin = (w) => `${w.hwnd}  ${w.app}  "${w.title}"${w.active ? '  (active)' : ''}${w.admin ? '  (admin: they must click in it themselves)' : ''}`;
const windows = async () => asList(await call('windows'));

// After opening something, the window it made: a new one, else one whose title or app matches.
// An app that's already open (Notepad, Calculator) makes no new window, just brings its own forward
// or shows the file in its title: take that at once instead of waiting out the whole timeout
// (was 2 s+ per open). If it was in front already, give a real new window 2 s to show up first.
async function waitForWindow({ before = [], match = '', seconds = 15 }) {
  const old = new Map(before.map((w) => [w.hwnd, w]));
  const m = String(match).toLowerCase();
  const hit = (w) => !m || `${w.title} ${w.app}`.toLowerCase().includes(m);
  const t0 = Date.now(), until = t0 + seconds * 1000;
  let fallback = null;
  while (Date.now() < until) {
    const now = await windows();
    const fresh = now.find((w) => !old.has(w.hwnd) && hit(w)) || (before.length ? now.find((w) => !old.has(w.hwnd)) : null);
    if (fresh) return fresh;
    const again = m && before.length ? now.find((w) => {
      const was = old.get(w.hwnd);
      return was && hit(w) && (w.title !== was.title || (w.active && (!was.active || Date.now() - t0 > 2000)));
    }) : null;
    if (again) return { ...again, reused: true };
    fallback = m ? now.find(hit) : null;
    await sleep(250);
  }
  return fallback;
}

// Keys and typing go wherever the keyboard focus is: maybe the chat the person is typing in.
// Given a window or control, focus it first (the host refuses if it can't).
const focusFirst = async ({ id, hwnd }) => { if (id || hwnd) await call('focus_for', { id: id || '', hwnd: hwnd || 0 }); };
// A popup or dialog in front of the window takes the keystrokes. Say so instead of typing into it.
const blocker = async (hwnd) => (hwnd ? String(await call('blocker', { hwnd }).catch(() => '')) : '');
const blockedMsg = (b) => `Not done: a popup is open in front of that window: ${b}. Answer or close it first (desktop_act on its button by name), then try again.`;
// With no target given, keystrokes go to whatever window is in front. If that is the chat itself
// (Claude, ChatGPT, or the terminal Claude Code runs in), they would type into the conversation and
// Enter would send it. Measured, not imagined: a test lost its window and texted "- passport" to the chat.
const CHAT_APPS = /^(claude|chatgpt|codex|windowsterminal|openconsole|conhost|cmd|powershell|pwsh|wt|terminal|iterm2|warp|ghostty)$/i;
async function chatInFront() {
  const w = (await windows()).find((x) => x.active);
  return w && CHAT_APPS.test(w.app) ? w : null;
}
const chatMsg = (w) => `Not done: no window was given and the one in front is ${w.app} ("${w.title}"), where the person talks to you, so the keys would land in the chat. Pass hwnd (from desktop_windows) or a control id.`;
const SAFE_WITH_POPUP = /^(esc|escape|enter|return|tab|shift\+tab|space|up|down|left|right)$/i;
// Notepad, Word and friends reopen what was open last time, so "open Notepad and write X" can land
// in one of their files (a test run typed into a restored npx.ps1 before noticing).
const EDITORS = /^(notepad|winword|excel|powerpnt|wordpad|textedit|pages|numbers|keynote)$/i;
const BLANK = /^(\*?untitled|notepad|document\s*\d*|book\s*\d*|presentation\s*\d*|word|excel|powerpoint|new tab)\b/i;
const reopenedNote = (w) => (EDITORS.test(w.app) && !BLANK.test(w.title.replace(/\s+-\s+[^-]+$/, ''))
  ? `\nIt reopened a file from last time ("${w.title}"). That's theirs: for something new, start a new document first (ctrl+n), and don't type into theirs.` : '');
// A popup (restore session, sign in) can take a moment after the window: look a few times over 900 ms,
// stopping at the first one. A window that was already open had its chance long ago: look once.
const popupNote = async (w) => {
  const until = Date.now() + (w.reused ? 0 : 900);
  let b;
  while (!(b = await blocker(w.hwnd)) && Date.now() < until) await sleep(150);
  return b ? `\nA popup is showing in it: ${b}. Close or answer it first.` : '';
};
// Wait until the app has taken the input just sent (its UI thread answers), at most ms.
const settle = (hwnd, ms = 400) => call('settle', { hwnd: hwnd || 0, ms }).catch(() => {});

// A scheduled job or a text from their phone runs with nobody watching. If someone is using the
// computer right now, moving the mouse and typing would fight them (and could type into their work).
const UNWATCHED = () => process.env.STEAD_UNATTENDED === '1' || process.env.STEAD_PHONE === '1';
async function busyPerson() {
  if (!UNWATCHED()) return '';
  const idle = Number(await call('idle').catch(() => 1e9));
  return idle < 120000 ? `Not done: someone is using this computer right now (input ${Math.round(idle / 1000)}s ago), and moving the mouse or typing would get in their way. Say this part has to wait, or try again later.` : '';
}

// Opening a program, script or downloaded file runs code. That's the person's call, never a web page's.
const RISKY = /\.(exe|msi|msix|appx|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|scr|pif|lnk|url|reg|cpl|msc|jar|appref-ms|application|iso|img|vhdx?|app|pkg|dmg|command|sh|tool|workflow)$/i;
function fromInternet(p) {
  try { return /ZoneId=([3-9])/.test(fs.readFileSync(`${p}:Zone.Identifier`, 'utf8')); } catch { return false; }
}
// A link hands itself to whatever program registered that scheme: ms-msdt: and search-ms: have run
// attackers' code, ms-appinstaller: installs apps. Only web and mail links are plain (they open in
// the browser / mail app); every other scheme asks. A scheme is 2+ letters so a drive (C:) isn't
// one. \\server paths fetch (and can run) from another machine.
const SCHEME = /^([a-z][a-z0-9+.-]+):/i;
const PLAIN_LINK = /^(https?|mailto):/i;
// A web link goes through browser_navigate, where the approval gate judges it (an unsubscribe or
// delete link acts the moment it opens); handed to Windows it would skip that check.
const WEB_LINK = /^https?:/i;
const webLinkMsg = (u) => fail(`That is a web link: open it with browser_navigate (url: ${u}), not as a desktop app or file.`);
function linkRisk(s) {
  const t = String(s).trim();
  if (/^(\\\\|\/\/)/.test(t)) return 'is on another computer on the network';
  const m = t.match(SCHEME);
  return m && !PLAIN_LINK.test(t) ? `is a ${m[1]}: link, which hands it to whatever program claims that kind of link` : '';
}
// Installed apps whose whole job is running commands: opening one is a step toward running code.
const RUNS_CODE = /^(cmd|command prompt|powershell|windows powershell( ise)?|pwsh|terminal|windows terminal|wt|regedit|registry editor|wscript|cscript|mshta|rundll32|regsvr32|msiexec|bash|wsl)(\.exe)?$/i;

async function confirmRun(what, why, { confirmed, askHuman }) {
  if (process.env.STEAD_UNATTENDED === '1') return `Refused: ${what} ${why}, and this job runs with nobody there to approve it. Leave it for them.`;
  const yes = askHuman ? await askHuman(`Claude wants to open ${what}, which ${why}. Allow it?`) : null;
  if (yes === true || (yes == null && confirmed)) return '';
  if (yes === false) return 'They said no. Nothing was opened.';
  return `Held: ${what} ${why}. Ask them in chat whether to open it (say what it is and where it came from), then call again with confirmed: true.`;
}

const ACTIONS = ['click', 'real_click', 'double_click', 'right_click', 'set_value', 'replace_all', 'check', 'uncheck', 'focus', 'expand', 'collapse', 'select', 'scroll_into_view', 'scroll_down', 'scroll_up', 'close_window', 'minimize', 'maximize', 'restore'];
const WINDOW_ACTIONS = new Set(['close_window', 'minimize', 'maximize', 'restore']);
const MOVES_INPUT = new Set(['real_click', 'double_click', 'right_click', 'set_value', 'replace_all', 'scroll_down', 'scroll_up']);

export const desktopTools = [
  {
    name: 'desktop_windows',
    description: 'List open app windows (id, app, title, active). Start here for anything outside the browser. wait_for: wait (timeout_seconds, default 15) for a window whose title or app contains that text, e.g. "Save as".',
    inputSchema: obj({ wait_for: S, timeout_seconds: N }),
    run: async ({ wait_for, timeout_seconds = 15 }) => {
      if (wait_for) {
        const w = await waitForWindow({ match: wait_for, seconds: Math.min(timeout_seconds, 60) });
        if (!w) return text(`No window with "${wait_for}" appeared in ${timeout_seconds}s. Open windows:\n${(await windows()).map(fmtWin).join('\n')}`);
        return text(`Found: ${fmtWin(w)}`);
      }
      return text((await windows()).map(fmtWin).join('\n') || 'No windows.');
    },
  },
  {
    name: 'desktop_open_app',
    description: 'Open an installed app by name ("Word", "Settings", "File Explorer"); returns its window id.',
    inputSchema: obj({ name: S, confirmed: { type: 'boolean', description: 'After their yes in chat to opening this program' } }, ['name']),
    run: async ({ name, confirmed }, ctx = {}) => {
      const n = String(name || '').trim();
      if (!n) return fail('Say which app.');
      if (WEB_LINK.test(n)) return webLinkMsg(n);
      if (PLAIN_LINK.test(n)) return text(`${await call('open', { path: n })} (a link: it opens in its usual app, e.g. the mail app).`);
      let asked = false;
      const ask = async (why) => { if (asked) return ''; asked = true; return confirmRun(`"${n}"`, why, { confirmed, askHuman: ctx.askHuman }); };
      const why = linkRisk(n) || (RISKY.test(n) || /[\\/]/.test(n) ? 'is a program file, not an installed app' : RUNS_CODE.test(n) ? 'runs commands typed into it' : '');
      if (why) { const held = await ask(why); if (held) return fail(held); }
      const before = await windows();
      let r = String(await call('launch', { name: n }, 20000));
      // Not in the Start menu: Windows would run it as a command (cmd, regedit, a script on PATH).
      if (r === 'nomatch') {
        const held = await ask('is not an installed app by that name, so Windows would run it as a command');
        if (held) return fail(held);
        r = String(await call('launch', { name: n, raw: true }, 20000));
      }
      const w = await waitForWindow({ before, match: r.replace(/^launched\s*/, '') || n, seconds: 20 });
      await cue('desktop_open_app', { name: n }, winOf(w));
      return text(w ? `${r}. Window: ${fmtWin(w)}${reopenedNote(w)}${await popupNote(w)}` : `${r}, but no window showed up yet; call desktop_windows.`);
    },
  },
  {
    name: 'desktop_open_file',
    description: 'Open a file or folder with its default app; returns its window id. Programs, scripts, downloaded files and non-mail links need their yes first; web links: browser_navigate.',
    inputSchema: obj({ path: S, confirmed: { type: 'boolean', description: 'After their yes in chat to opening this file' } }, ['path']),
    run: async ({ path, confirmed }, ctx = {}) => {
      const p = String(path || '').trim();
      if (WEB_LINK.test(p)) return webLinkMsg(p);
      // Not a link and not on disk: Windows looks the name up as a program (cmd, powershell, regedit).
      const why = PLAIN_LINK.test(p) ? '' : linkRisk(p)
        || (RISKY.test(p) ? `runs a program${fromInternet(p) ? ' and was downloaded from the internet' : ''}` : '')
        || (!SCHEME.test(p) && !fs.existsSync(p) ? 'is not a file or folder here, so Windows would run it as a command' : '');
      if (why) {
        const held = await confirmRun(p, why, { confirmed, askHuman: ctx.askHuman });
        if (held) return fail(held);
      }
      if (PLAIN_LINK.test(p)) return text(`${await call('open', { path: p })} (a link: it opens in its usual app, e.g. the mail app).`);
      const before = await windows();
      const r = await call('open', { path: p });
      const base = p.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.[^.]+$/, '') || '';
      const w = await waitForWindow({ before, match: base, seconds: 20 });
      await cue('desktop_open_file', { path: p }, winOf(w));
      return text(w ? `${r}. Window: ${fmtWin(w)}${await popupNote(w)}` : `${r}; call desktop_windows to find its window.`);
    },
  },
  {
    name: 'desktop_focus',
    description: 'Bring a window to the front by its id from desktop_windows.',
    inputSchema: obj({ hwnd: N }, ['hwnd']),
    run: async ({ hwnd }) => {
      await cue('desktop_focus', { hwnd }, winById(hwnd));
      return text((await call('focus', { hwnd })) ? 'Focused.' : 'Windows refused to focus it; click it instead.');
    },
  },
  {
    name: 'desktop_read',
    description: "A window's controls as an outline (ids like e12, values, on/off state, open menus): the reliable way to use a desktop app. Read again after a change; id reads one part. Full text: desktop_read_text.",
    inputSchema: obj({ hwnd: N, id: S, depth: N, max: N }, ['hwnd']),
    // Chromium-based apps (new Outlook, Teams) build their tree lazily: the host polls a short one.
    run: async ({ hwnd, id, depth = 25, max = 350 }) => text(await call('tree', { hwnd, id: id || '', depth, max })),
  },
  {
    name: 'desktop_read_text',
    description: "A window's words as plain text (a whole document, a message, a dialog), by hwnd or a control id. Read before editing and to check an edit landed.",
    inputSchema: obj({ hwnd: N, id: S, max_chars: N, ocr: { type: 'boolean', description: 'Read the pixels (self-drawn apps)' } }),
    run: async ({ hwnd, id, max_chars = 20000, ocr }) => {
      if (!hwnd && !id) return fail('Give hwnd (a window) or id (a control).');
      if (ocr) {
        if (!hwnd) return fail('ocr needs hwnd.');
        const lines = asList(await call('ocr', { hwnd }, 60000));
        // Boxes are screen pixels: the middle of one is where to point or click (desktop_mouse needs a screenshot).
        return text(lines.map((l) => `${l.text}  [${l.x},${l.y},${l.w},${l.h}]`).join('\n').slice(0, max_chars) || '(no text found in the picture)');
      }
      const t = await call('text', { hwnd: hwnd || 0, id: id || '', max: Math.min(max_chars, 200000) }, 60000);
      const b = !id ? await blocker(hwnd) : '';
      return text((b ? `(A popup is open in front of this window: ${b}.)\n` : '') + (String(t || '').trim() ? t : '(no readable text; try desktop_read, or desktop_screenshot if the app draws its own UI)'));
    },
  },
  // Only in her own sessions (Stead on screen): elsewhere they'd cost every Claude context for nothing.
  ...(process.env.STEAD_ONSCREEN_JOB ? [{
    name: 'claude_handoff',
    description: "Hand a job to the full Claude Code on this computer: it opens in a terminal with the task already typed in and running, with every connector and tool they've set up (email, calendar, anything). Use it when the job needs something you can't reach from here. Write the task the way they'd type it, with every detail it needs.",
    inputSchema: obj({ task: S }, ['task']),
    run: async ({ task }) => {
      const { spawn } = await import('node:child_process');
      const os = await import('node:os');
      // cmd and Windows Terminal both treat these as their own syntax: keep the task plain words.
      const t = String(task || '').replace(/[\r\n]+/g, ' ').replace(/[;"&|<>^%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
      if (!t) return fail('Say what the task is.');
      if (process.env.STEAD_ONSCREEN_JOB) { try { const { send } = await import('../onscreen/index.js'); send({ type: 'anim', name: 'ceiling' }); } catch {} }
      const before = await windows();
      const wt = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
      const args = ['-d', os.homedir(), 'cmd', '/k', 'claude', t];
      const p = fs.existsSync(wt) ? spawn(wt, args, { detached: true, stdio: 'ignore' }) : spawn('cmd', ['/c', 'start', 'Claude Code', '/d', os.homedir(), 'cmd', '/k', 'claude', t], { detached: true, stdio: 'ignore' });
      p.on('error', () => {}); p.unref();
      const w = await waitForWindow({ before, seconds: 12 });
      await cue('desktop_open_app', { name: 'Claude Code' }, winOf(w));
      return text(`Claude Code is open with the task running${w ? ` (${fmtWin(w)})` : ''}. It has everything they've connected; they can watch it and answer it there.`);
    },
  },
  {
    name: 'desktop_point',
    description: 'Show them where something is on their screen, without clicking it: Stead on screen runs over to it and rings it for a few seconds. Use it to teach ("this is the Save button") and when they ask where something is. By id (from desktop_read/desktop_find), by hwnd + name, or by a screen rect x,y,w,h.',
    inputSchema: obj({ id: S, hwnd: N, name: S, type: S, x: N, y: N, w: N, h: N }, []),
    run: async ({ id, hwnd, name, type, x, y, w, h }) => {
      let rect = [x, y, w, h].every(Number.isFinite) ? `${x},${y},${w},${h}` : '';
      if (!rect && id) rect = String(await call('act', { id, action: 'where' }).catch(() => ''));
      if (!rect && hwnd && name) { const r = String(await call('act_name', { hwnd, name, type: type || '', index: 0, action: 'where' }, 45000).catch(() => '')); rect = r.split('|')[1] || ''; }
      const [rx, ry, rw, rh] = rect.split(',').map(Number);
      if (![rx, ry, rw, rh].every(Number.isFinite) || rw <= 0) return fail(`Couldn't find where that is${rect ? ` (${rect})` : ''}. Find it with desktop_find first.`);
      try { const { send, running } = await import('../onscreen/index.js'); if (!running()) return fail('Stead on screen is not running.'); send({ type: 'point', x: Math.round(rx), y: Math.round(ry), w: Math.round(rw), h: Math.round(rh) }); } catch (e) { return fail(String(e.message || e)); }
      return text(`Pointed at ${name || id || 'it'} (${rx},${ry} ${rw}x${rh}).`);
    },
  }] : []),
  {
    name: 'desktop_find',
    description: 'Find controls whose name contains text in a window (and its open menu); cheaper than desktop_read.',
    inputSchema: obj({ hwnd: N, text: S }, ['hwnd', 'text']),
    run: async ({ hwnd, text: t }) => text(await call('find', { hwnd, text: t, limit: 25 }, 45000)),
  },
  {
    name: 'desktop_wait',
    description: 'Wait up to timeout_s (max 60) for a control named name to show; gone: true waits for it to go.',
    inputSchema: obj({ hwnd: N, name: S, gone: B, timeout_s: N }, ['hwnd', 'name']),
    run: async ({ hwnd, name, gone, timeout_s = 15 }) => {
      const ms = Math.round(Math.max(0.2, Math.min(Number(timeout_s) || 15, 60)) * 1000);
      const r = String(await call('wait', { hwnd, name: String(name || ''), gone: Boolean(gone), ms }, ms + 10000) || '');
      return r ? text(gone ? `Gone${r.startsWith('gone (') ? r.slice(4) : ''}.` : `There: ${r}`) : fail(`"${name}" ${gone ? 'was still there' : 'did not show up'} after ${ms / 1000}s.`);
    },
  },
  {
    name: 'desktop_act',
    description: `Act on a control by id (desktop_read/desktop_find), or by hwnd + name (its label: "Save", "File name:"; type narrows: Button, Edit, MenuItem...). Open menus and popups are searched first. click is smart (invoke, toggle, select); real_click/double_click/right_click are real mouse clicks; set_value fills a field; replace_all overwrites a whole document; check/uncheck set a state; close_window/minimize/maximize/restore need hwnd.`,
    inputSchema: obj({ id: S, hwnd: N, name: S, type: S, index: { type: 'number', description: 'Nth match (0 = best)' }, action: { type: 'string', enum: ACTIONS }, value: S }, ['action']),
    // strict (from desktop_batch only): a greyed-out control is an error, not a click that does nothing.
    run: async ({ id, hwnd, name, type, index = 0, action, value, strict = false }) => {
      if (MOVES_INPUT.has(action)) { const busy = await busyPerson(); if (busy) return fail(busy); }
      let r;
      if (WINDOW_ACTIONS.has(action)) {
        if (!hwnd) return fail(`${action} needs hwnd.`);
        await cue('desktop_act', { action }, winById(hwnd));
        r = await call('window', { hwnd, action });
      } else if (id) { await cue('desktop_act', { action }, ctlById(id, hwnd)); r = await call('act', { id, action, value, strict }); }
      else if (hwnd && name) {
        // A press or a fill: she goes to the control itself, looked up only when she's going there (the
        // cue is awaited, so she's at it as it's pressed); the act is the same call either way.
        await cue('desktop_act', { action }, WALKS.has(action) ? ctlByName(hwnd, name, type, index) : winById(hwnd));
        r = await call('act_name', { hwnd, name, type: type || '', index, action, value, strict }, 45000);
      }
      else return fail('Give id, or hwnd + name.');
      // Wait for the app to take it (its UI thread answers), not a flat 350 ms.
      if (!WINDOW_ACTIONS.has(action)) await settle(hwnd, 350);
      return text(r);
    },
  },
  {
    name: 'desktop_screenshot',
    description: 'See one window (hwnd; brought to the front) or their screen (all: every monitor), when desktop_read is empty or unclear. desktop_click uses THIS image\'s pixels. Checking text: desktop_read_text.',
    inputSchema: obj({ hwnd: N, all: B, region: { type: 'array', items: N, description: '[x,y,w,h] of the last one, to zoom' } }),
    run: async ({ hwnd, all, region }) => {
      let r = {};
      if (Array.isArray(region) && region.length === 4) {
        const [x, y, w, h] = region.map(Number);
        if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return fail('region is [x, y, w, h] with w and h above 0.');
        const [x1, y1] = toScreen(x, y), [x2, y2] = toScreen(x + w, y + h);
        r = { rx: x1, ry: y1, rw: Math.max(1, x2 - x1), rh: Math.max(1, y2 - y1) };
        hwnd ??= lastShot.hwnd || 0;
      }
      const s = await call('screenshot', { hwnd: hwnd ?? 0, maxW: 1400, all: Boolean(all), ...r });
      lastShot = s;
      return { content: [{ type: 'image', data: s.b64, mimeType: 'image/jpeg' }, { type: 'text', text: `Screenshot ${s.width}x${s.height}.` }] };
    },
  },
  {
    name: 'desktop_mouse',
    description: 'Move the mouse to x,y, or drag to to_x,to_y, in last desktop_screenshot pixels.',
    inputSchema: obj({ action: { type: 'string', enum: ['move', 'drag'] }, x: N, y: N, to_x: N, to_y: N }, ['action', 'x', 'y']),
    run: async ({ action, x, y, to_x, to_y }) => {
      const busy = await busyPerson();
      if (busy) return fail(busy);
      const [sx, sy] = toScreen(x, y);
      await cue('desktop_mouse', { action }, { x: sx, y: sy, hwnd: lastShot.hwnd });
      if (action === 'move') { await call('move', { x: sx, y: sy }); return text('Moved.'); }
      if (!Number.isFinite(to_x) || !Number.isFinite(to_y)) return fail('drag needs to_x and to_y.');
      const [tx, ty] = toScreen(to_x, to_y);
      if (lastShot.hwnd) await call('focus', { hwnd: lastShot.hwnd }).catch(() => {});
      await call('drag', { x: sx, y: sy, toX: tx, toY: ty, hwnd: lastShot.hwnd || 0 });
      await settle(lastShot.hwnd, 300);
      return text('Dragged.');
    },
  },
  {
    name: 'desktop_click',
    description: 'Mouse click at a point in the last desktop_screenshot (refuses if something now covers it).',
    inputSchema: obj({ x: N, y: N, button: { type: 'string', enum: ['left', 'right'] }, double: B }, ['x', 'y']),
    run: async ({ x, y, button = 'left', double }) => {
      const busy = await busyPerson();
      if (busy) return fail(busy);
      const [sx, sy] = toScreen(x, y);
      if (lastShot.hwnd) await call('focus', { hwnd: lastShot.hwnd }).catch(() => {});
      await cue('desktop_click', {}, { x: sx, y: sy, hwnd: lastShot.hwnd });
      await call('click', { x: sx, y: sy, button, count: double ? 2 : 1, hwnd: lastShot.hwnd || 0 });
      await settle(lastShot.hwnd, 300);
      return text('Clicked.');
    },
  },
  {
    name: 'desktop_type',
    description: 'Type text on the desktop. Always pass hwnd (or a control id), or it lands wherever the keyboard is (maybe the chat they are typing in). Long or multi-line text is pasted in one go; newline: "enter" types key by key. Formatted text: paste_formatted.',
    inputSchema: obj({ text: S, hwnd: N, id: S, newline: { type: 'string', enum: ['paste', 'enter'] } }, ['text']),
    run: async ({ text: t, hwnd, id, newline = 'paste' }) => {
      if (!hwnd && !id) { const c = await chatInFront(); if (c) return fail(chatMsg(c)); }
      const busy = await busyPerson();
      if (busy) return fail(busy);
      const b = await blocker(hwnd);
      if (b) return fail(blockedMsg(b));
      await cue('desktop_type', {}, id ? ctlById(id, hwnd) : winById(hwnd));
      await focusFirst({ id, hwnd });
      if (newline === 'paste' && (/[\r\n]/.test(t) || t.length > 200)) { await tapping(25); await call('paste_text', { text: t }, 60000); return text('Typed (pasted).'); }
      await tapping(20 + String(t).length * 0.6);
      await call('type', { text: t }, 120000);
      return text('Typed.');
    },
  },
  {
    name: 'desktop_keys',
    description: 'Press a key or shortcut ("enter", "ctrl+s", "alt+f4"). Pass hwnd to send it to that window.',
    inputSchema: obj({ combo: S, hwnd: N }, ['combo']),
    run: async ({ combo, hwnd }) => {
      if (!hwnd) { const c = await chatInFront(); if (c) return fail(chatMsg(c)); }
      const busy = await busyPerson();
      if (busy) return fail(busy);
      // Some apps (the new Notepad) ignore a synthetic Alt+F4; closing the window directly is the same thing.
      if (/^alt\s*\+\s*f4$/i.test(String(combo).trim())) {
        const target = hwnd || (await windows()).find((w) => w.active)?.hwnd;
        if (target) return text(await call('window', { hwnd: target, action: 'close_window' }));
      }
      const b = SAFE_WITH_POPUP.test(String(combo).trim()) ? '' : await blocker(hwnd);
      if (b) return fail(blockedMsg(b));
      await cue('desktop_keys', {}, winById(hwnd));
      await focusFirst({ hwnd });
      await tapping(15);
      await call('keys', { combo });
      await settle(hwnd, 250);
      return text('Pressed.');
    },
  },
  {
    name: 'desktop_scroll',
    description: 'Scroll at a point in the last desktop_screenshot; positive clicks scroll down. Lists: desktop_act scroll_down/scroll_up.',
    inputSchema: obj({ x: N, y: N, clicks: N }, ['x', 'y', 'clicks']),
    run: async ({ x, y, clicks }) => {
      const busy = await busyPerson();
      if (busy) return fail(busy);
      const [sx, sy] = toScreen(x, y);
      await cue('desktop_scroll', {}, { x: sx, y: sy, hwnd: lastShot.hwnd });
      await call('scroll', { x: sx, y: sy, clicks });
      await settle(lastShot.hwnd, 250);
      return text('Scrolled.');
    },
  },
  {
    name: 'desktop_batch',
    description: 'Run steps in order, each {tool: "act"|"type"|"keys", ...its arguments}, e.g. a form. Stops at the first failure.',
    inputSchema: obj({ steps: { type: 'array', items: { type: 'object' } } }, ['steps']),
    // Each step goes through the approval gate exactly as if it were called on its own.
    run: async ({ steps }, ctx = {}) => {
      const list = Array.isArray(steps) ? steps.slice(0, 30) : [];
      if (!list.length) return fail('Give steps: [{tool: "act", hwnd, name, action}, {tool: "type", hwnd, text}, ...].');
      // Without the gate to put each step through, nothing runs: a batch must never be a way around it.
      if (typeof ctx.approve !== 'function') return fail('desktop_batch can only run through the approval gate; call the steps one by one.');
      const out = [];
      for (const [i, s] of list.entries()) {
        const { tool, ...a } = s || {};
        const t = ['act', 'type', 'keys'].includes(tool) && desktopTools.find((x) => x.name === `desktop_${tool}`);
        const say = (r) => (r?.content || []).map((c) => c.text || '').join(' ').trim();
        let r;
        if (!t) r = fail(`unknown tool "${tool}" (act, type or keys)`);
        else {
          const g = ctx.approve ? await ctx.approve(t.name, a) : null;
          if (g?.result) r = { ...g.result, isError: true };
          else {
            try { r = await t.run(tool === 'act' ? { ...a, strict: true } : a, ctx); } catch (e) { r = fail(String(e.message || e)); }
          }
        }
        out.push(`${i + 1}. ${tool}: ${r.isError ? 'STOPPED: ' : ''}${say(r)}`);
        if (r.isError) {
          if (i + 1 < list.length) out.push(`(steps ${i + 2}-${list.length} not run)`);
          return { ...text(out.join('\n')), isError: true };
        }
      }
      return text(out.join('\n'));
    },
  },
  {
    name: 'clipboard_read',
    description: 'Read the clipboard (text, or files copied in File Explorer).',
    inputSchema: obj(),
    run: async () => {
      const c = await call('clipboard_read');
      const files = asList(c?.files);
      return text([c?.text || '', files.length ? `Files: ${files.join(', ')}` : '', c?.image ? '(an image is on the clipboard)' : ''].filter(Boolean).join('\n') || '(the clipboard is empty)');
    },
  },
];

// Works everywhere the clipboard does, so it's offered on its own even if the rest is Windows-only.
export const clipboardTool = {
  name: 'paste_formatted',
  description: 'Put HTML (<h2>, <ul><li>, <b>, <table>, <a>) on the clipboard so Control+v pastes real headings, bullets and bold: the best way to write into Google Docs, Gmail, Word or Outlook. Then click where it goes and press Control+v.',
  inputSchema: obj({ html: S, text: { type: 'string', description: 'Plain version (default: from html)' } }, ['html']),
  run: async ({ html, text: t }) => { await call('clipboard', { html, text: t || '' }); return text('On the clipboard. Click where it should go, then press Control+v.'); },
};
