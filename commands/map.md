---
description: Generate/refresh MAP.md for the current repo (uses the cheap scout agent)
---
Create or update `MAP.md` at the root of the current repository — a concise navigation map so future sessions read the map instead of exploring files (saves tokens).

1. Dispatch the `scout` agent (Haiku — cheap) to survey the repo: top-level dirs, key files, what each area does, entry points.
2. From scout's report, write/overwrite `./MAP.md`: a tight tree, one line per important file/dir explaining its purpose. Skip node_modules, dist, build, .git.
3. Keep it under ~60 lines. End with `last mapped: <today's date>`.

$ARGUMENTS = a specific subpath to focus on, if given.
