#!/usr/bin/env node
/*
 * delegation-guard.js — PreToolUse (Read|Grep|Glob|Agent|Task)
 *
 * The measurement (scripts/usage.cjs) settled an argument: 68% of all credit spend
 * is cache READS — the main thread re-ingesting ~262k tokens of context on every single turn.
 * Subagents accounted for 0%. The scout/scribe rule in CLAUDE.md had never once fired in
 * 2,831 turns. A rule nobody enforces is a wish.
 *
 * So this enforces it. Two triggers, both narrow on purpose:
 *
 *   1. A big file read into the MAIN thread. Whatever you read stays in context and is
 *      re-read on every later turn — the cost is not the read, it's the tail. scout reads
 *      it in its own context and hands back a paragraph.
 *   2. A long unbroken run of file ops in the main thread with no delegation.
 *
 * It DENIES ONCE and then gets out of the way: the counter resets on the deny, so if Claude
 * re-issues the same call it goes straight through. That interrupts the habit without ever
 * wedging real work — a guard that can deadlock the agent would be turned off within a day,
 * and then it would be enforcing nothing.
 *
 * Subagents are exempt (reading is their whole job). Fails OPEN on every path.
 */
"use strict";

// One-shot headless runs have no context tail to protect, so the guard stays out of the way.
if (process.env.STEAD_HEADLESS === "1") process.exit(0);

const fs = require("fs");
const os = require("os");
const path = require("path");

const TALLY = path.join(os.homedir(), ".stead", "delegation.json");
const BIG_FILE_BYTES = 100 * 1024; // ~25k tokens: one read, then re-read every turn forever
const RUN_LIMIT = 12;              // file ops in the main thread before we interrupt
const TTL_MS = 12 * 60 * 60 * 1000;

function readStdin() {
  try { return fs.readFileSync(0, "utf8").replace(/^﻿/, ""); } catch { return ""; }
}

function emitDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
}

// Are we inside a subagent? Sidechain turns are appended to the same transcript with
// isSidechain: true. Read the tail and look at the most recent assistant record. If we
// cannot tell, assume subagent — a false exemption costs a few tokens, a false DENY on
// scout would break the very delegation this hook exists to encourage.
function isSubagent(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
    const fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let r; try { r = JSON.parse(lines[i]); } catch { continue; }
      if (r.type === "assistant" || r.type === "user") return r.isSidechain === true;
    }
    return false;
  } catch {
    return true; // unreadable transcript -> exempt, never block
  }
}

function loadTally() {
  try {
    const j = JSON.parse(fs.readFileSync(TALLY, "utf8"));
    const now = Date.now();
    for (const k of Object.keys(j)) if (now - (j[k].ts || 0) > TTL_MS) delete j[k];
    return j;
  } catch { return {}; }
}

function saveTally(j) {
  try {
    fs.mkdirSync(path.dirname(TALLY), { recursive: true });
    fs.writeFileSync(TALLY, JSON.stringify(j));
  } catch { /* a tally we cannot persist is not worth failing a tool call over */ }
}

function main() {
  const input = JSON.parse(readStdin() || "{}");
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  const sid = input.session_id || "?";
  if (!tool) return process.exit(0);

  const tally = loadTally();
  const t = (tally[sid] ||= { ops: 0, ts: Date.now() });
  t.ts = Date.now();

  // Delegating resets the run. This is the behavior we want, so reward it and say nothing.
  if (tool === "Agent" || tool === "Task") {
    t.ops = 0;
    saveTally(tally);
    return process.exit(0);
  }

  if (isSubagent(input.transcript_path)) return process.exit(0);

  // Trigger 1: a large file, read whole, into the main thread.
  if (tool === "Read" && ti.file_path && !ti.limit) {
    let size = 0;
    try { size = fs.statSync(ti.file_path).size; } catch { /* not on disk: nothing to judge */ }
    if (size > BIG_FILE_BYTES) {
      const kb = Math.round(size / 1024);
      t.ops = 0;
      saveTally(tally);
      emitDeny(
        `${path.basename(ti.file_path)} is ${kb}KB (~${Math.round(size / 3600)}k tokens). Reading it into the ` +
        `main thread costs far more than one read: it stays in context and is re-ingested on every ` +
        `later turn of this session. Re-sent context is usually the largest share of credit spend.\n\n` +
        `Dispatch the scout agent to read it and return just what you need. If you genuinely need it ` +
        `inline, re-issue this Read with an explicit offset/limit range — a bounded read is allowed, ` +
        `and re-issuing the same call now will also go through.`
      );
      return;
    }
  }

  // Trigger 2: a long run of main-thread file ops with no delegation anywhere in it.
  if (tool === "Read" || tool === "Grep" || tool === "Glob") {
    t.ops += 1;
    if (t.ops > RUN_LIMIT) {
      t.ops = 0; // interrupt once, then let the work continue
      saveTally(tally);
      emitDeny(
        `That's ${RUN_LIMIT + 1} file operations in the main thread with no delegation. Every file you ` +
        `open stays in context and is re-read on every subsequent turn — this is the single largest ` +
        `line item in credit spend.\n\n` +
        `If you are searching or triaging ("where does X happen", "which file defines Y"), dispatch ` +
        `scout — it reads in its own context and returns file:line pointers. If this really is ` +
        `focused work on files you already know you need, re-issue the call and it will go through.`
      );
      return;
    }
  }

  saveTally(tally);
  process.exit(0);
}

try { main(); } catch { process.exit(0); } // fail open: a bug here must never block Claude
