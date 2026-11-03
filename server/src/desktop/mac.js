// Desktop control for macOS, behind the same calls as the Windows host (host.ps1), so the desktop
// tools work unchanged. It drives apps through System Events (the accessibility tree, like UI
// Automation on Windows), with screencapture for screenshots and CoreGraphics events for clicks.
// EXPERIMENTAL: written without a Mac to test on. It needs the Accessibility permission (and
// Screen Recording for screenshots) for the app Claude runs in; errors say exactly that.
//
// Window ids: macOS has no window handles a script can use, so a window is pid * 100 + its index.
// Control ids map to a path of child indexes from the window, re-walked when acted on, and checked
// against the role and name seen when it was read, so a changed window can't be acted on blindly.
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (script, arg, timeoutMs = 30000) => new Promise((resolve, reject) => {
  execFile('osascript', ['-l', 'JavaScript', '-e', script, JSON.stringify(arg ?? {})], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      const msg = String(stderr || err.message);
      if (/not allowed assistive access|-1719|-25211|1002/.test(msg)) return reject(new Error('macOS blocked it: allow the app Claude runs in (Claude, Terminal or your editor) in System Settings > Privacy & Security > Accessibility, then try again.'));
      return reject(new Error(msg.replace(/^.*execution error: /s, '').trim().slice(0, 400)));
    }
    const out = String(stdout).trim();
    try { resolve(out ? JSON.parse(out) : null); } catch { resolve(out); }
  });
});

// Shared JXA helpers, prepended to every script.
const LIB = `
const se = Application('System Events');
const A = JSON.parse(arguments_[0] || '{}');
function proc(pid) { const p = se.applicationProcesses.whose({ unixId: pid })(); if (!p.length) throw new Error('That window is closed. Call desktop_windows for the current ones.'); return p[0]; }
function win(id) { const pid = Math.floor(id / 100), i = id % 100 - 1; const ws = proc(pid).windows(); if (!ws[i]) throw new Error('That window is closed. Call desktop_windows for the current ones.'); return ws[i]; }
function at(w, pathArr) { let e = w; for (const i of pathArr) e = e.uiElements[i]; return e; }
function safe(f, d) { try { const v = f(); return v === undefined || v === null ? d : v; } catch (e) { return d; } }
function label(e) { return String(safe(() => e.name(), '') || safe(() => e.title(), '') || safe(() => e.description(), '') || ''); }
`;
const script = (body) => `function run(argv) { const arguments_ = argv; ${LIB}\n${body}\n}`;

// ---------- id bookkeeping (Node side) ----------
const refs = new Map(); // e12 -> { hwnd, path, role, name }
let nextRef = 1;
const remember = (r) => { const id = `e${nextRef++}`; refs.set(id, r); if (refs.size > 4000) refs.delete(refs.keys().next().value); return id; };
const ref = (id) => { const r = refs.get(id); if (!r) throw new Error(`Unknown element ${id}. Read the window again (desktop_read) for fresh ids, or act by name.`); return r; };

const ROLE = { AXButton: 'Button', AXTextField: 'Edit', AXTextArea: 'Document', AXStaticText: 'Text', AXCheckBox: 'CheckBox', AXRadioButton: 'RadioButton', AXPopUpButton: 'ComboBox', AXComboBox: 'ComboBox', AXMenuItem: 'MenuItem', AXMenuBarItem: 'MenuItem', AXMenu: 'Menu', AXTabGroup: 'Tab', AXRow: 'ListItem', AXCell: 'DataItem', AXTable: 'Table', AXList: 'List', AXOutline: 'Tree', AXImage: 'Image', AXLink: 'Hyperlink', AXSlider: 'Slider', AXScrollArea: 'Pane', AXGroup: 'Group', AXToolbar: 'ToolBar', AXSheet: 'Window', AXWindow: 'Window', AXWebArea: 'Document', AXSplitGroup: 'Pane' };
const BORING = new Set(['AXGroup', 'AXScrollArea', 'AXSplitGroup', 'AXUnknown', 'AXLayoutArea', 'AXSplitter']);

// One walk of a window: [{ path, role, name, value, enabled, focused }], depth-first.
const WALK = script(`
const w = win(A.hwnd);
const out = [];
function walk(e, p, d) {
  if (out.length >= A.max || d > A.depth) return;
  let kids; try { kids = e.uiElements(); } catch (x) { return; }
  for (let i = 0; i < kids.length && out.length < A.max; i++) {
    const k = kids[i];
    const role = String(safe(() => k.role(), ''));
    let value = safe(() => k.value(), '');
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') value = '';
    out.push({ path: p.concat(i), d: d, role: role, name: label(k), value: String(value), enabled: safe(() => k.enabled(), true), focused: safe(() => k.focused(), false) });
    walk(k, p.concat(i), d + 1);
  }
}
walk(w, [], 0);
return JSON.stringify(out);`);

const one = (s, n) => { s = String(s ?? '').replace(/\r\n|\r|\n/g, ' ⏎ ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
function line(id, e) {
  const type = ROLE[e.role] || e.role.replace(/^AX/, '') || 'Element';
  let s = `[${id}] ${type}`;
  if (e.name) s += ` "${one(e.name, 80)}"`;
  if (e.role === 'AXCheckBox' || e.role === 'AXRadioButton') s += e.value === '1' ? ' on' : ' off';
  else if (e.value && e.value !== e.name) s += ` value="${one(e.value, 80)}"`;
  if (e.enabled === false) s += ' disabled';
  if (e.focused) s += ' focused';
  return s;
}

async function walk(hwnd, depth = 12, max = 300) { return (await run(WALK, { hwnd, depth, max }, 60000)) || []; }

// Act on one element by path; checks it is still what was read.
const ACT = script(`
const w = win(A.hwnd);
const e = at(w, A.path);
const role = String(safe(() => e.role(), ''));
if (A.role && role !== A.role) throw new Error('That control changed (the window is different now). Read the window again.');
function center() { const p = e.position(), s = e.size(); return [p[0] + s[0] / 2, p[1] + s[1] / 2]; }
const has = (name) => safe(() => e.actions.name().indexOf(name) >= 0, false);
switch (A.action) {
  case 'click': case 'invoke':
    if (has('AXPress')) { e.actions['AXPress'].perform(); return 'invoked'; }
    if (has('AXPick')) { e.actions['AXPick'].perform(); return 'selected'; }
    se.click(e); return 'clicked';
  case 'real_click': case 'double_click': case 'right_click': return JSON.stringify({ point: center() });
  case 'set_value': case 'replace_all':
    if (A.action === 'set_value' && (role === 'AXTextArea' || role === 'AXWebArea')) throw new Error('That is a whole document: set_value would replace everything in it. Click into it and use desktop_type, or use action replace_all.');
    e.focused = true; e.value = A.value || ''; return 'value set';
  case 'check': case 'uncheck': {
    const on = String(safe(() => e.value(), '0')) === '1';
    if (on !== (A.action === 'check')) e.actions['AXPress'].perform();
    return A.action === 'check' ? 'on' : 'off'; }
  case 'focus': e.focused = true; return 'focused';
  case 'expand': if (has('AXShowMenu')) { e.actions['AXShowMenu'].perform(); return 'expanded'; } e.actions['AXPress'].perform(); return 'expanded';
  case 'collapse': if (has('AXCancel')) { e.actions['AXCancel'].perform(); return 'collapsed'; } return 'not collapsible';
  case 'select': if (has('AXPick')) { e.actions['AXPick'].perform(); return 'selected'; } e.selected = true; return 'selected';
  case 'scroll_into_view': if (has('AXScrollToVisible')) { e.actions['AXScrollToVisible'].perform(); return 'scrolled'; } return 'not scrollable';
  case 'scroll_down': case 'scroll_up': if (has(A.action === 'scroll_down' ? 'AXScrollDownByPage' : 'AXScrollUpByPage')) { e.actions[A.action === 'scroll_down' ? 'AXScrollDownByPage' : 'AXScrollUpByPage'].perform(); return 'scrolled'; } return 'not scrollable';
}
throw new Error('Unknown action ' + A.action);`);

// CoreGraphics mouse events: real clicks at a point (screen points, top-left origin).
const MOUSE = script(`
ObjC.import('CoreGraphics');
const p = $.CGPointMake(A.x, A.y);
const right = A.button === 'right';
const downT = right ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown, upT = right ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
const btn = right ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, p, btn));
for (let c = 1; c <= Math.max(1, A.count || 1); c++) {
  const d = $.CGEventCreateMouseEvent(null, downT, p, btn), u = $.CGEventCreateMouseEvent(null, upT, p, btn);
  $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, c); $.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, c);
  $.CGEventPost($.kCGHIDEventTap, d); $.CGEventPost($.kCGHIDEventTap, u);
  delay(0.06);
}
return 'clicked';`);

const KEYCODE = { enter: 36, return: 36, tab: 48, space: 49, backspace: 51, delete: 117, del: 117, esc: 53, escape: 53, up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, pageup: 116, pagedown: 121, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
const MOD = { ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down', cmd: 'command down', command: 'command down', win: 'command down', meta: 'command down' };
// On a Mac the everyday shortcuts use Command, so "ctrl+s" from a Windows-minded caller means Cmd+S.
export function parseCombo(combo) {
  const parts = String(combo).split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (String(combo).trim().endsWith('++')) parts.push('+');
  const key = parts.pop();
  const mods = [...new Set(parts.map((m) => {
    if (!MOD[m]) throw new Error(`Unknown key: ${m}`);
    return m === 'ctrl' || m === 'control' ? 'command down' : MOD[m];
  }))];
  return { key, code: KEYCODE[key] ?? null, mods };
}
const KEYS = script(`
if (A.code !== null && A.code !== undefined) se.keyCode(A.code, { using: A.mods }); else se.keystroke(A.key, { using: A.mods });
return 'pressed';`);

const FRONT = script(`
const p = proc(Math.floor(A.hwnd / 100)); p.frontmost = true;
const w = win(A.hwnd); safe(() => w.actions['AXRaise'].perform(), null);
return 'true';`);

const clip = {
  read: () => spawnSync('pbpaste', [], { encoding: 'utf8' }).stdout || '',
  write: (t) => spawnSync('pbcopy', [], { input: t }),
};

async function typeText(text) {
  // Pasting is the only way to type any character (accents, emoji) reliably, and it keeps chat
  // apps from sending at every newline. Their clipboard text is put back after.
  const saved = clip.read();
  clip.write(text);
  await run(KEYS, { key: 'v', code: null, mods: ['command down'] });
  await new Promise((r) => setTimeout(r, 250));
  clip.write(saved);
}

async function screenshot({ hwnd, maxW = 1400 }) {
  const f = path.join(os.tmpdir(), `stead-shot-${process.pid}-${Date.now()}.jpg`);
  let rect = null;
  if (hwnd) {
    await run(FRONT, { hwnd });
    rect = await run(script(`const w = win(A.hwnd); const p = w.position(), s = w.size(); return JSON.stringify([p[0], p[1], s[0], s[1]]);`), { hwnd });
  }
  const args = ['-x', '-t', 'jpg', ...(rect ? ['-R', rect.join(',')] : []), f];
  const r = spawnSync('screencapture', args, { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(f)) throw new Error('macOS blocked the screenshot: allow the app Claude runs in under System Settings > Privacy & Security > Screen Recording.');
  spawnSync('sips', ['-Z', String(maxW), f]);
  const dims = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f], { encoding: 'utf8' }).stdout;
  const width = Number(/pixelWidth: (\d+)/.exec(dims)?.[1] || 0), height = Number(/pixelHeight: (\d+)/.exec(dims)?.[1] || 0);
  const b64 = fs.readFileSync(f).toString('base64');
  fs.rmSync(f, { force: true });
  const originX = rect ? rect[0] : 0, originY = rect ? rect[1] : 0;
  const pointsW = rect ? rect[2] : Number(spawnSync('osascript', ['-e', 'tell application "Finder" to get item 3 of (bounds of window of desktop)'], { encoding: 'utf8' }).stdout.trim()) || width;
  return { b64, originX, originY, scale: width / pointsW, width, height, hwnd: hwnd || 0 };
}

// The same operations host.ps1 answers on Windows.
export async function call(op, a = {}) {
  switch (op) {
    case 'windows': return run(script(`
const out = [];
const procs = se.applicationProcesses.whose({ backgroundOnly: false })();
for (const p of procs) {
  let ws; try { ws = p.windows(); } catch (e) { continue; }
  const pid = p.unixId(), name = p.name(), front = safe(() => p.frontmost(), false);
  ws.slice(0, 99).forEach((w, i) => { try { const pos = w.position(), size = w.size(); out.push({ hwnd: pid * 100 + i + 1, app: name, title: String(safe(() => w.name(), '') || ''), x: pos[0], y: pos[1], w: size[0], h: size[1], active: front && i === 0 }); } catch (e) {} });
}
return JSON.stringify(out);`));
    case 'launch': {
      const r = spawnSync('open', ['-a', a.name], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`No app called "${a.name}" (${(r.stderr || '').trim()})`);
      return `launched ${a.name}`;
    }
    case 'open': {
      const r = spawnSync('open', [a.path], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error((r.stderr || 'could not open it').trim());
      return 'opened';
    }
    case 'focus': case 'focus_for': {
      if (a.id) { const r = ref(a.id); await run(FRONT, { hwnd: r.hwnd }); await run(ACT, { hwnd: r.hwnd, path: r.path, role: r.role, action: 'focus' }); return 'focused'; }
      if (a.hwnd) await run(FRONT, { hwnd: a.hwnd });
      return true;
    }
    case 'tree': {
      const els = await walk(a.hwnd, a.depth || 12, a.max || 300);
      const lines = [];
      for (const e of els) {
        if (BORING.has(e.role) && !e.name) continue;
        lines.push(`${'  '.repeat(Math.min(e.d, 12))}${line(remember({ hwnd: a.hwnd, path: e.path, role: e.role, name: e.name }), e)}`);
      }
      if (els.length >= (a.max || 300)) lines.push('…(truncated: desktop_find searches by name, desktop_read_text gives the words)');
      return lines.join('\n');
    }
    case 'find': {
      const t = String(a.text).toLowerCase();
      const hits = (await walk(a.hwnd, 16, 2000)).filter((e) => e.name.toLowerCase().includes(t)).slice(0, a.limit || 25);
      return hits.length ? hits.map((e) => line(remember({ hwnd: a.hwnd, path: e.path, role: e.role, name: e.name }), e)).join('\n') : 'No controls match.';
    }
    case 'text': {
      if (a.id) { const r = ref(a.id); return run(script(`return String(safe(() => at(win(A.hwnd), A.path).value(), '') || label(at(win(A.hwnd), A.path)));`), { hwnd: r.hwnd, path: r.path }); }
      const els = await walk(a.hwnd, 16, 2000);
      const doc = els.find((e) => e.role === 'AXTextArea' || e.role === 'AXWebArea');
      if (doc && doc.role === 'AXTextArea') return run(script(`return String(safe(() => at(win(A.hwnd), A.path).value(), ''));`), { hwnd: a.hwnd, path: doc.path });
      const seen = new Set();
      return els.map((e) => (e.value && e.value !== e.name ? `${e.name ? `${e.name}: ` : ''}${e.value}` : e.name)).filter((s) => s && !seen.has(s) && seen.add(s)).join('\n').slice(0, a.max || 20000);
    }
    case 'act': case 'act_name': {
      let r;
      if (op === 'act') r = ref(a.id);
      else {
        const want = String(a.name).toLowerCase();
        const typeOk = (e) => !a.type || (ROLE[e.role] || '').toLowerCase() === String(a.type).toLowerCase();
        const els = (await walk(a.hwnd, 16, 2000)).filter((e) => e.name && typeOk(e));
        const score = (e) => { const n = e.name.toLowerCase(); return (n === want ? 0 : n.startsWith(want) ? 10 : n.includes(want) ? 20 : 99) + (e.enabled === false ? 5 : 0); };
        const hits = els.map((e) => [score(e), e]).filter(([s]) => s < 99).sort((x, y) => x[0] - y[0]);
        if (!hits.length) throw new Error(`No control named "${a.name}"${a.type ? ` of type ${a.type}` : ''} in that window. desktop_find lists close names.`);
        const e = hits[Math.min(a.index || 0, hits.length - 1)][1];
        r = { hwnd: a.hwnd, path: e.path, role: e.role, name: e.name };
      }
      const res = await run(ACT, { hwnd: r.hwnd, path: r.path, role: r.role, action: a.action, value: a.value });
      if (res && typeof res === 'object' && res.point) {
        await run(MOUSE, { x: res.point[0], y: res.point[1], button: a.action === 'right_click' ? 'right' : 'left', count: a.action === 'double_click' ? 2 : 1 });
        return a.action.replace('_', '-') + 'ed';
      }
      return `${res}: ${line(op === 'act' ? a.id : remember(r), { ...r, value: '', enabled: true, focused: false })}`;
    }
    case 'window': {
      const action = { close_window: 'close', minimize: 'minimize', maximize: 'zoom', restore: 'restore' }[a.action];
      return run(script(`
const w = win(A.hwnd);
if (A.action === 'close') { const b = w.buttons.whose({ subrole: 'AXCloseButton' })(); if (!b.length) throw new Error('That window has no close button.'); b[0].click(); return 'asked it to close (if it has unsaved work it may ask first: read it again)'; }
if (A.action === 'minimize') { w.attributes['AXMinimized'].value = true; return 'minimized'; }
if (A.action === 'restore') { w.attributes['AXMinimized'].value = false; return 'restored'; }
const z = w.buttons.whose({ subrole: 'AXZoomButton' })(); if (z.length) z[0].click(); return 'maximized';`), { hwnd: a.hwnd, action });
    }
    case 'blocker': return run(script(`
const w = win(A.hwnd);
const sheets = safe(() => w.sheets(), []);
if (!sheets.length) return '';
const s = sheets[0];
const names = safe(() => s.buttons.name(), []).filter(Boolean).slice(0, 6);
return '"' + (label(s) || 'a dialog') + '"' + (names.length ? ' (buttons: ' + names.join(', ') + ')' : '');`), { hwnd: a.hwnd });
    case 'type': await typeText(a.text); return 'typed';
    case 'paste_text': await typeText(a.text); return 'pasted';
    case 'keys': { const k = parseCombo(a.combo); return run(KEYS, k); }
    case 'click': return run(MOUSE, a);
    case 'scroll': throw new Error('Scrolling at a point isn\'t supported on Mac yet: use desktop_act scroll_down / scroll_up on the list, or desktop_keys "pagedown".');
    case 'screenshot': return screenshot(a);
    case 'clipboard': {
      const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); function run(a) { const pb = $.NSPasteboard.generalPasteboard; pb.clearContents; pb.setStringForType($(a[0]), 'public.html'); pb.setStringForType($(a[1]), 'public.utf8-plain-text'); return 'ok'; }`, a.html || '', a.text || String(a.html || '').replace(/<[^>]+>/g, '')], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error((r.stderr || 'clipboard failed').trim());
      return 'clipboard set';
    }
    case 'clipboard_read': return { text: clip.read() };
    case 'idle': {
      const m = /"HIDIdleTime" = (\d+)/.exec(spawnSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8' }).stdout || '');
      return m ? Math.round(Number(m[1]) / 1e6) : 1e9;
    }
    case 'input_blocked': return '';
    default: throw new Error(`unknown op ${op}`);
  }
}
