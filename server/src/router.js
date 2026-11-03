// Model routing for phone texts: the cheapest thing that can do the job, never cheaper than safe.
//   tier 0  a built-in read-only toolbox script answers it directly, no model at all
//   tier 1  sonnet, low effort, 20 turns: most texts ("what's due this week", "find my resume")
//   tier 2  opus: anything that pays, sends, posts, deletes, submits or cancels, where a slip costs most
// A tier-1 job that errors or runs out of turns is rerun once on opus (phone.mjs). Every routing
// decision and its outcome lands in route.jsonl, so `node src/router.js replay` can judge the split.
// Later jobs and the onscreen character are not routed yet (their files belong elsewhere).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Words that force opus. Overmatching only costs credits; undermatching puts a risky job on the
// smaller model, so the list leans wide (every tense, the usual synonyms).
export const RISKY = /\b(pay|pays|paid|paying|payment|buy|buys|bought|buying|purchas\w*|checkout|check out|order|orders|ordered|send|sends|sent|sending|reply|replies|forward\w*|post|posts|posted|posting|tweet\w*|publish\w*|delete\w*|deleting|remove\w*|removing|erase\w*|wipe\w*|trash\w*|uninstall\w*|submit\w*|unsubscrib\w*|cancel\w*|transfer\w*|withdraw\w*|venmo|paypal|zelle|sign up|signup|subscribe\w*|renew\w*|book|booking|(?:text|txt|message|dm|email|call)\s+(?!me\b|back\b)[a-z]+)\b/i;

export const TIERS = {
  1: { model: 'sonnet', effort: 'low', maxTurns: 20 },
  2: { model: 'opus', maxTurns: 150 },
};

const STOP = new Set('a an the my me i you your it its is are be to of for in on at and or please can could would will just some all this that these those what whats which how do does did with from by up out get show tell give any about'.split(' '));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');
const words = (s) => String(s).toLowerCase().match(/[a-z]+/g)?.filter((w) => w.length > 1 && !STOP.has(w)).map(stem) || [];

// A short text whose words are nearly all in one tool's name and "does:" line. Strict on purpose: a
// miss costs a model call, a wrong hit texts back the wrong thing.
export function matchTool(text, tools = []) {
  const want = [...new Set(words(text))];
  if (!want.length || want.length > 6) return null;
  let best = null;
  for (const t of tools) {
    const have = new Set(words(`${t.name.replace(/-/g, ' ')} ${t.does || ''}`));
    const hits = want.filter((w) => have.has(w)).length;
    const score = hits / want.length;
    if (hits >= 2 && score >= 0.75 && (!best || score > best.score)) best = { tool: t, score };
  }
  return best?.tool || null;
}

// { tier, tool?, model?, effort?, maxTurns? }. tools: readOnlyTools() from toolbox.js (phone.mjs
// passes them in so this stays pure for tests). Texts with files go to a model: a tool can't see them.
export function route(text, { tools = [], files = false } = {}) {
  if (RISKY.test(String(text))) return { tier: 2, ...TIERS[2] };
  const tool = files ? null : matchTool(text, tools);
  if (tool) return { tier: 0, tool: tool.name };
  return { tier: 1, ...TIERS[1] };
}

export async function readOnlyTools() {
  try { return (await import('./toolbox.js')).readOnlyTools(); } catch { return []; }
}

// Tier 0: run the tool with no args through toolbox_run, so computer_command's safety gate still
// judges the script. { ok, text }; not ok = let a model do it instead.
// It skips the MCP server, so the server's own checks are repeated here: nothing runs before they
// accepted the terms or while Stead is paused (a model then gets the text, and hits the same gate),
// and the run is written to the activity log like any other tool call.
export async function runTool(name) {
  const { hasConsent, isPaused, logAction } = await import('./safety.js');
  if (!hasConsent() || isPaused()) return { ok: false, text: 'not allowed to act right now' };
  const { toolboxTools } = await import('./toolbox.js');
  const run = toolboxTools({ callBrowser: async () => ({ isError: true, content: [{ type: 'text', text: 'no browser here' }] }), ensureChrome: async () => {} }).find((t) => t.name === 'toolbox_run');
  const r = await run.run({ name, args: {} }, {});
  logAction('toolbox_run', { name }, r.isError ? 'failed:phone-tier0' : 'ok:phone-tier0');
  const out = (r.content || []).map((c) => c.text || '').join('\n').replace(/^exit 0\n/, '').trim();
  return { ok: !r.isError && Boolean(out), text: out };
}

// No message text in the log: tier, model, outcome and time are enough to judge the split.
export function logRoute(home, rec) {
  try { fs.appendFileSync(path.join(home, 'route.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n'); } catch {}
}

// Offline: route every text in the phone thread again and count the tiers, plus what route.jsonl
// says actually happened. Free; no model is called and no tool is run.
export async function replay(home) {
  const lines = (p) => { try { return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const tools = await readOnlyTools();
  const tiers = { 0: 0, 1: 0, 2: 0 };
  const texts = lines(path.join(home, 'phone-thread.jsonl')).filter((m) => m.from === 'them');
  for (const m of texts) tiers[route(String(m.text || '').replace(/^\(voice note\)\s*/, ''), { tools, files: /\[sent \d+ file/.test(m.text) }).tier]++;
  const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '-');
  const out = [`${texts.length} texts replayed: tier 0 ${tiers[0]} (${pct(tiers[0], texts.length)}), tier 1 ${tiers[1]} (${pct(tiers[1], texts.length)}), tier 2 ${tiers[2]} (${pct(tiers[2], texts.length)})`];
  const log = lines(path.join(home, 'route.jsonl'));
  if (log.length) {
    const by = {};
    for (const r of log) { const k = `tier ${r.tier}${r.model ? ` ${r.model}` : ''}: ${r.outcome}`; by[k] = (by[k] || 0) + 1; }
    out.push(`route.jsonl, ${log.length} jobs:`, ...Object.entries(by).sort().map(([k, n]) => `  ${k}  ${n}`));
  }
  return out.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'replay') {
  const home = process.argv[3] || (await import('./paths.js')).HOME_DIR || path.join(os.homedir(), '.stead');
  console.log(await replay(home));
}
