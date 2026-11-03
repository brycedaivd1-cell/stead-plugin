// She proves herself: real tasks typed into her chat, each checked for real (a file on disk, a process
// running, a window open, the right answer), timed, and scored. Needs her running (`stead onscreen`).
// Run: stead onscreen prove   (or node src/onscreen/prove.mjs). Writes <onscreen dir>/prove.json.
// It starts a fresh chat with her, like the chat's NEW button, so what came before can't help her.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { onscreenDir, running } from './index.js';
import { BRAIN_DIR } from '../paths.js';

const dir = onscreenDir();
const outbox = path.join(dir, 'outbox.jsonl'), logFile = path.join(dir, 'onscreen.log'), memFile = path.join(dir, 'memory.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (j) => fs.appendFileSync(outbox, `${JSON.stringify(j)}\n`);
const logSize = () => { try { return fs.statSync(logFile).size; } catch { return 0; } };
const logSince = (from) => { try { return fs.readFileSync(logFile, 'utf8').slice(from); } catch { return ''; } };
const chatLog = () => { try { return JSON.parse(fs.readFileSync(memFile, 'utf8')).chat || []; } catch { return []; } };
const lastReply = () => { try { const c = JSON.parse(fs.readFileSync(memFile, 'utf8')).chat || []; const m = [...c].reverse().find((x) => x.who === 'me'); return m ? m.t : ''; } catch { return ''; } };
const ps = (cmd) => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim(); } catch { return ''; } };
const pids = (name) => ps(`(Get-Process ${name} -ErrorAction SilentlyContinue).Id -join ','`).split(',').filter(Boolean);
const titled = (re) => ps('(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }) -join "`n"').split('\n').some((t) => re.test(t));

// Ask her one thing in the chat window and wait for her to finish (her "mind window" line in the log).
async function ask(text, limit = 90000) {
  const from = logSize(), t0 = Date.now();
  post({ type: 'chat', id: 'window', msg: text });
  while (Date.now() - t0 < limit) {
    await sleep(250);
    const m = /mind window (\d+)ms, (\d+) tools/.exec(logSince(from));
    if (m) { await sleep(300); return { ms: Date.now() - t0, tools: Number(m[2]), reply: lastReply(), log: logSince(from) }; }
    // Things she does without thinking ("open spotify") answer straight away, with no mind line.
    const quick = chatLog().filter((c) => c.at >= t0);
    if (quick.length >= 2 && quick[quick.length - 1].who === 'me' && !/mind (start|ask)/.test(logSince(from))) {
      await sleep(1200);
      if (!/mind window/.test(logSince(from))) return { ms: quick[quick.length - 1].at - t0, tools: 0, reply: lastReply(), log: logSince(from) };
    }
  }
  return { ms: Date.now() - t0, tools: 0, reply: lastReply(), log: logSince(from), timedOut: true };
}
async function fresh() { post({ type: 'chat-new' }); await sleep(1500); }

if (!running()) { console.log('She isn\'t running. Start her first: stead onscreen'); process.exit(1); }

// If she's still answering something (yours, or a run that died), wait it out, or its reply lands on our first task.
for (let t0 = Date.now(), c; (c = chatLog()).length && c[c.length - 1].who !== 'me' && Date.now() - t0 < 120000;) await sleep(1000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stead-prove-'));
const token = `stead-${crypto.randomBytes(3).toString('hex')}`;
const word = ['marigold', 'tangerine', 'lighthouse', 'pinecone', 'saxophone', 'avalanche'][crypto.randomInt(6)] + crypto.randomInt(10, 99);
const notepadBefore = pids('notepad');
const now = new Date();

const tasks = [
  { name: 'Says hi fast', ask: 'hi!', within: 5000, check: (r) => r.reply.length > 0 },
  { name: 'Does math', ask: 'what is 17 times 23?', within: 15000, check: (r) => /\b391\b/.test(r.reply) },
  { name: 'Knows the time', ask: 'what time is it right now?', within: 20000,
    check: (r) => { const h24 = now.getHours(), h12 = h24 % 12 || 12; return new RegExp(`\\b(${h24}|${h12}|${String(h24).padStart(2, '0')}):\\d\\d`).test(r.reply); } },
  { name: 'Makes a file', ask: `make a text file called proof.txt in ${tmp} that says exactly: ${token}`, within: 40000,
    check: () => { try { return fs.readFileSync(path.join(tmp, 'proof.txt'), 'utf8').includes(token); } catch { return false; } } },
  { name: 'Opens an app', ask: 'open notepad', within: 30000,
    check: async () => { for (let i = 0; i < 12; i++) { if (pids('notepad').some((p) => !notepadBefore.includes(p)) || (notepadBefore.length && titled(/Notepad/i))) return true; await sleep(500); } return false; } },
  { name: 'Opens a website', ask: 'open youtube', within: 30000,
    check: async () => { for (let i = 0; i < 12; i++) { if (titled(/YouTube/i)) return true; await sleep(500); } return false; } },
  { name: 'Shows you where', ask: 'show me where the Start button is', within: 40000, check: (r) => /step: Showed you where/i.test(r.log) },
  { name: 'Remembers you', ask: `remember this for later: my test code word is ${word}`, within: 30000, check: () => true, setup: true },
  { name: 'Remembers across chats', before: fresh, ask: 'what is my test code word?', within: 30000, check: (r) => r.reply.toLowerCase().includes(word) },
];

console.log(`Proving Stead on screen: ${tasks.length} tasks.\n`);
await fresh();
const results = [];
for (const t of tasks) {
  if (t.before) await t.before();
  const r = await ask(t.ask);
  const ok = !r.timedOut && await t.check(r);
  const fast = r.ms <= t.within;
  const res = { task: t.name, ask: t.ask, pass: ok, fast, ms: r.ms, tools: r.tools, reply: r.reply.slice(0, 200) };
  if (!t.setup) results.push(res);
  else if (!ok) results.push(res);
  console.log(`${ok ? (fast ? 'PASS' : 'SLOW') : 'FAIL'}  ${t.name.padEnd(24)} ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.tools} tools  ${r.timedOut ? '(timed out) ' : ''}"${r.reply.replace(/\s+/g, ' ').slice(0, 70)}"`);
}

// Clean up after ourselves: the code word, the notepad we opened, the temp folder.
// The word goes straight out of her memory files: brain_forget waits for a yes nobody's here to give.
// Any "test code word" line goes, so a run that died early can't leave one behind either.
try {
  for (const f of fs.readdirSync(BRAIN_DIR).filter((n) => n.endsWith('.md'))) {
    const p = path.join(BRAIN_DIR, f), s = fs.readFileSync(p, 'utf8');
    const lines = s.split('\n'), kept = lines.filter((l) => !/test code word/i.test(l));
    if (kept.length !== lines.length) fs.writeFileSync(p, kept.join('\n'));
  }
} catch {}
for (const p of pids('notepad')) if (!notepadBefore.includes(p)) ps(`Stop-Process -Id ${p} -Force`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

const passed = results.filter((r) => r.pass).length, quick = results.filter((r) => r.pass && r.fast).length;
const score = Math.round((passed / results.length) * 100);
const report = { at: new Date().toISOString(), score, passed, quick, total: results.length, results };
fs.writeFileSync(path.join(dir, 'prove.json'), JSON.stringify(report, null, 2));
console.log(`\nScore: ${passed}/${results.length} passed (${score}%), ${quick} inside their time. Saved to ${path.join(dir, 'prove.json')}`);
process.exit(passed === results.length ? 0 : 1);
