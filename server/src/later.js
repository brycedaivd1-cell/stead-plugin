// Claude's side of "later": later_add / later_list / later_done, the "Coming up" block in
// brain_recall, and installing the every-minute runner with the OS scheduler. The runner itself
// (later-tick.mjs) is dependency-free and copied into the Stead folder so it survives any install.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_DIR } from './paths.js';
import { heldReason, scriptsIn } from './safety.js';
import * as L from './later-tick.mjs';
import * as W from './watch.mjs';
import { isPaired as phonePaired } from './phone.mjs';

const text = (t, isError = false) => ({ content: [{ type: 'text', text: String(t) }], ...(isError ? { isError: true } : {}) });
const TICK_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'later-tick.mjs');
const TASK = 'Stead reminders';

// ---------- the scheduler ----------
export function installTick(home) {
  fs.mkdirSync(home, { recursive: true });
  // The runner imports phone.mjs and watch.mjs, so they travel together (imports first: a new runner
  // beside an old watch.mjs would fail to start). attention.js is optional; the runner copes without it.
  const dir = path.dirname(TICK_SRC);
  for (const [name, from, optional] of [['watch.mjs'], ['phone.mjs'], ['attention.mjs', path.join('onscreen', 'attention.js'), true], ['later-tick.mjs']]) {
    const dest = path.join(home, name);
    let src;
    try { src = fs.readFileSync(path.join(dir, from || name), 'utf8'); } catch (e) { if (optional) continue; throw e; }
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== src) fs.writeFileSync(dest, src);
  }
  return path.join(home, 'later-tick.mjs');
}

export function schedulerStatus(home = HOME_DIR) {
  // Tests never look at the real Task Scheduler: there, "installed" means the runner was copied in.
  if (process.env.STEAD_NO_SCHEDULER === '1') return fs.existsSync(path.join(home, 'later-tick.mjs'));
  if (process.platform === 'win32') {
    const r = spawnSync('schtasks', ['/Query', '/TN', TASK], { windowsHide: true, encoding: 'utf8' });
    return r.status === 0;
  }
  if (process.platform === 'darwin') return fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.stead.later.plist'));
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  return /later-tick\.mjs/.test(r.stdout || '');
}

// later-scheduler.json: when the task was last registered (and the tick's wake-up time).
const stateFile = (home) => path.join(home, 'later-scheduler.json');
const readState = (home) => { try { return JSON.parse(fs.readFileSync(stateFile(home), 'utf8')); } catch { return {}; } };
const writeState = (home, patch) => { try { fs.writeFileSync(stateFile(home), JSON.stringify({ ...readState(home), ...patch }, null, 2)); } catch {} };

// Registered but not ticking (crashing, pointing at another folder, VBScript switched off) looks
// exactly like running from the outside. The tick's heartbeat tells them apart.
const registeredAt = (home) => Date.parse(readState(home).registeredAt || '') || 0;
export function stalled(home = HOME_DIR) {
  return L.tickHealth(home).stale && Date.now() - registeredAt(home) > 5 * 60000;
}

// The .vbs the task runs (wscript starts node with no console window, so nothing flashes every
// minute). UTF-16 with a BOM: Windows Script Host reads a BOM-less file as ANSI, which garbled a
// non-ASCII user folder (C:\Users\José) so node never started.
export function vbsFor(node, tick) {
  const env = Object.entries(node.env).map(([k, v]) => `sh.Environment("Process")("${k}") = "${v}"\r\n`).join('');
  return `\uFEFFSet sh = CreateObject("WScript.Shell")\r\n${env}sh.Run """${node.bin}"" ""${tick}""", 0, False\r\n`;
}
// Rewrites it only when it changed. The task points at the file, so this alone updates a registered task.
function writeVbs(home, tick) {
  const vbs = path.join(home, 'later-tick.vbs');
  const body = vbsFor(L.nodeBin(), tick);
  let cur = null;
  try { cur = fs.readFileSync(vbs, 'utf16le'); } catch {}
  if (cur !== body) fs.writeFileSync(vbs, body, 'utf16le');
  return vbs;
}

// A fix to the runner reaches people who already have one at their next brain_recall, not only
// at their next new reminder. Once per process; it only refreshes copies that exist.
const refreshed = new Set();
function refreshRunner(home) {
  if (refreshed.has(home)) return;
  refreshed.add(home);
  try {
    if (!fs.existsSync(path.join(home, 'later-tick.mjs'))) return;
    const tick = installTick(home);
    if (process.platform === 'win32' && fs.existsSync(path.join(home, 'later-tick.vbs')) && !L.nodeBin().missing) writeVbs(home, tick);
  } catch {}
}

// Idempotent: refreshes the runner copy every time, registers with the OS scheduler when it isn't
// registered, isn't ticking, or `force`.
export function ensureScheduler(home = HOME_DIR, { force = false } = {}) {
  const tick = installTick(home);
  if (process.env.STEAD_NO_SCHEDULER === '1') return { ok: true, skipped: true }; // tests
  const node = L.nodeBin();
  // Registering Claude.exe would open the Claude app every minute. Say what's missing instead.
  if (node.missing) return { ok: false, error: `the reminder service ${L.NO_NODE}` };
  const done = (r, error) => {
    if (!r) return { ok: false, error };
    writeState(home, { registeredAt: new Date().toISOString(), node: node.bin });
    return { ok: true };
  };
  if (process.platform === 'win32') {
    const vbs = writeVbs(home, tick);
    if (!force && schedulerStatus(home) && !stalled(home)) return { ok: true, already: true };
    // Battery settings matter: Task Scheduler's defaults skip tasks on a laptop running on battery.
    const ps = `
$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $env:STEAD_VBS + '"')
$t1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$t2 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $env:STEAD_TASK -Action $a -Trigger $t1,$t2 -Settings $s -Description 'Stead: reminders and scheduled jobs you asked Claude for. Remove with: npx stead-ai later-off' -Force | Out-Null`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { env: { ...process.env, STEAD_VBS: vbs, STEAD_TASK: TASK }, windowsHide: true, encoding: 'utf8', timeout: 60000 });
    return done(r.status === 0, (r.stderr || r.stdout || '').trim().slice(0, 400));
  }
  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    const plist = path.join(dir, 'com.stead.later.plist');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const env = Object.entries(node.env).map(([k, v]) => `<key>${esc(k)}</key><string>${esc(v)}</string>`).join('');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.stead.later</string>
<key>ProgramArguments</key><array><string>${esc(node.bin)}</string><string>${esc(tick)}</string></array>
${env ? `<key>EnvironmentVariables</key><dict>${env}</dict>\n` : ''}<key>StartInterval</key><integer>60</integer>
<key>RunAtLoad</key><true/>
</dict></plist>
`;
    let cur = null;
    try { cur = fs.readFileSync(plist, 'utf8'); } catch {}
    if (!force && cur === body && !stalled(home)) return { ok: true, already: true };
    fs.writeFileSync(plist, body);
    spawnSync('launchctl', ['unload', '-w', plist]); // fails harmlessly when it wasn't loaded
    const r = spawnSync('launchctl', ['load', '-w', plist], { encoding: 'utf8' });
    return done(r.status === 0, r.stderr);
  }
  const envs = Object.entries(node.env).map(([k, v]) => `${k}=${v} `).join('');
  const line = `* * * * * ${envs}"${node.bin}" "${tick}"`;
  const cur = spawnSync('crontab', ['-l'], { encoding: 'utf8' }).stdout || '';
  if (!force && cur.split('\n').includes(line) && !stalled(home)) return { ok: true, already: true };
  const kept = cur.split('\n').filter((l) => !/later-tick\.mjs/.test(l)).join('\n');
  const r = spawnSync('crontab', ['-'], { input: `${kept.trim() ? kept.replace(/\s*$/, '\n') : ''}${line}\n`, encoding: 'utf8' });
  return done(r.status === 0, r.stderr);
}

export function removeScheduler(home = HOME_DIR) {
  writeState(home, { wakeAt: null, registeredAt: null });
  if (process.platform === 'win32') {
    spawnSync('schtasks', ['/Delete', '/TN', 'Stead wake', '/F'], { windowsHide: true, encoding: 'utf8' });
    return spawnSync('schtasks', ['/Delete', '/TN', TASK, '/F'], { windowsHide: true, encoding: 'utf8' }).status === 0;
  }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.stead.later.plist');
    spawnSync('launchctl', ['unload', '-w', plist]);
    fs.rmSync(plist, { force: true });
    return true;
  }
  const cur = spawnSync('crontab', ['-l'], { encoding: 'utf8' }).stdout || '';
  return spawnSync('crontab', ['-'], { input: cur.split('\n').filter((l) => !/later-tick\.mjs/.test(l)).join('\n'), encoding: 'utf8' }).status === 0;
}

// ---------- what Claude sees ----------
const nowLine = () => `Now: ${L.fmt(new Date())} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;

const WHY = { paused: ' (Stead was paused)', 'no-claude': " (Claude Code isn't set up to run it here)", 'logged-out': ' (Claude Code or Codex is logged out here)' };

function describe(it, now = new Date()) {
  const bits = [`[${it.id}] ${it.kind === 'todo' ? 'to-do' : it.kind.replace('_', '-')}: ${it.what}`];
  if (it.at) bits.push(`${L.fmt(it.at)} (${L.fromNow(it.at, now)})`);
  if (it.before?.length) bits.push(`alerts ${it.before.map((m) => (m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`)).join('+')} before`);
  if (it.repeat) bits.push(`repeats ${it.repeat}${it.until_success ? ' until it succeeds' : ''}`);
  if (it.trigger) bits.push(`runs when ${W.describeTrigger(it.trigger)}${it.lastFired ? `, last ${L.fromNow(it.lastFired, now)}` : ''}`);
  if (it.prep?.url) bits.push(`${it.started ? 'started' : 'not started'}: ${it.prep.url}`);
  if (it.status === 'broken') bits.push(`BROKEN, it no longer fires: ${it.error} Add it again with a valid repeat, then later_done this one with cancel`);
  if (it.pending) bits.push(`DUE NOW: it could not run on its own${WHY[it.pendingWhy] || ''}, so do it now, then later_done it (a repeating job keeps its schedule)`);
  if (it.running) bits.push('running now');
  else if (it.queued) bits.push('waiting its turn to run');
  const last = it.history?.at(-1);
  if (last) bits.push(`last run ${L.fromNow(last.at, now)}: ${last.ok ? '' : 'FAILED '}${last.summary}`);
  return bits.join(' · ');
}

// A line only when timed items exist and the tick has gone quiet: they'd otherwise never fire, silently.
function stallWarning(home, open) {
  if (!open.some((i) => i.status === 'open' && i.at)) return null;
  const h = L.tickHealth(home);
  const reg = registeredAt(home);
  if (h.at && h.error) return `WARNING: the reminder service ran ${L.fromNow(h.at)} but failed: ${h.error}`;
  if ((h.at && h.stale) || (!h.at && reg && Date.now() - reg > 5 * 60000)) {
    return `WARNING: reminders haven't been checked since ${h.at ? L.fmt(h.at) : 'it was set up'}, so they may not fire. Call later_list: it restarts the reminder service.`;
  }
  return null;
}

// For brain_recall: what's coming, so every task starts knowing today's date and what is due.
export function comingUp(home = HOME_DIR) {
  refreshRunner(home);
  const now = new Date();
  let all;
  try { all = L.load(home).items; } catch (e) { return `${nowLine()}\nWARNING: ${e.message}`; }
  const open = all.filter((i) => i.status === 'open' || i.status === 'broken');
  const soon = now.getTime() + 8 * 86400e3;
  const urgent = (i) => (i.pending || i.status === 'broken' ? 1 : 0);
  const lines = open
    .filter((i) => urgent(i) || !i.at || new Date(i.at).getTime() < soon)
    .sort((a, b) => urgent(b) - urgent(a) || new Date(a.at || 8e15) - new Date(b.at || 8e15))
    .slice(0, 25).map((i) => `- ${describe(i, now)}`);
  const later = open.length - lines.length;
  const recent = all.filter((i) => i.history?.length && now - new Date(i.history.at(-1).at) < 86400e3)
    .map((i) => { const h = i.history.at(-1); return `- ${i.what}: ${h.ok ? 'done' : 'FAILED'}, ${h.summary}${h.file ? ` (full report: ${h.file})` : ''}`; });
  const warn = stallWarning(home, open);
  return [nowLine(), ...(warn ? [warn] : []), ...lines, ...(later > 0 ? [`(${later} more further out: later_list)`] : []), ...(recent.length ? ['Scheduled jobs that ran in the last day:', ...recent] : [])].join('\n');
}

// Scheduled commands run in Windows PowerShell 5.1: catch a syntax error now, while someone can fix it.
function psSyntaxError(command) {
  if (process.platform !== 'win32') return null;
  const ps = '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:STEAD_CMD, [ref]$null, [ref]$e); if ($e) { $e[0].Message }';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, STEAD_CMD: command }, windowsHide: true, encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? (r.stdout || '').trim() || null : null;
}

// later_list's last line. A registered task whose tick has gone quiet gets re-registered on the spot.
function serviceLine(home = HOME_DIR) {
  if (!schedulerStatus(home)) return 'Reminder service: not installed yet (it installs itself with the first timed item).';
  const h = L.tickHealth(home);
  if (stalled(home)) {
    const r = ensureScheduler(home, { force: true });
    const was = `it had stopped (last check: ${h.at ? L.fromNow(h.at) : 'never'}${h.error ? `, failing with: ${h.error}` : ''})`;
    return r.ok ? `Reminder service: ${was}, so it was restarted just now. Tell them reminders that were due meanwhile fire within a minute.`
      : `Reminder service: ${was}, and restarting it failed (${r.error}). Tell them reminders won't fire until this is fixed.`;
  }
  if (h.error) return `Reminder service: running, but its last check failed: ${h.error}`;
  return `Reminder service: running (last check ${h.at ? L.fromNow(h.at) : 'pending'}; it catches up after the computer was off or asleep${process.platform === 'win32' ? ', and wakes it for the next alert when it can' : ''}).`;
}

// What happens at the time of a Claude job, said truthfully: it only runs by itself where Claude
// Code (or, for a ChatGPT user, Codex) is installed and signed in. Otherwise they get a nudge and it
// waits for their next chat.
function jobPromise() {
  const c = L.canRunJobs(HOME_DIR);
  const app = c.runner === 'codex' ? 'Codex' : 'Claude Code';
  if (c.ok) return `At that time you will carry it out through ${app} and they get a one-line result. If the computer is off or asleep then, it runs when it is back on.`;
  const fix = c.runner === 'codex'
    ? 'To make jobs run by themselves, sign in to Codex on this computer: run codex login once in a terminal.'
    : 'To make jobs run by themselves, Claude Code must be installed and signed in on this computer: npm install -g @anthropic-ai/claude-code, then run claude once in a terminal and sign in.';
  return c.why === 'logged-out'
    ? `${app} is installed here but not signed in, so this can't run by itself yet: at that time they get a reminder to open Claude, and you do it then. Tell them that, and offer to fix it. ${fix}`
    : `This computer can't run jobs by itself yet (no Claude Code), so at that time they get a reminder to open Claude, and you do it then. Tell them that, and offer to fix it. ${fix}`;
}

function commandError(command) {
  const why = heldReason(command);
  if (why) return `Refused: that command ${why}, and scheduled commands run with nobody there to approve them.`;
  const syntax = psSyntaxError(command);
  return syntax ? `That command won't run: scheduled commands run in Windows PowerShell 5.1 (like computer_command), and it says: ${syntax}` : null;
}

// kind "when": a job that runs on an event, not a time (watch.mjs checks them every tick). Only from
// a chat at the computer: a scheduled job or a phone text setting up more unattended work, started
// by a file name or a page it read, is exactly the loop this must not allow.
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
const away = (k) => process.env[k] && process.env[k] !== '0';
function addTrigger({ what, trigger, task, command, cooldown_min, daily_cap, quiet }) {
  if (away('STEAD_UNATTENDED') || away('STEAD_PHONE')) return text('Refused: a "when" trigger can only be set up in a chat at the computer, not from a scheduled job or the phone.', true);
  if (!task && !command) return text('kind "when" needs a "task" (full instructions for you) or a "command" to run when it fires.', true);
  const t = W.cleanTrigger(trigger, HOME_DIR);
  if (t.error) return text(t.error, true);
  const cmdErr = command && commandError(command);
  if (cmdErr) return text(cmdErr, true);
  const sched = ensureScheduler();
  const scripts = command ? Object.fromEntries(scriptsIn(command).map((f) => [f, L.fingerprint(f)])) : null;
  const now = new Date();
  let item;
  try {
    item = L.update((d) => {
      const it = { id: `l${d.next++}`, kind: 'when', what, at: null, before: [], repeat: null, trigger: t.trigger, task: task || null, command: command || null,
        shell: command ? (process.platform === 'win32' ? 'powershell' : 'sh') : null, cooldown_min: clamp(cooldown_min, 1, 1440, 10), daily_cap: clamp(daily_cap, 1, 50, 5),
        quiet: Boolean(quiet), note: null, status: 'open', created: now.toISOString(), fired: [], ...(scripts && Object.keys(scripts).length ? { scripts } : {}) };
      d.items.push(it);
      return it;
    }, HOME_DIR);
  } catch (e) { return text(e.message, true); }
  const screen = ['idle_return', 'app_open'].includes(t.trigger.type);
  return text([
    `Saved [${item.id}]: ${what}, runs when ${W.describeTrigger(t.trigger)} (at most ${item.daily_cap} a day, ${item.cooldown_min} min apart). Checked once a minute.`,
    screen ? 'This one reads what is on their screen through Stead on screen, so it only fires while that is running.' : '',
    command ? 'When it fires the command runs (what fired is in the STEAD_TRIGGER environment variable, as JSON).' : jobPromise(),
    sched.ok ? '' : `WARNING: could not start the reminder service (${sched.error}), so it won't fire yet.`,
    'They can switch it off on their control page (stead_panel) or with later_done cancel.',
  ].filter(Boolean).join('\n'));
}

export const laterTools = [
  {
    name: 'later_add',
    // The longer how-to (examples, what a job can't do, how jobs run) is in the playbook's LATER
    // section and in what this returns; misuse comes back with an error that says the fix.
    description: `Make something happen later: you only act while a chat is open. Use it unasked for any date, appointment, deadline, "remind me", routine, something they wait on, or a step you promise.
kind: remind (default with a time): a notification; an EVENT always gets alerts_before, usually ["1d","1h"]. do: a job you run then with all your tools (task = full instructions that stand alone; it can't pay, delete, submit forms or ask while they're away). follow_up: they wait on someone; pings them to chase it. todo: no time. when: runs on an event (trigger), not a time.`,
    inputSchema: {
      type: 'object',
      properties: {
        what: { type: 'string', description: 'Notification title, specific: "Ambassador meeting" not "meeting"' },
        kind: { type: 'string', enum: ['remind', 'do', 'follow_up', 'todo', 'when'] },
        trigger: { type: 'object', description: 'kind when: {type:"file",path,pattern} | {type:"idle_return",idle_min} | {type:"app_open",app} | {type:"battery",below}' },
        cooldown_min: { type: 'number', description: 'kind when (default 10)' },
        daily_cap: { type: 'number', description: 'kind when (default 5)' },
        prep: { type: 'object', properties: { url: { type: 'string' } }, description: 'Link to the work; nudges them if not started a day before' },
        when: { type: 'string', description: 'THEIR local YYYY-MM-DDTHH:MM, or +30m/+2h/+3d' },
        alerts_before: { type: 'array', items: { type: 'string' }, description: 'e.g. ["1d","1h"]' },
        repeat: { type: 'string', description: 'hourly|daily|weekdays|weekly|monthly|yearly|"every 30m"|"every 2 weeks"' },
        task: { type: 'string', description: 'kind do/when: full instructions for you then' },
        command: { type: 'string', description: 'Instead of task: a PowerShell command (sh on Mac), e.g. a toolbox script; cheaper for fixed checks' },
        until_success: { type: 'boolean', description: 'Repeating check: stop and notify at the first success' },
        note: { type: 'string', description: 'Notification second line: where, what to bring' },
        quiet: { type: 'boolean', description: 'Notify only on failure' },
      },
      required: ['what'],
    },
    run: async ({ what, kind, when, alerts_before = [], repeat, task, command, until_success, note, quiet, trigger, cooldown_min, daily_cap, prep }) => {
      if (kind === 'when') return addTrigger({ what, trigger, task, command, cooldown_min, daily_cap, quiet });
      kind = kind || (when ? 'remind' : 'todo');
      // Only a web link, kept as a link: it is shown back, never opened or run by Stead.
      if (prep !== undefined) {
        let u = null;
        try { u = new URL(String(prep?.url || '')); } catch {}
        if (!u || !/^https?:$/.test(u.protocol)) return text('prep.url must be a web link (https://...).', true);
        prep = { url: u.href.slice(0, 500) };
      }
      if (kind !== 'todo' && !when) return text('This needs a "when" (their local time as YYYY-MM-DDTHH:MM, or +2h / +3d). Without a time, use kind "todo".', true);
      repeat = repeat ? String(repeat).trim().toLowerCase() : null;
      // Checked here, not at the first fire: a repeat the runner can't step used to stop every reminder.
      const badRepeat = L.repeatError(repeat);
      if (badRepeat) return text(badRepeat, true);
      const cmdErr = command && commandError(command);
      if (cmdErr) return text(cmdErr, true);
      if (kind === 'do' && !task && !command) task = what;
      let at = null;
      let before = [];
      try {
        if (when) at = L.parseWhen(when);
        before = [...new Set(alerts_before.map(L.minutes))].filter((m) => m > 0).sort((a, b) => b - a);
      } catch (e) { return text(e.message, true); }
      const now = new Date();
      if (at && at < now && !repeat) return text(`${L.fmt(at)} is in the past (${nowLine()}). Check the date.`, true);
      // A weekday routine set to start on a Saturday would otherwise fire that Saturday.
      if (at && repeat === 'weekdays') while (at.getDay() === 0 || at.getDay() === 6) at.setDate(at.getDate() + 1);
      const anchor = at && repeat ? L.anchorOf(at) : null;
      if (at && repeat) {
        let step;
        try { step = L.nextOccurrence(at, repeat, at, anchor); } catch (e) { return text(e.message, true); }
        if (!(step > at)) return text(`The repeat "${repeat}" doesn't move forward in time.`, true);
        if (at < now) at = L.nextOccurrence(at, repeat, now, anchor);
      }
      // Anything with a time needs the runner, a timed to-do included.
      const sched = at ? ensureScheduler() : { ok: true };
      // The scripts a command runs, fingerprinted now: one changed later is not run unattended.
      const scripts = command ? Object.fromEntries(scriptsIn(command).map((f) => [f, L.fingerprint(f)])) : null;
      let item;
      try {
        item = L.update((d) => {
          const it = { id: `l${d.next++}`, kind, what, at: at?.toISOString() || null, before, repeat, anchor, task: task || null, command: command || null, shell: command ? (process.platform === 'win32' ? 'powershell' : 'sh') : null, until_success: Boolean(until_success), quiet: Boolean(quiet), note: note || null, status: 'open', created: now.toISOString(), fired: [], ...(scripts && Object.keys(scripts).length ? { scripts } : {}), ...(prep ? { prep } : {}) };
          // Pre-alerts already in the past (a "1 day before" set 3 hours ahead) would fire at once as noise.
          if (at) it.fired = L.alertsOf(it).filter((a) => a.before && a.t <= now.getTime()).map((a) => new Date(a.t).toISOString());
          d.items.push(it);
          return it;
        }, HOME_DIR);
      } catch (e) { return text(e.message, true); }
      const alerts = L.alertsOf(item).filter((a) => a.t > now.getTime()).map((a) => L.fmt(a.t));
      const extra = L.settings(HOME_DIR).notify_command || phonePaired(HOME_DIR) ? ' and their phone' : '';
      return text([
        `Saved [${item.id}]: ${what}${at ? ` for ${L.fmt(at)} (${L.fromNow(at, now)})` : ' (to-do, no time)'}${repeat ? `, repeating ${repeat}` : ''}.`,
        alerts.length ? `Alerts on their computer${extra}: ${alerts.join('; ')}. They come from this computer: if it is off or asleep then, they arrive when it is back on.` : '',
        kind === 'do' ? (command ? 'At that time the command runs and they get the result.' : jobPromise()) : '',
        sched.ok ? '' : `WARNING: could not start the reminder service (${sched.error}). Tell them it is saved but will only show when they next open Claude.`,
        'Tell them the exact day and time back so they can catch a wrong date.',
      ].filter(Boolean).join('\n'));
    },
  },
  {
    name: 'later_list',
    description: 'Show open reminders, jobs, follow-ups and to-dos, and the current date and time.',
    inputSchema: { type: 'object', properties: { include_done: { type: 'boolean' } } },
    run: async ({ include_done }) => {
      let all;
      try { all = L.load(HOME_DIR).items; } catch (e) { return text(`${nowLine()}\n${e.message}`, true); }
      const items = all.filter((i) => include_done || i.status === 'open' || i.status === 'broken');
      const now = new Date();
      return text([nowLine(), ...items.map((i) => `- ${describe(i, now)}${i.status !== 'open' ? ` (${i.status})` : ''}`), items.length ? '' : 'Nothing scheduled.', serviceLine()].join('\n'));
    },
  },
  {
    name: 'later_done',
    description: 'Mark an item done (also after doing a job that waited for you; a repeating one stays scheduled) or cancel it (stops all future alerts and repeats). started: true marks they began; it stays open.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, cancel: { type: 'boolean' }, started: { type: 'boolean' } }, required: ['id'] },
    run: async ({ id, cancel, started }) => {
      let it;
      try {
        it = L.update((d) => {
          const name = String(id).toLowerCase();
          const named = (y) => String(y.what || '').toLowerCase() === name;   // an item missing `what` must not break closing by id
          // An old closed item can share its name with the live one; the live one is meant.
          const x = d.items.find((y) => y.id === id) || d.items.find((y) => named(y) && (y.status === 'open' || y.status === 'broken')) || d.items.find(named);
          if (!x) return null;
          const now = new Date().toISOString();
          if (started && !cancel) { x.started = now; return { ...x, startedOnly: true }; }
          if (!cancel && x.repeat && x.status === 'open') {
            // Doing one occurrence (a job that waited for this chat, today's meds) must not end the routine.
            x.pending = false;
            delete x.pendingWhy;
            x.history = [...(x.history || []), { at: now, ok: true, summary: 'done in chat' }].slice(-10);
            return { ...x, kept: true };
          }
          x.status = cancel ? 'cancelled' : 'done';
          x.pending = false;
          delete x.queued;
          x.closed = now;
          x.closedBy = 'claude';
          return x;
        }, HOME_DIR);
      } catch (e) { return text(e.message, true); }
      if (!it) return text(`No item ${id}. later_list shows the ids.`, true);
      if (it.startedOnly) return text(`Marked started: ${it.what}. It stays on the list until done.`);
      if (it.kept) return text(`Done: ${it.what}. It repeats ${it.repeat}, so it stays scheduled (next: ${L.fmt(it.at)}). To stop it for good, later_done with cancel.`);
      return text(`${cancel ? 'Cancelled' : 'Done'}: ${it.what}.`);
    },
  },
];
