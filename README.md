# Stead

Stead lets Claude do tasks on your own computer instead of telling you how. It gives Claude a
Chrome window that stays logged in to your sites, your desktop apps, reminders that fire when no
chat is open, and a memory about you that you can read and edit as plain text. It also adds
cheap helper agents and commands that cut how many credits Claude Code spends.

Works on Windows and macOS (Linux: browser and memory only) in Claude Code and Cowork.
Needs Node.js 20 or newer and Google Chrome.

## Before it can act: accept the terms yourself

Stead can read pages and its memory right away, but it will not click, type, run or change
anything until **you** accept its terms. Open a terminal yourself and run:

```
npx stead-ai accept
```

Type `I agree` when asked. Claude cannot accept for you.

## What it asks you about first

Every time, in chat, and it waits for a yes: paying or buying, cancelling or changing a paid
subscription, sending an email, message or post as you, deleting an account or permanently
deleting data, and the final submit of an official form (government, school, job, medical,
money). It never asks for, types or reads passwords or 2FA codes: when a site needs you to sign
in, it opens that page and hands it to you. Details: [SAFETY.md](SAFETY.md).

Pause it any time with `npx stead-ai pause`; nothing on your computer can change until
`npx stead-ai resume`.

## What it runs on your computer

- **Its own Chrome window**, started with a separate profile (`~/.stead-profile`) and a
  debugging port on `127.0.0.1:9222` only. Your normal Chrome profile is never touched.
- **@playwright/mcp**, as a child process, to drive that Chrome window.
- **Desktop control**: PowerShell and Windows UI Automation on Windows, AppleScript and
  accessibility on macOS, to read and click your desktop apps when you ask.
- **Commands you ask for** through `computer_command`, in your user account, never as admin.
- **A scheduled task only if you set up reminders or the phone link**: Task Scheduler on
  Windows, a LaunchAgent on macOS, cron on Linux. It runs `stead later-tick` to fire your
  reminders. Remove it with `npx stead-ai later-off`.
- **The on-screen character is off** unless you ask for her.

Nothing runs at login unless you set up reminders. This plugin never downloads or installs
updates of itself; updates come only through Claude's plugin updates.

## What it sends, and where

- **To Anthropic**: what Claude reads while working for you (pages, files, your notes) is part
  of your conversation, under your Claude account.
- **To the websites you use**: whatever the task needs, as if you had done it yourself.
- **To Telegram, only if you connect your phone**: the texts and files between your phone and
  your own Telegram bot.
- **To the author of Stead: nothing.** No analytics, no telemetry, no account, no server that
  receives your data. A license key, if you have one, is checked on your computer.

## What it fetches

Nothing on its own. Claude Code installs its npm dependencies (`@modelcontextprotocol/sdk`,
`@playwright/mcp`, `playwright-core`) from the npm registry when you install the plugin.
Pages are loaded only when a task opens them.

## Privacy Policy

Everything Stead stores stays on your computer, in folders you can open and delete:

| What | Where |
|---|---|
| Chrome profile with the sites you sign in to | `~/.stead-profile` |
| Notes about you: details for forms, preferences, your rules (plain text) | `~/.stead/brain` |
| A log of every action it took | `~/.stead/activity.log` |
| Your acceptance of the terms | `~/.stead/consent.json` |
| Reminders and scheduled jobs | `~/.stead/later.json` |
| Phone link, if you connect it: bot token, chat id, recent texts | `~/.stead/phone*` |

Notes are saved only when you tell Claude to remember something or Claude saves a detail a task
needed; you can read, edit or delete any note, and `brain_forget` removes one. The memory refuses
passwords, card numbers and ID numbers, and the activity log masks anything that looks like one.
Stead does not build a profile from your conversations and does not share or sell anything.

To delete everything: uninstall the plugin, then delete `~/.stead` and `~/.stead-profile`.
Nothing remains with the author, because nothing was sent. Full policy: [PRIVACY.md](PRIVACY.md).
Questions: bryce_david1@outlook.com.

## Also in this plugin

- Agents: `scout` and `scribe` (Haiku, for searches and mechanical edits), `researcher`,
  `reviewer`.
- Commands: `/stead:handoff`, `/stead:map`, `/stead:credit-check`.
- Hooks: a short credit-rules note at session start, and a guard that stops one large read
  into the main conversation and suggests a helper agent instead (it lets the retry through). Neither sends anything anywhere.

## License

MIT. See [LICENSE](LICENSE). Terms of use: [TERMS.md](TERMS.md).
