---
description: Report current credit/token burn and the top levers to cut it right now
allowed-tools: Bash, Read
---
Give the user a fast read on credit usage and what to do about it.

1. Run the usage accounting: `node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.cjs"`. Report the headline numbers.
2. State the context picture: roughly how much is fixed per-turn overhead (CLAUDE.md, always-on MCP tool schemas) vs conversation history. Remind that ~98% of spend is cache-reads (re-sent context), so the levers are:
   - `/clear` between unrelated tasks (a finished task is re-billed every turn until cleared).
   - `/compact` near 50% context, not at the limit.
   - Delegate reads to `scout`/`scribe`; never bulk-read files in the main thread.
   - `/stead:handoff` then clear for long sessions.
3. If context is already past ~50%, say so plainly and recommend compacting now.

Output: the numbers, then the single highest-ROI action for right now. No padding.
