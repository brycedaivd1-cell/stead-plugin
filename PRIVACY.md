# Privacy Policy

> **DRAFT, not yet in force.** Needs review by a lawyer before launch. Bracketed items are blanks.

Version 2026-09-26

## The short version

The add-on keeps everything on your computer. We don't run a server that receives your data, and
the add-on doesn't send us analytics, your files, your memory notes, or what you ask Claude.

## What is stored, and where

| What | Where | Why |
|---|---|---|
| A separate Chrome profile with the sites you log into | `~/.stead-profile` | so Claude can use sites you're logged into without your passwords |
| Notes about you (details for forms, preferences, your rules) | `~/.stead/brain` | so Claude remembers you; plain text you can read, edit or delete |
| A log of every action | `~/.stead/activity.log` | so you can see exactly what was done |
| Your acceptance of these terms | `~/.stead/consent.json` | so it only asks again when the terms change |
| A log of click rescues (no page contents) | `~/.stead/heal.jsonl` | to measure and fix reliability |
| Your license key, if you have one | `~/.stead/license.key` | checked on your computer only; the add-on never contacts us to check it |
| Your reminders and scheduled jobs | `~/.stead/later.json` | so they happen when no chat is open |
| If you connect your phone: your Telegram bot's token, chat id, recent texts, and files you send | `~/.stead/phone.json`, `phone-thread.jsonl`, `phone-inbox/` | so texts from your phone (and only yours) reach Claude with the conversation so far |

The memory refuses passwords, card numbers and ID numbers. The activity log masks anything that
looks like a card number or password.

## What leaves your computer

- **To Anthropic:** Claude runs on Anthropic's service. What Claude reads while working for you
  (page contents, files, your notes) is sent to Anthropic as part of your conversation, under
  **your** Claude account and Anthropic's privacy policy.
- **To websites:** whatever the task needs, just as if you had done it yourself.
- **To Telegram, if you connect your phone:** the texts and files sent between your phone and your
  bot travel through Telegram, under Telegram's privacy policy.
- **To us:** nothing, unless you email us. [If payment is added: your payment processor's data,
  which we don't see in full.]

## Deleting it

Uninstall the add-on, then delete the `~/.stead` and `~/.stead-profile` folders.
Nothing remains with us, because nothing was sent to us.

## Children

[Age policy, matching the Terms.]

## Contact

[email address]
