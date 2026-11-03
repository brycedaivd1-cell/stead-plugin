# How the add-on keeps you safe

Letting an AI act on your computer is powerful, so the important protections are enforced **in
code**, not just requested of the AI. They hold even if Claude gets confused or a web page tries to
trick it.

## Nothing happens until you agree
The add-on can read pages and its notes, but it can't change anything until you've accepted the
terms: the checkbox on the Claude Desktop extension, or "I agree" in `npx stead-ai init`. If the
terms change, it asks again.

## It asks you first
Commands that can't be undone (deleting folders, formatting disks, deleting registry keys, force
pushes, shutting down), commands that run code downloaded from the internet, commands that hide
what they do, commands that switch off antivirus, the firewall or other protection, and anything
touching saved passwords or keys are **held**. Where your Claude app supports it, the add-on asks
**you directly** in a pop-up that Claude can't answer for you. Otherwise Claude must ask you in chat
and pass your yes along. Changing the add-on's own code, its scheduler or its settings needs your yes
too, and a scheduled script that changed after it was set up waits for you instead of running.

Paying, cancelling or changing a paid plan, sending messages as you, posting publicly, deleting,
unsubscribing and the final submit of an official form are checked in code too, by the name of the
button, link, key or desktop control about to be pressed. That covers clicks, Enter, scripts Claude
runs in a page, the site's own "Are you sure?" boxes, and clicks and typing in desktop apps. If the
add-on can't tell what something would press, it asks rather than guessing. A yes covers that one
step (and its one "Confirm"), never a different kind of step. Scheduled jobs run with nobody there
to say yes, so they are refused these steps unless you allowed them.

## Only you give instructions
Web pages, emails and documents are treated as information, never as instructions. If a page says
"run this command" or "send this file", Claude tells you instead of doing it.

## Places it will never write
System folders, program folders, saved-password stores, your everyday browser's profile, SSH and
cloud keys, and its own consent and activity files.

## No passwords, ever
It never types passwords or codes: you log in to sites yourself, once. If Chrome already has your
password saved, the add-on lets Chrome fill it and submits only a plain sign-in form; a password box
next to anything else ("Delete account", "Confirm payment") is left for you. Its memory refuses
passwords, card numbers and ID numbers.

## You can always see and stop it
- `npx stead-ai log` shows every action it took, with the time.
- `npx stead-ai pause` stops all changes instantly; `npx stead-ai resume` turns them back on.
- In Claude Desktop you can also turn the extension off, or set its tools to ask every time.
- `npx stead-ai panel` opens your control page: everything it remembers (edit or delete any
  line), your reminders and scheduled jobs (cancel any), everything it did, and a pause switch.
  It only opens on your own computer, and only through the link it prints.

## Your phone
- Only the phone you paired (by sending a one-time code) can reach your computer. Messages from
  anyone else who finds your bot are dropped before Claude ever sees them.
- What you text is an instruction, like typing in Claude. The same ask-first rules apply: for
  money, messages as you, deletes and official forms it asks you by text and waits for your yes.
- It won't move the mouse or type while someone is using the computer.
- `npx stead-ai phone off` disconnects it. You can also delete the bot in Telegram's @BotFather.

## On the desktop
- It never types into the window you're chatting with Claude in, and it stops when a popup or
  dialog is in front of the window it meant to type into.
- Programs, scripts and files downloaded from the internet open only after your yes. Windows
  security prompts (SmartScreen, "Do you want to allow this app") are always left for you.

## What it can't promise
AI can still misread a page or fill something in wrong, so check important results, especially
forms, money, school and legal matters. These protections make serious mistakes much less likely;
they can't make them impossible.
