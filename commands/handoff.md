---
description: Write a compact handoff note capturing goal + changed files + next steps, so a fresh session can resume cheaply — then clear
argument-hint: [optional note]
---
Persist the state of the current work to a handoff file so the full history can be dropped (huge cache-read saving) and a fresh session rebuilds context cheaply.

1. Write `HANDOFF.md` in the current working directory containing:
   - **Goal** — what we're trying to accomplish.
   - **Done so far** — key decisions + what's already changed (with file paths).
   - **Changed files** — the exact list touched this session.
   - **Next steps** — the ordered remaining actions, specific enough to act on cold.
   - **Gotchas** — anything non-obvious learned this session.
   - Any note passed in: $ARGUMENTS
2. Keep it tight — this replaces re-sending the whole conversation, so it must be complete but lean.
3. Tell the user it's written and recommend `/clear` (or `/compact`) now to reset the context, then reopen with "read HANDOFF.md and continue."

This is the structured-note-taking pattern: cheaper than carrying a long history forward.
