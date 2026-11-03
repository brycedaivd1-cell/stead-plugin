#!/usr/bin/env node
/*
 * session-start.cjs — SessionStart hook for the Stead plugin.
 *
 * Two jobs, both cheap because this text is paid for on every turn:
 *   1. The credit rules, in a few lines. They only work if Claude sees them each session.
 *   2. If the stead MCP server (browser, desktop, memory) isn't registered yet, tell Claude
 *      to offer the one-line install instead of failing silently when a tool is missing.
 * Fails open: any error prints nothing and exits 0.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

function steadRegistered() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    if (j.mcpServers && j.mcpServers.stead) return true;
    for (const p of Object.values(j.projects || {})) if (p.mcpServers && p.mcpServers.stead) return true;
  } catch { /* no config yet */ }
  return false;
}

try {
  const lines = [
    "=== STEAD (credit rules) ===",
    "- Searching or triaging many files: dispatch the stead:scout agent (Haiku) and keep only its conclusion. Mechanical, fully specified edits: stead:scribe.",
    "- Everything read in the main thread is re-sent on every later turn. Read bounded ranges, not whole large files.",
    "- Suggest /compact near 50% context and /clear between unrelated tasks; /stead:handoff before clearing a long task.",
    "- Read MAP.md before exploring a repo if it exists; /stead:map creates it.",
    "- Read pages as text; screenshots only for genuinely visual pages.",
  ];
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") },
  }));
} catch {
  process.exit(0);
}
