#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs, { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, probe, profileDir, findChrome } from '../src/chrome.js';
import { install, uninstall, hasChatGPT, followLatest } from '../src/config.js';
import { installPlugin } from '../src/plugin.js';
import { diagnose, setupChecks, serverStarts, NODE_MIN, nodeMajor } from '../src/doctor.js';
import { hide, show, status as winStatus } from '../src/window.js';
import { HEAL_LOG } from '../src/paths.js';

// Playwright (the browser half) exits on Node older than 20, and inside Claude that shows up only as
// "Server disconnected" with every tool gone. Say it plainly, before anything is set up. Nothing
// imported above loads Playwright, so this runs on old Node too.
if (nodeMajor() < NODE_MIN) {
  console.error(`Stead needs Node.js ${NODE_MIN} or newer, and this computer has ${process.versions.node}.`);
  console.error('Get the current one at nodejs.org (the big green button), then run the same command again.');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const PORT = Number(flag('port', 9222));
const NAME = flag('name', 'default');
const DIR = flag('profile', profileDir(NAME));
const SERVER = NAME === 'default' ? 'stead' : `stead-${NAME}`;
// A browser we don't find on our own (installed somewhere unusual): init saves it into the config.
if (flag('chrome', null)) process.env.STEAD_CHROME = path.resolve(flag('chrome'));
// How to run this copy again: npx once published, the file itself for a local checkout.
const SELF = /[\\/]_npx[\\/]|[\\/]node_modules[\\/]stead(-ai)?[\\/]/.test(HERE) ? 'npx stead-ai' : `node "${join(HERE, 'stead.js')}"`;

// In `serve` the stdout stream IS the MCP transport — anything we print there
// corrupts the protocol. Everything human-facing goes to stderr.
const say = (...a) => (cmd === 'serve' || cmd === 'all' ? console.error(...a) : console.log(...a));

// The package exports "." and "./package.json" but not "./cli.js", so resolve the
// manifest and read its bin field — that survives them renaming the entrypoint.
function resolvePlaywrightMcp() {
  try {
    const manifest = require.resolve('@playwright/mcp/package.json');
    const pkg = require(manifest);
    const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin || {})[0];
    if (bin) {
      const abs = join(dirname(manifest), bin);
      if (existsSync(abs)) return abs;
    }
  } catch {}
  const local = join(HERE, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
  return existsSync(local) ? local : null;
}

function termsSummary() {
  say('This lets Claude act on your computer for you.');
  say('  - It can use websites you log into, your desktop apps, files, and run commands.');
  say('  - It asks you first before paying, sending messages as you, deleting things,');
  say('    submitting official forms, or anything that cannot be undone.');
  say('  - It never types your passwords and never saves card or ID numbers.');
  say('  - Everything stays on this computer. Every action is logged: npx stead-ai log');
  say('  - Stop it any time: npx stead-ai pause');
  say('  - AI can make mistakes. Check important results, and you are responsible for what');
  say('    you ask it to do. Full terms: TERMS.md in this package.');
}

// Plain-language summary of what they're allowing, then an explicit yes. Recorded locally with the
// terms version, so a change to the terms asks again. Returns true, false (they said no), or null
// when nobody can type an answer here.
async function acceptTerms(retry) {
  const { hasConsent, recordConsent, TERMS_VERSION } = await import('../src/safety.js');
  if (hasConsent() && !has('again')) { say(`✓ Terms already accepted (version ${TERMS_VERSION}).`); return true; }
  // The Windows installer shows the terms on its own page and won't continue without "I accept".
  if (has('installer')) { recordConsent('installer'); say(`✓ Accepted in the installer (version ${TERMS_VERSION}).`); return true; }
  // Run by Claude or another program, there's no terminal to answer in, and a prompt nobody can
  // answer used to end the process with exit 0 and nothing set up. Only the person can agree.
  if (!process.stdin.isTTY) return null;
  say('');
  say('Before you continue:');
  termsSummary();
  say('');
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Closing the input (Ctrl+C, end of a pipe) answers "no" instead of leaving the question hanging.
  const raw = await new Promise((done) => {
    rl.once('close', () => done(null));
    rl.once('SIGINT', () => rl.close());
    rl.question('Type "I agree" to accept, anything else to cancel: ', done);
  });
  rl.close();
  // People type what the prompt shows, quotes and all, or add a full stop.
  const a = String(raw ?? '').replace(/["'“”‘’.!]/g, '').trim().toLowerCase();
  if (!['i agree', 'agree', 'i accept', 'yes', 'y'].includes(a)) { say(`Cancelled. Nothing was set up. To try again: ${retry}`); return false; }
  recordConsent('cli');
  say(`✓ Accepted (version ${TERMS_VERSION}).`);
  return true;
}

// What to say when the terms are the only thing left and the person has to do it themselves.
function termsLeft() {
  say('');
  say('One step left, and only you can do it: accept the terms.');
  termsSummary();
  say('');
  say(`Open ${process.platform === 'darwin' ? 'Terminal (Cmd+Space, type terminal, press Enter)' : 'Command Prompt (press Start, type cmd, press Enter)'}, then run:`);
  say(`  ${SELF} accept`);
  say('Until then Claude can look at pages and your memory, but not act.');
}

async function main() {
  switch (cmd) {
    case 'init': {
      if (process.env.STEAD_CHROME && !existsSync(process.env.STEAD_CHROME)) {
        say(`✗ No browser at ${process.env.STEAD_CHROME}. Check the path after --chrome.`);
        process.exit(1);
      }
      const chrome = findChrome();
      if (!chrome) {
        say('✗ No Chrome or Edge found. Install Google Chrome (google.com/chrome), then run this again.');
        process.exit(1);
      }
      say(`✓ Found browser: ${chrome}`);
      // Consent comes first when they can answer; when they can't (Claude ran this), everything
      // else is still set up and the terms are left as the one step only they can do.
      const agreed = await acceptTerms(`${SELF} init`);
      if (agreed === false) process.exit(1);

      const res = await launch({ port: PORT, dir: DIR, startUrl: 'https://www.google.com', visible: true });
      say(res.alreadyRunning
        ? `✓ Already running on port ${PORT} (${res.version})`
        : `✓ Launched ${res.version} on port ${PORT}`);
      say(`  Profile: ${DIR}`);

      // code | desktop | chatgpt | all. Default: both Claude apps, plus ChatGPT/Codex if it's installed.
      const only = flag('app', 'all');
      const want = (a) => only === a || only === 'all' || (only === 'both' && a !== 'chatgpt');
      const chatgpt = only === 'chatgpt' || (only === 'all' && hasChatGPT());
      const results = install({ name: SERVER, port: PORT, local: has('local'), code: want('code'), desktop: want('desktop'), chatgpt });
      for (const r of results) {
        // One unreadable config skips that app only; the others are still set up.
        if (r.error) { say(`✗ Skipped ${r.app}: ${r.error}`); if (r.hint) say(`  ${r.hint}`); continue; }
        say(`✓ ${r.existed ? 'Updated' : 'Added'} Stead in ${r.app}${r.installed ? '' : ' (not installed yet; it will find Stead once you install it)'}  (${r.file})`);
        if (r.backup) say(`  previous config backed up to ${r.backup}`);
      }
      if (results.length && results.every((r) => r.error)) process.exit(1);
      // Other entries of ours still on a bare stead-ai (never updates): point them at @latest.
      for (const f of followLatest()) say(`✓ ${f} now follows the latest release`);

      if (want('code') && !has('no-plugin')) {
        const p = installPlugin();
        say(p.ok
          ? '✓ Installed the Stead plugin for Claude Code (Haiku agents, context guard, /stead:setup)'
          : `  Plugin not installed: ${p.reason}`);
      }

      say('');
      say('Two things left, both one-time:');
      say('  1. In the Chrome window that just opened, log into the sites you want');
      say('     Claude to use: Google, school, email, anything. The profile is permanent,');
      say('     so you never log in again, and your everyday browser is untouched.');
      say('  2. Restart Claude (and ChatGPT, if you use it) so it picks up Stead.');
      say('');
      say('Then just ask Claude to do things: "fill out this form", "put my notes in a Google Doc".');
      if (agreed === null) { termsLeft(); process.exit(2); }
      break;
    }

    case 'launch': {
      const res = await launch({ port: PORT, dir: DIR });
      say(res.alreadyRunning
        ? `stead is already up on port ${PORT} (${res.version})`
        : `stead launched on port ${PORT} (${res.version}) — profile ${DIR}`);
      break;
    }

    case 'doctor': {
      // Setup first: those are the failures a person can't see (old Node, terms, the config Claude
      // actually reads). Each problem comes with the one line that fixes it.
      let bad = 0;
      for (const c of await setupChecks({ name: SERVER, port: PORT, dir: DIR })) {
        // ok null = just information (an app that isn't set up while another one is).
        if (c.ok === false) bad++;
        say(`${c.ok ? '✓' : c.ok === null ? '·' : '✗'} ${c.text}`);
        if (c.fix) say(`    → ${c.fix}`);
      }
      // A bare `npx stead-ai` reuses npx's first cached copy forever: --fix moves it to @latest.
      for (const f of followLatest(undefined, { dryRun: !has('fix') })) {
        if (has('fix')) { say(`✓ ${f} now follows the latest release`); continue; }
        bad++;
        say(`✗ ${f} runs a copy of Stead that never updates`);
        say('    → Run: npx stead-ai doctor --fix');
      }
      const r = await diagnose({ port: PORT, profileMarker: DIR, fix: has('fix') });
      if (!r.up) {
        bad++;
        say(`✗ Browser: ${r.problem}`);
        say(`    → ${r.hint}`);
      } else {
        say(`✓ Browser up on ${PORT} (${r.browser}) — ${r.tabs} tab(s), ${r.procs} process(es)`);
        if (r.wedged.length) say(`  ⚠ ${r.wedged.length} blank/wedged tab(s) — these detach every navigate`);
        if (r.problem) say(`  ⚠ ${r.problem}`);
        for (const w of r.warnings) say(`  ⚠ ${w}`);
        for (const a of r.actions) say(`  → ${a}`);
        if (!r.ok && !has('fix')) { bad++; say('    → Run: npx stead-ai doctor --fix'); }
      }
      // The real start, the way Claude does it: catches a broken install that shows up in Claude
      // only as "Server disconnected". --quick skips it.
      if (!has('quick')) {
        const s = await serverStarts({ port: PORT });
        if (!s.ok) bad++;
        say(s.ok ? `✓ Stead starts (${s.tools} tools)` : `✗ Stead doesn't start: ${s.error}`);
        if (!s.ok) say('    → Run: npx stead-ai report, and send the file to whoever is helping you');
      }
      if (bad) process.exit(1);
      say('Nothing wrong.');
      break;
    }

    case 'serve': {
      // Preflight, every start. This is the part nobody else ships: the two failures that
      // make Stead look dead (runaway processes, a wedged blank tab) get cleared before
      // Claude ever sees a tool. The user never learns they existed.
      if (!(await probe(PORT))) {
        say(`[stead] port ${PORT} is quiet, launching Chrome...`);
        try {
          await launch({ port: PORT, dir: DIR });
        } catch (e) {
          say(`[stead] could not launch Chrome: ${e.message}`);
          if (e.hint) say(`[stead] ${e.hint}`);
        }
      } else {
        // Preflight heals ONLY the harmless thing: wedged blank tabs. It never kills
        // processes and never touches the window. 2026-09-06: an automatic reaper here
        // killed a healthy browser with a login page open — never again. Reaping stays
        // behind an explicit `stead doctor --fix`.
        try {
          const r = await diagnose({ port: PORT, profileMarker: DIR, fix: 'tabs' });
          for (const a of r.actions) say(`[stead] self-heal: ${a}`);
        } catch (e) {
          say(`[stead] preflight skipped: ${e.message}`);
        }
      }
      // --cli <path> pins a specific @playwright/mcp cli.js (testing, or a user who needs a version).
      const cli = flag('cli', null) || resolvePlaywrightMcp();
      if (!cli) {
        say('[stead] @playwright/mcp is missing. Reinstall stead.');
        process.exit(1);
      }
      // Direct passthrough by default — proven, simple, one process in the path.
      // The FACTS/Nelnet click timeouts turned out to be renderer starvation (zombie
      // processes), which the safe preflight above prevents — not something the browser
      // layer needs to paper over on every call. `--heal` opts into the experimental
      // self-healing proxy (retries actionability timeouts with a dispatched event);
      // kept for the rare site that times out even on a healthy browser, off by default.
      if (has('heal')) {
        say('[stead] self-healing proxy enabled (experimental)');
        // Every rescue is logged so failure rates are measured, not guessed.
        const healLog = HEAL_LOG;
        const { startProxy } = await import('../src/proxy.js');
        startProxy({
          cli, port: PORT,
          // The heal layer catches actionability failures, so fail fast (2.5s, not 5s) and let it fix
          // them. Vision adds coordinate clicks for canvas pages (Google Docs, drawn quiz questions).
          args: ['--timeout-action', '2500', '--caps', 'vision'],
          log: (m) => say(`[stead] ${m}`),
          record: (e) => { try { fs.appendFileSync(healLog, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n'); } catch {} },
        });
      } else {
        const child = spawn(process.execPath, [cli, '--cdp-endpoint', `http://127.0.0.1:${PORT}`], { stdio: 'inherit' });
        child.on('exit', (code) => process.exit(code ?? 0));
      }
      break;
    }

    case 'all': {
      // Everything in one server: browser (+heal), desktop, brain, formatted paste.
      const cli = flag('cli', null) || resolvePlaywrightMcp();
      if (!cli) { say('[stead] @playwright/mcp is missing. Reinstall stead.'); process.exit(1); }
      const { startServer } = await import('../src/server.js');
      const pkg = JSON.parse(fs.readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
      await startServer({ cli, port: PORT, dir: DIR, version: pkg.version, log: (m) => say(`[stead] ${m}`) });
      (await import('../src/update.js')).checkSoon(pkg.version);
      break;
    }

    // `self-update`: install the site's newer build (started in the background by a running server).
    // `self-install`: the setup script's step, install the site's build and run init from it.
    case 'self-update':
    case 'self-install': {
      const U = await import('../src/update.js');
      let bin;
      try { bin = U.installVersion(await U.latest(), { quiet: cmd === 'self-update' }); } catch (e) { say(`✗ ${e.message}`); process.exit(1); }
      if (cmd === 'self-install') {
        const r = spawnSync(process.execPath, [bin, 'init', ...process.argv.slice(3)], { stdio: 'inherit' });
        process.exit(r.status ?? 1);
      }
      break;
    }

    case 'activate': {
      const { activate } = await import('../src/license.js');
      const key = process.argv[3];
      if (!key) { say('Usage: npx stead-ai activate <key>'); process.exit(1); }
      const r = activate(key);
      if (!r.ok) { say(`✗ ${r.reason}`); process.exit(1); }
      say(`✓ Activated for ${r.claims.sub} (${r.claims.plan}${r.claims.exp ? `, until ${r.claims.exp}` : ''}). Restart Claude to pick it up.`);
      break;
    }
    case 'license': {
      const { status } = await import('../src/license.js');
      say(status().message);
      break;
    }

    case 'accept': {
      const agreed = await acceptTerms(`${SELF} accept`);
      if (agreed === null) {
        // Claude (or a script) ran this: it can't agree for them, so say exactly what they do.
        say('Only you can accept the terms, in a window where you can type.');
        say(`Open ${process.platform === 'darwin' ? 'Terminal' : 'Command Prompt (press Start, type cmd, press Enter)'} and run: ${SELF} accept`);
        process.exit(2);
      }
      if (!agreed) process.exit(1);
      break;
    }
    case 'pause': {
      const { setPaused } = await import('../src/safety.js');
      setPaused(true);
      say('Paused. Claude can still read, but nothing on this computer can be changed until you run: npx stead-ai resume');
      break;
    }
    case 'resume': {
      const { setPaused } = await import('../src/safety.js');
      setPaused(false);
      say('Resumed. Claude can act for you again.');
      break;
    }
    case 'log': {
      const { HANDS_DIR } = await import('../src/safety.js');
      const f = join(HANDS_DIR, 'activity.log');
      const lines = existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/) : [];
      say(lines.length ? lines.slice(-Number(flag('n', 40))).join('\n') : 'Nothing has been done yet.');
      say(`\nFull log: ${f}`);
      break;
    }

    case 'report': {
      const { hasConsent, isPaused } = await import('../src/safety.js');
      const { build, writeReport } = await import('../src/report.js');
      const d = await diagnose({ port: PORT, profileMarker: DIR, fix: false }).catch((e) => ({ up: false, problem: e.message }));
      const checks = await setupChecks({ name: SERVER, port: PORT, dir: DIR }).catch((e) => [{ ok: false, text: `setup checks failed: ${e.message}` }]);
      const started = await serverStarts({ port: PORT }).catch((e) => ({ ok: false, error: e.message }));
      const doctor = [
        ...checks.map((c) => `${c.ok ? 'ok ' : c.ok === null ? '-  ' : 'BAD'} ${c.text}`),
        started.ok ? `ok  Stead starts (${started.tools} tools)` : `BAD Stead doesn't start: ${started.error}`,
        ...(!d.up
          ? [`BAD Browser not reachable on port ${PORT}: ${d.problem || 'unknown'}`]
          : [`ok  Browser up (${d.browser}), ${d.tabs} tab(s), ${d.procs} process(es)`, ...(d.wedged?.length ? [`${d.wedged.length} wedged tab(s)`] : []), ...(d.problem ? [d.problem] : []), ...(d.warnings || [])]),
      ];
      const file = writeReport(build({ version: JSON.parse(fs.readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version, doctor, terms: hasConsent(), paused: isPaused(), name: SERVER }));
      say(`Report saved: ${file}`);
      say('Private details are removed, but read it before you send it to whoever is helping you.');
      break;
    }

    case 'later': {
      // What's scheduled, from a terminal: the same list Claude sees.
      const { laterTools } = await import('../src/later.js');
      const r = await laterTools.find((t) => t.name === 'later_list').run({ include_done: has('all') });
      say(r.content[0].text);
      break;
    }
    case 'later-test': {
      const { notify } = await import('../src/later-tick.mjs');
      const { HOME_DIR } = await import('../src/paths.js');
      const errs = notify('Stead reminders are working', 'Alerts you ask Claude for will look like this.', HOME_DIR);
      say(errs.length ? `✗ ${errs.join('\n  ')}` : '✓ Sent a test notification.');
      break;
    }
    case 'later-off': {
      const { removeScheduler } = await import('../src/later.js');
      say(removeScheduler() ? '✓ Reminder service removed. Saved items stay in later.json; it comes back with the next reminder you ask for.' : '✗ Could not remove it.');
      break;
    }

    case 'wants': {
      // What Stead learned they keep wanting. `wants capture` is a Claude Code Stop hook: it reads the
      // hook's payload on stdin and learns from what they typed in that chat.
      const W = await import('../src/wants.js');
      const { HOME_DIR } = await import('../src/paths.js');
      if (argv[1] === 'capture') {
        let raw = '';
        for await (const c of process.stdin) raw += c;
        let payload = {}; try { payload = JSON.parse(raw); } catch {}
        say(await W.captureFromHook(payload, HOME_DIR));
        break;
      }
      say(W.topWants(20000) || 'Nothing learned yet. It fills in as you talk to Claude.');
      break;
    }
    case 'loops': {
      // Are the loops that make things stick still running? A weekly job runs this (quiet unless it
      // fails), so a hook that got dropped or a plan that stopped coming shows up as an alert, not a
      // month of silence.
      const { HOME_DIR } = await import('../src/paths.js');
      const age = (f) => { try { return (Date.now() - fs.statSync(path.join(HOME_DIR, f)).mtimeMs) / 864e5; } catch { return Infinity; } };
      const plan = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'plan.json'), 'utf8')); } catch { return null; } })();
      const hooks = (() => { try { return fs.readFileSync(path.join(os.homedir(), 'claude-apps', 'tools', 'stop-hooks.js'), 'utf8'); } catch { return ''; } })();
      const start = (() => { try { return fs.readFileSync(path.join(os.homedir(), 'claude-apps', 'permission-approver', 'session-start.js'), 'utf8'); } catch { return ''; } })();
      const bad = [
        hooks && !/"wants", "capture"/.test(hooks) ? 'the Stop hook no longer captures wants (claude-apps/tools/stop-hooks.js)' : '',
        start && !/wantsBlock()/.test(start) ? 'session start no longer loads wants first (permission-approver/session-start.js)' : '',
        age('wants-seen.json') > 7 ? 'no wants captured from a chat in 7+ days' : '',
        !plan || Date.now() - Date.parse(plan.made) > 4 * 864e5 ? 'no daily plan in 4+ days (is she on screen? settings.daily_plan?)' : '',
      ].filter(Boolean);
      say(bad.length ? `Stead loops broken: ${bad.join('; ')}` : 'Stead loops ok: wants captured, daily plan running.');
      if (bad.length) process.exitCode = 1;
      break;
    }

    case 'phone': {
      // Connect their phone (Telegram) so they can text Claude from anywhere. The token is typed
      // here, in their own terminal, so it never passes through a chat.
      const P = await import('../src/phone.mjs');
      const { HOME_DIR } = await import('../src/paths.js');
      const { ensureScheduler, installTick } = await import('../src/later.js');
      const sub = argv[1];
      if (sub === 'off') { P.unpair(HOME_DIR); say('✓ Disconnected. Your phone no longer reaches this computer.'); break; }
      if (sub === 'test') { await P.sendText('Stead can reach your phone.', HOME_DIR).then(() => say('✓ Sent.'), (e) => say(`✗ ${e.message}`)); break; }
      const cur = P.config(HOME_DIR);
      if (cur?.chatId && sub !== 'again') {
        say(`✓ Connected to @${cur.bot}. Listener: ${P.listenerRunning(HOME_DIR) ? 'running' : 'starts within a minute'}.`);
        say('  stead wants           what Stead learned you keep wanting (wants capture: Claude Code Stop hook)');
      say('  stead phone test    send a test text');
        say('  stead phone off     disconnect');
        say('  stead phone again   connect a different bot');
        break;
      }
      // The token is pasted at a prompt; run by Claude there's nobody to paste it, and the unanswered
      // question used to end with exit 0 and nothing connected.
      if (!process.stdin.isTTY) {
        say(`Connecting a phone needs you at the keyboard: open ${process.platform === 'darwin' ? 'Terminal' : 'Command Prompt (press Start, type cmd, press Enter)'} and run: ${SELF} phone`);
        say('Or ask Claude to connect it with phone_setup.');
        process.exit(2);
      }
      say('Text Claude from your phone, from anywhere. It works on this computer and texts back.');
      say('');
      say('1. Install Telegram on your phone if you don\'t have it.');
      say('2. In Telegram, search @BotFather (blue check), tap Start, send /newbot,');
      say('   pick any name, then a username ending in "bot".');
      say('3. BotFather sends you a token like 123456789:AAH... Copy it.');
      say('');
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const token = (await rl.question('Paste the token here and press Enter: ')).trim();
      rl.close();
      let p;
      try { p = await P.startPairing(token, HOME_DIR); } catch (e) { say(`✗ ${e.message}`); process.exit(1); }
      say('');
      say(`4. On your phone open ${p.link} , tap Start, and send this code: ${p.code}`);
      say('   Waiting for it (3 minutes)...');
      const r = await P.waitForPairing(HOME_DIR, 180);
      if (!r.ok) { say(`✗ Didn't get the code. Run "npx stead-ai phone" again, or ask Claude to finish with phone_setup.`); process.exit(1); }
      installTick(HOME_DIR);
      const s = ensureScheduler();
      P.ensureListener(HOME_DIR);
      say(`✓ Connected${r.name ? ` to ${r.name}'s phone` : ''}. Check Telegram for a welcome text, then text it anything.`);
      if (!s.ok) say(`! The background service didn't start (${s.error}). Texts are answered only while Claude is open.`);
      break;
    }

    case 'panel': {
      // The control page outside a chat: what Stead remembers, what's scheduled, what it did, pause.
      // Its server lives in this process, so the page works until this window is closed.
      const { startPanel, openInBrowser } = await import('../src/panel.js');
      const url = await startPanel();
      if (!has('no-open')) openInBrowser(url);
      say(`Your Stead control page${has('no-open') ? '' : ' is open in your browser'}:`);
      say(`  ${url}`);
      say('It works while this window stays open. Press Ctrl+C to close it.');
      // startPanel unrefs its server (inside Claude it lives as long as the chat), so hold the
      // process open ourselves.
      const keep = setInterval(() => {}, 1 << 30);
      process.once('SIGINT', () => { clearInterval(keep); say('Closed.'); process.exit(0); });
      break;
    }

    case 'show':
    case 'hide': {
      const r = await (cmd === 'show' ? show : hide)(DIR, { port: PORT });
      if (!r.moved) {
        say(`✗ Couldn't find the Stead browser window${r.error ? ` (${r.error})` : ''}. Start it with: ${SELF} launch`);
        process.exit(1);
      }
      say(cmd === 'show'
        ? `On screen (${r.moved} window(s)). Log in, then put it away with: ${SELF} hide`
        : `Off screen (${r.moved} window(s)).`);
      break;
    }
    case 'onscreen':
    case 'buddy': {
      // Stead on screen: the little character on top of their windows. `onscreen` (on), `onscreen off`,
      // `onscreen say <text>`, `onscreen look <look> [color]`, `onscreen reset`, `onscreen prove`. (`buddy` is its old name.)
      const B = await import('../src/onscreen/index.js');
      const sub = process.argv[3];
      if (has('daemon')) { await B.runDaemon(undefined, { log: (m) => say(`[onscreen] ${m}`) }); break; }
      if (process.platform !== 'win32') { say('Stead on screen is Windows only for now.'); break; }
      if (sub === 'off') { B.turnOff(); say(`Stead's off your screen. Bring her back with: ${SELF} onscreen`); break; }
      // `onscreen summon`: back on screen (even if sent away), runs to the mouse, chat open. The
      // taskbar button runs this.
      if (sub === 'summon') { B.turnOn(); B.send({ type: 'anim', name: 'chase' }); B.send({ type: 'chat-open' }); break; }
      // `onscreen shortcut`: a "Stead" shortcut in the Start menu and on the desktop that summons her,
      // with no console window (wscript), ready to pin to the taskbar.
      if (sub === 'shortcut') {
        const { HOME_DIR } = await import('../src/paths.js');
        const vbs = join(HOME_DIR, 'summon.vbs');
        fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${join(HERE, 'stead.js')}"" onscreen summon", 0, False\r\n`);
        // Their character's face: she redraws this file whenever her look changes, so the shortcuts always
        // point at it. Until she's drawn it, Stead's own icon stands in.
        const ico = join(HOME_DIR, 'stead-face.ico');
        if (!fs.existsSync(ico)) fs.copyFileSync(join(HERE, '..', 'installer', 'stead.ico'), ico);
        const lnks = [join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Stead.lnk'), join(os.homedir(), 'Desktop', 'Stead.lnk')];
        const ps = lnks.map((l) => `$s = $w.CreateShortcut('${l}'); $s.TargetPath = "$env:WINDIR\\System32\\wscript.exe"; $s.Arguments = '"${vbs}"'; $s.IconLocation = '${ico}'; $s.Description = 'Call Stead over'; $s.Save()`).join('; ');
        spawnSync('powershell', ['-NoProfile', '-Command', `$w = New-Object -ComObject WScript.Shell; ${ps}`], { stdio: 'inherit' });
        say(`✓ "Stead" is in your Start menu and on your desktop. To put it on the taskbar: right-click it > Pin to taskbar.`);
        break;
      }
      // `onscreen reset`: the orb stays wherever you put it; this sends it back to the bottom right.
      if (sub === 'reset') { B.resetSpot(); say('Back to the bottom right. Drag it anywhere and it stays there.'); break; }
      if (sub === 'prove') { await import('../src/onscreen/prove.mjs'); break; }   // real tasks, checked and scored
      if (sub === 'say') { B.ensureOnscreen(); B.say(process.argv.slice(4).join(' ') || 'Hi!'); say('Said it.'); break; }
      if (sub === 'look') {
        // `onscreen look orb teal`, `onscreen look cat`: what she looks like (kept across restarts).
        const model = (process.argv[4] || '').toLowerCase(), color = process.argv.slice(5).join(' ');
        const looks = B.allLooks();
        if (!looks.includes(model)) { say(`Looks: ${looks.join(', ')}. Optional color after it, e.g. onscreen look orb teal`); break; }
        B.ensureOnscreen(); B.send({ type: 'look', model, color });
        say(`Stead is now a${/^[aeiou]/.test(model) ? 'n' : ''} ${model}${color ? ` (${color})` : ''}.`);
        break;
      }
      try { B.build(); } catch (e) { say(`✗ ${e.message}`); process.exit(1); }
      B.turnOn();
      say('Stead is on your screen. Click her for her menu, drag her around, or tell her to go away.');
      break;
    }

    case 'remove': {
      const r = uninstall({ name: SERVER });
      for (const x of r) say(x.error ? `✗ ${x.app}: ${x.error}` : `✓ Removed Stead from ${x.app}`);
      if (!r.length) say('Stead was not in any Claude config.');
      break;
    }
    case 'where': {
      const r = await winStatus(DIR, { port: PORT });
      for (const w of r.windows) say(`${w.pid ? `pid ${w.pid}` : `window ${w.id}`}  ${w.onScreen ? 'ON SCREEN' : 'off-screen'}  ${JSON.stringify(w.rect)}`);
      if (!r.windows.length) say('no Stead window found');
      break;
    }

    default:
      say('Stead — Claude tells you what to do. Stead lets Claude do it.');
      say('');
      say('  stead init            set it up for Claude (Desktop + Code) and ChatGPT (run this first)');
      say('                        --app code|desktop|chatgpt|all   --local (use this checkout)');
      say('  stead launch          start the browser if it is not already up');
      say('  stead doctor [--fix]  check setup and health; --fix clears wedged tabs and zombies,');
      say('                        --quick skips the test start of the server');
      say('  stead panel           open your control page: memory, reminders, activity, pause');
      say('  stead all             the full MCP server: browser, desktop, brain (Claude runs this)');
      say('  stead serve           browser-only MCP server (older setup)');
      say('  stead activate <key>  turn on a paid key; stead license shows your plan');
      say('  stead accept          read and accept the terms (init asks too)');
      say('  stead pause | resume  stop Claude from changing anything, or let it again');
      say('  stead log [--n 40]    see everything Claude did through Stead');
      say('  stead report          save a problem report (private details removed) to send for help');
      say('  stead later [--all]   reminders and scheduled jobs Claude set up for you');
      say('  stead later-test      send a test notification');
      say('  stead later-off       remove the reminder service');
      say('  stead phone           text Claude from your phone (Telegram); phone test | phone off');
      say('  stead remove          take Stead out of your Claude apps (your memory stays)');
      say('  stead show            bring the window on-screen (to log into something)');
      say('  stead hide            put it back off-screen');
      say('');
      say('  --port <n>     which debugging port      (default 9222)');
      say('  --name <s>     a second, parallel instance with its own profile');
      say('  --chrome <p>   use the browser at this path (init saves it for Claude)');
  }
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  if (e.hint) console.error(`  ${e.hint}`);
  process.exit(1);
});
