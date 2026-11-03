#!/usr/bin/env node
/*
 * Statusline — compact, credit-aware status shown under every prompt.
 * Reads the session JSON Claude Code pipes on stdin and prints ONE line:
 *   <model> · <dir> (<git-branch>) · ctx <used>/<limit> · $<session-cost>
 * Fails safe: any missing field is skipped, any error prints a minimal line.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, "utf8").replace(/^﻿/, "")); } catch { return {}; }
}
function gitBranch(dir) {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: dir, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8",
    }).trim();
  } catch { return ""; }
}
function fmtTokens(n) {
  if (n == null) return null;
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
}

try {
  const d = readStdin();
  const parts = [];

  // Model
  const model = (d.model && (d.model.display_name || d.model.id)) || "";
  if (model) parts.push(model);

  // Directory + git branch
  const cwd = (d.workspace && (d.workspace.current_dir || d.workspace.project_dir)) || d.cwd || process.cwd();
  const dirName = path.basename(cwd);
  const branch = gitBranch(cwd);
  parts.push(branch ? `${dirName} (${branch})` : dirName);

  // Context usage — check several shapes Claude Code has used
  const used =
    (d.context && (d.context.used_tokens ?? d.context.tokens_used)) ??
    d.used_tokens ?? (d.usage && d.usage.total_tokens) ?? null;
  const limit =
    (d.context && (d.context.max_tokens ?? d.context.limit)) ??
    d.context_limit ?? null;
  if (used != null) {
    let ctx = "ctx " + fmtTokens(used);
    if (limit != null) {
      ctx += "/" + fmtTokens(limit);
      const pct = Math.round((used / limit) * 100);
      // Degradation zone starts ~50% — nudge toward /compact there, not at 60%. (2026-07-15)
      // Escalate the wording so a bloated long session is impossible to ignore: the
      // measured top-cost sessions ran at 285k+ ctx for 100s of turns, and cache-read
      // (context re-sent EVERY turn) was 98% of tokens / 73% of proxy cost. (2026-07-15)
      if (pct >= 80) ctx += ` ${pct}% 🛑CLEAR/compact`;
      else if (pct >= 65) ctx += ` ${pct}% ⚠compact`;
      else if (pct >= 50) ctx += ` ${pct}% ·compact`;
      // Burn rate: each turn re-sends the whole context as cache-read. At $1.5/Mtok that's
      // ~$/turn just to keep talking — shown once past the compact line so it stings.
      if (pct >= 50) {
        const perTurn = (used * 1.5) / 1e6; // cache-read proxy $/turn
        if (perTurn >= 0.1) ctx += ` ~$${perTurn.toFixed(2)}/turn`;
      }
    }
    parts.push(ctx);
  }

  // Session cost
  const cost = d.cost && (d.cost.total_cost_usd ?? d.cost.total_usd);
  if (typeof cost === "number") parts.push("$" + cost.toFixed(2));

  process.stdout.write(parts.join("  ·  "));
} catch {
  process.stdout.write("claude");
}
