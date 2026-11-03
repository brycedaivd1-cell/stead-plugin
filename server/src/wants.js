// What they want, learned from talking to them, so they never have to ask twice.
//
// Rules (rules.md) only exist when Claude remembers to save one, and it rarely does: the person says
// "just do it, don't ask" five times across five chats and it's never written down. This reads their
// own words after a chat (only theirs: a web page or an email can't plant a want), pulls out what they
// keep wanting, and keeps one ranked list. Every time they say it again it counts up, so the things
// they care about most sit at the top of every chat, and one-off wants that never come back age out.
//
// File: brain/wants.md, one line per want: "- <want> (x3, last 2026-10-26)". Plain text they can edit.
import fs from 'node:fs';
import path from 'node:path';
import { BRAIN_DIR } from './paths.js';

export const WANTS = 'wants.md';
const file = (dir = BRAIN_DIR) => path.join(dir, WANTS);
const LINE = /^- (.+?) \(x(\d+), last (\d{4}-\d{2}-\d{2})\)\s*$/;
const today = () => new Date().toISOString().slice(0, 10);

export function readWants(dir = BRAIN_DIR) {
  let src = '';
  try { src = fs.readFileSync(file(dir), 'utf8'); } catch { return []; }
  return src.split('\n').map((l) => l.match(LINE)).filter(Boolean).map((m) => ({ want: m[1], n: Number(m[2]), last: m[3] }));
}

export function writeWants(list, dir = BRAIN_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const body = rank(list).map((w) => `- ${w.want} (x${w.n}, last ${w.last})`).join('\n');
  fs.writeFileSync(file(dir), `# What I want\n\nLearned from what I keep saying. Most-said first. Edit or delete any line.\n\n${body}\n`);
}

// Most-said first, then most recent.
export const rank = (list) => [...list].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last));

// The top of the list as bullet lines, cut to fit `chars`.
export function topWants(chars = 1500, dir = BRAIN_DIR) {
  const out = [];
  let used = 0;
  for (const w of rank(readWants(dir))) {
    const l = `- ${w.want}${w.n > 1 ? ` (said ${w.n}x)` : ''}`;
    if (used + l.length + 1 > chars) break;
    out.push(l); used += l.length + 1;
  }
  return out.join('\n');
}

// Said once and not again in `days`: it was a one-off, not a want.
export const staleWants = (days = 60, dir = BRAIN_DIR) => {
  const cut = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  return readWants(dir).filter((w) => w.n === 1 && w.last < cut);
};

export function dropWants(wants, dir = BRAIN_DIR) {
  const gone = new Set(wants);
  const list = readWants(dir);
  writeWants(list.filter((w) => !gone.has(w.want)), dir);
  return list.length - readWants(dir).length;
}

const SECRET = /\b(password|passcode|pin|ssn|social security|card number|cvv|\d{6,})\b/i;

export function extractPrompt(said, existing) {
  return `Below are things one person typed to their AI assistant, then the list of standing wants already known about them.

Find STANDING wants: how they want the assistant to work or what they want done regularly, the kind of thing they'd be annoyed to repeat. Examples: "do it end to end; only stop at a password or a payment", "kill things we don't use instead of keeping them", "plan my day from Classroom and email when I sit down". NOT one-off tasks ("open youtube"), not facts about the world, nothing secret.

Reply with JSON only: {"again": [index of each known want they said again, in any words], "new": ["each new standing want, one short imperative line in their voice"]}. Empty lists are fine and usual.

Known wants:
${existing.map((w, i) => `${i}: ${w.want}`).join('\n') || '(none)'}

What they typed:
${said.map((s) => `> ${String(s).replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')}`;
}

// said: their own messages. ai(prompt) -> parsed JSON or null (a cheap model, no tools).
export async function captureWants(said, ai, dir = BRAIN_DIR) {
  said = said.map((s) => String(s || '').trim()).filter((s) => s.length > 12);
  if (!said.length) return { added: 0, again: 0 };
  const list = readWants(dir);
  const r = await ai(extractPrompt(said.slice(-30), list));
  if (!r || typeof r !== 'object') return { added: 0, again: 0 };
  const d = today();
  let again = 0, added = 0;
  for (const i of new Set(Array.isArray(r.again) ? r.again : [])) {
    if (list[i]) { list[i].n++; list[i].last = d; again++; }
  }
  for (const w of Array.isArray(r.new) ? r.new : []) {
    const t = String(w || '').replace(/\s+/g, ' ').replace(/[()]/g, '').trim().slice(0, 200);
    if (t.length < 8 || SECRET.test(t)) continue;
    const same = list.find((x) => x.want.toLowerCase() === t.toLowerCase());
    if (same) { same.n++; same.last = d; again++; } else { list.push({ want: t, n: 1, last: d }); added++; }
  }
  if (again || added) writeWants(list, dir);
  return { added, again };
}

// A cheap model with no tools for the reading: Haiku through their own Claude Code, no MCP, none of
// their hooks (so a Stop hook that captures can't set itself off).
export async function haiku(home) {
  const L = await import('./later-tick.mjs');
  const jobs = L.canRunJobs(home);
  if (!jobs.ok || jobs.runner !== 'claude') return null;
  const none = path.join(home, 'none-mcp.json');
  if (!fs.existsSync(none)) fs.writeFileSync(none, '{"mcpServers":{}}');
  return async (prompt) => {
    const c = L.claudeCommand(L.findClaude(), L.claudeArgs({ mcp: none, model: 'haiku', maxTurns: 2 }));
    const r = await L.runLimited(c.cmd, c.args, { shell: c.shell, input: prompt, timeout: 90000, env: { ...process.env, ...(L.settings(home).claude_env || {}) } });
    const out = L.parseClaudeOutput(r.stdout);
    if (out.is_error || !out.result) return null;
    try { return JSON.parse(String(out.result).match(/\{[\s\S]*\}/)[0]); } catch { return null; }
  };
}

// What they typed in a Claude Code transcript (.jsonl), from line `from` on. Their prompts only:
// not tool results, not hook or system text.
export function typedIn(transcript, from = 0) {
  const lines = fs.readFileSync(transcript, 'utf8').split('\n');
  const said = [];
  for (const l of lines.slice(from)) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.isMeta || j.isSidechain) continue;
    // Typed while Claude was working: queued, then absorbed into the running turn.
    if (j.type === 'attachment' && j.attachment?.type === 'queued_command' && j.attachment.origin?.kind === 'human') { said.push(String(j.attachment.prompt || '').trim()); continue; }
    if (j.type !== 'user') continue;
    const c = j.message?.content;
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
    const mine = t.replace(/<(system-reminder|command-[\w-]+|local-command-[\w-]+|pasted_content[^>]*)>[\s\S]*?<\/\1[^>]*>/g, '').trim();
    if (mine && !/^\[Request interrupted|^Caveat:|^</.test(mine)) said.push(mine);   // <task-notification> and other app text
  }
  return { said, end: lines.length };
}

// Called by a Claude Code Stop hook with its payload. Waits until there are a few new messages, so a
// chat costs one cheap read every few turns, not one per turn.
export async function captureFromHook(payload, home, { every = 4 } = {}) {
  const t = payload?.transcript_path;
  if (!t || !fs.existsSync(t)) return 'no transcript';
  const seenFile = path.join(home, 'wants-seen.json');
  let seen = {}; try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch {}
  const { said, end } = typedIn(t, seen[t] || 0);
  if (said.length < every) return `waiting (${said.length}/${every})`;
  const ai = await haiku(home);
  if (!ai) return 'no claude';
  const r = await captureWants(said, ai);
  seen[t] = end;
  const keys = Object.keys(seen);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete seen[k];
  fs.writeFileSync(seenFile, JSON.stringify(seen));
  return `added ${r.added}, said again ${r.again}`;
}
