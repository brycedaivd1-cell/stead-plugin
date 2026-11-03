#!/usr/bin/env node
/*
 * usage.js — where the credits actually go.
 *
 * Every assistant message Claude Code writes lands in ~/.claude/projects/<slug>/*.jsonl
 * with its exact token breakdown: fresh input, cache creation (split 5m/1h), cache reads,
 * and output — plus the model, the session, the project, and whether it was the main
 * thread or a subagent. That is a complete, local billing record. Nobody was reading it.
 *
 * This prices it and ranks the drains. Read-only, zero deps, no network.
 *
 *   node usage.js                 last 14 days
 *   node usage.js --days 30       a month
 *   node usage.js --all           everything on disk
 *   node usage.js --json          machine-readable (for the dashboard / other scripts)
 *   node usage.js --since 2026-07-01 --until 2026-07-08 --json
 *                                 an arbitrary window (weekly-improvements.js and
 *                                 weekly-review.js use this to build their own windows —
 *                                 this file is the ONE place prices live; nothing else may
 *                                 hardcode a rate)
 *   node usage.js --dir "C--Users-you-project" --json
 *                                 restrict to one project's transcripts (the literal
 *                                 subfolder name under ~/.claude/projects), instead of
 *                                 every project on disk
 *
 * Caveat worth stating out loud: these are LIST API PRICES. A Max subscription is a flat
 * fee, so the dollars below are not a bill — they are a common yardstick for comparing one
 * drain against another. The ranking is what's true; the absolute number is a proxy.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

// $ per million tokens. Verified live against docs.anthropic.com/en/docs/about-claude/pricing
// on 2026-07-26. Cache write costs 1.25x input at the 5-minute TTL and 2x at the 1-hour TTL;
// a cache read costs 0.1x input. Claude Code writes 1h entries, which is why a cold session
// start is expensive and a warm one is nearly free.
const PRICES = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
  "claude-sonnet-5": { in: 3, out: 15 }, // standard rate, effective 2026-09-01 — see SONNET_5_INTRO
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
// Claude Sonnet 5 launched at an introductory rate that reverts to the standard PRICES row
// above at the cutover date below (both confirmed on the live pricing page, 2026-07-26:
// "through August 31, 2026" -> $2/$10, "starting September 1, 2026" -> $3/$15). Keying this
// off each message's own timestamp means a report spanning the cutover prices each message
// correctly, and nobody has to remember to edit a constant on September 1.
const SONNET_5_INTRO = { in: 2, out: 10 };
const SONNET_5_CUTOVER = Date.parse("2026-09-01T00:00:00Z");
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const CACHE_READ = 0.1;

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const hasRange = args.includes("--since") || args.includes("--until");
const days = args.includes("--all")
  ? Infinity
  : Number(args[args.indexOf("--days") + 1]) || 14;

function priceOf(model, ts) {
  if (model === "claude-sonnet-5" && ts && ts < SONNET_5_CUTOVER) return SONNET_5_INTRO;
  if (PRICES[model]) return PRICES[model];
  // An unknown model is almost always a new release, not a typo. Price it as Opus rather
  // than as zero — a silent zero would hide the exact drain we are hunting.
  const guess = /haiku/.test(model) ? "claude-haiku-4-5"
    : /sonnet/.test(model) ? "claude-sonnet-5"
    : "claude-opus-4-8";
  return PRICES[guess];
}

function cost(u, model, ts) {
  const p = priceOf(model, ts);
  const c = u.cache_creation || {};
  const w5 = c.ephemeral_5m_input_tokens || 0;
  const w1 = c.ephemeral_1h_input_tokens || 0;
  // Older records carry only the flat total; attribute it to the 5m rate (the cheaper of
  // the two) so a missing split under-states rather than over-states the cost.
  const flat = (u.cache_creation_input_tokens || 0) - w5 - w1;
  return (
    ((u.input_tokens || 0) * p.in +
      (u.output_tokens || 0) * p.out +
      (w5 + Math.max(0, flat)) * p.in * CACHE_WRITE_5M +
      w1 * p.in * CACHE_WRITE_1H +
      (u.cache_read_input_tokens || 0) * p.in * CACHE_READ) /
    1e6
  );
}

function blank() {
  return { usd: 0, msgs: 0, in: 0, out: 0, write: 0, read: 0 };
}
function add(b, u, usd) {
  b.usd += usd;
  b.msgs += 1;
  b.in += u.input_tokens || 0;
  b.out += u.output_tokens || 0;
  b.write += u.cache_creation_input_tokens || 0;
  b.read += u.cache_read_input_tokens || 0;
}

const totals = blank();
const byDay = {}, byModel = {}, byProject = {}, bySession = {}, byLane = {};
const seen = new Set(); // one message can be written twice (retry, resume); id de-dupes it
const now = Date.now();
const cutoff = hasRange
  ? (args.includes("--since") ? Date.parse(args[args.indexOf("--since") + 1]) : 0)
  : days === Infinity ? 0 : now - days * 86400000;
const until = hasRange && args.includes("--until") ? Date.parse(args[args.indexOf("--until") + 1]) : now;

const root = path.join(os.homedir(), ".claude", "projects");
const dirs = args.includes("--dir")
  ? [args[args.indexOf("--dir") + 1]]
  : fs.existsSync(root) ? fs.readdirSync(root) : [];
let files = 0;
for (const dir of dirs) {
  const d = path.join(root, dir);
  let entries;
  try { entries = fs.readdirSync(d); } catch { continue; }
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    files++;
    let text;
    try { text = fs.readFileSync(path.join(d, name), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.type !== "assistant" || !r.message || !r.message.usage) continue;
      const id = r.message.id;
      if (id) { if (seen.has(id)) continue; seen.add(id); }

      const t = Date.parse(r.timestamp);
      if (!(t >= cutoff && t < until)) continue;

      const u = r.message.usage;
      const model = r.message.model || "unknown";
      const usd = cost(u, model, t);

      add(totals, u, usd);
      add((byDay[r.timestamp.slice(0, 10)] ||= blank()), u, usd);
      add((byModel[model] ||= blank()), u, usd);
      add((byProject[r.cwd || "?"] ||= blank()), u, usd);
      add((bySession[r.sessionId || "?"] ||= blank()), u, usd);
      add((byLane[r.isSidechain ? "subagent" : "main thread"] ||= blank()), u, usd);
    }
  }
}

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        days,
        since: hasRange ? new Date(cutoff).toISOString() : undefined,
        until: hasRange ? new Date(until).toISOString() : undefined,
        files,
        totals,
        sessions: Object.keys(bySession).length,
        activeDays: Object.keys(byDay).length,
        byDay,
        byModel,
        byProject,
        bySession,
        byLane,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const usd = (n) => "$" + n.toFixed(2);
const tok = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.round(n / 1e3) + "K";
const top = (o, n) => Object.entries(o).sort((a, b) => b[1].usd - a[1].usd).slice(0, n);
const bar = (v, max) => "#".repeat(Math.max(v > 0 ? 1 : 0, Math.round((v / (max || 1)) * 28)));
const pct = (v) => (totals.usd ? ((v / totals.usd) * 100).toFixed(0) + "%" : "0%");

const span = days === Infinity ? "all time" : `last ${days} days`;
console.log(`\nCLAUDE CODE USAGE — ${span}   (${files} transcripts, ${totals.msgs} assistant turns)\n`);
console.log(`  TOTAL ${usd(totals.usd)} at list API prices`);
console.log(
  `  fresh input ${tok(totals.in)} | output ${tok(totals.out)} | cache written ${tok(totals.write)} | cache read ${tok(totals.read)}\n`
);

console.log("BY MODEL");
for (const [k, v] of top(byModel, 8)) {
  console.log(`  ${usd(v.usd).padStart(9)}  ${pct(v.usd).padStart(4)}  ${k}  (${v.msgs} turns)`);
}

console.log("\nMAIN THREAD vs SUBAGENTS");
for (const [k, v] of top(byLane, 4)) {
  console.log(`  ${usd(v.usd).padStart(9)}  ${pct(v.usd).padStart(4)}  ${k}  (${v.msgs} turns)`);
}

console.log("\nBY PROJECT");
for (const [k, v] of top(byProject, 8)) {
  console.log(`  ${usd(v.usd).padStart(9)}  ${pct(v.usd).padStart(4)}  ${k.replace(os.homedir(), "~")}`);
}

console.log("\nTOP SESSIONS  (one runaway session can outweigh a whole week)");
for (const [k, v] of top(bySession, 8)) {
  console.log(`  ${usd(v.usd).padStart(9)}  ${pct(v.usd).padStart(4)}  ${k.slice(0, 8)}  (${v.msgs} turns)`);
}

const dayRows = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));
const peak = Math.max(...dayRows.map(([, v]) => v.usd), 0);
console.log("\nBY DAY");
for (const [k, v] of dayRows) {
  console.log(`  ${k}  ${usd(v.usd).padStart(9)}  ${bar(v.usd, peak)}`);
}

console.log(
  "\nList prices, not a bill — a flat subscription doesn't charge per token. Use the ranking, not the total.\n"
);
