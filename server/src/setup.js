// First-run setup: what's ready and what still needs the person. Claude calls setup_check, then
// walks them through the gaps one at a time, so installing is the only thing they do alone.
import fs from 'node:fs';
import path from 'node:path';
import { BRAIN_DIR } from './brain.js';
import { phoneStatusLine } from './phone-tools.js';
import { canRunJobs } from './later-tick.mjs';
import { setupChecks } from './doctor.js';
import { HOME_DIR } from './paths.js';
import { createPermissions } from './permissions.js';

// Sites people most often need Claude to act in. Detected from cookies in the Stead profile;
// nothing is read beyond "is there a session cookie for this site".
const SITES = [
  { name: 'Google (Gmail, Docs, Drive, Forms)', domain: 'google.com', cookies: ['SID', '__Secure-1PSID', '__Secure-3PSID'] },
  { name: 'Microsoft (Outlook, Word online)', domain: 'live.com', cookies: ['__Host-MSAAUTH', 'MSPAuth', 'ESTSAUTHPERSISTENT'] },
  { name: 'Microsoft work/school account', domain: 'microsoftonline.com', cookies: ['ESTSAUTHPERSISTENT', 'ESTSAUTH'] },
];

function brainState() {
  try {
    const about = fs.readFileSync(path.join(BRAIN_DIR, 'about-me.md'), 'utf8');
    const facts = about.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
    const files = fs.readdirSync(BRAIN_DIR).filter((f) => f.endsWith('.md')).length;
    return { facts, files };
  } catch { return { facts: 0, files: 0 }; }
}

export function setupTools({ port, ensureChrome }) {
  return [{
    name: 'setup_check',
    description: 'Check what is set up for this person and what is missing: browser, which sites they are logged into, what you know about them, desktop control. Run it the first time they use you, when brain_recall shows you know nothing about them, or when they ask to set up.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const lines = [];
      let loggedIn = [];
      try {
        await ensureChrome();
        const { chromium } = await import('playwright-core');
        const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const ctx = b.contexts()[0];
        const cookies = ctx ? await ctx.cookies() : [];
        loggedIn = SITES.filter((s) => cookies.some((c) => c.domain.endsWith(s.domain) && s.cookies.includes(c.name)));
        const domains = new Set(cookies.map((c) => c.domain.replace(/^\./, '').split('.').slice(-2).join('.')));
        lines.push(`✓ Browser ready (${domains.size} sites have saved sessions).`);
        await b.close().catch(() => {});
      } catch (e) {
        lines.push(`✗ Browser not ready: ${e.message}. Chrome or Edge must be installed.`);
      }
      for (const s of SITES) lines.push(`${loggedIn.includes(s) ? '✓' : '·'} ${s.name}: ${loggedIn.includes(s) ? 'logged in' : 'not logged in'}`);
      const brain = brainState();
      lines.push(brain.facts >= 3 ? `✓ You know ${brain.facts} things about them (${brain.files} memory files).` : `· You know almost nothing about them yet (${brain.facts} facts).`);
      lines.push(process.platform === 'win32' ? '✓ Desktop apps: available (Windows).'
        : process.platform === 'darwin' ? '· Desktop apps (Mac, new): they must allow the app you run in (Claude, Terminal or their editor) under System Settings > Privacy & Security > Accessibility, and Screen Recording for screenshots. If a desktop tool fails, say it is new on Mac and use the browser instead.'
          : '· Desktop apps: Windows and Mac only; browser and memory still work.');
      // Whether they have said what Stead may do without asking (Stead's permissions).
      try { lines.push(createPermissions().read().chosen ? '✓ Permissions: they chose what you may do without asking.' : '· Permissions: not chosen yet, so Stead asks before the iffy steps (its defaults).'); } catch {}
      lines.push(phoneStatusLine());
      // Whether "every morning, do X" can run by itself, or will only remind them to ask.
      try {
        const j = canRunJobs(HOME_DIR);
        lines.push(j.ok ? `✓ Jobs while they're away: run through ${j.runner === 'codex' ? 'Codex' : 'Claude Code'} on their own plan.`
          : j.why === 'logged-out' ? `· Jobs while they're away: ${j.runner === 'codex' ? 'Codex' : 'Claude Code'} is installed but signed out (they run "${j.runner === 'codex' ? 'codex login' : 'claude'}" once and sign in). Until then scheduled jobs just remind them.`
            : '· Jobs while they\'re away: need Claude Code (npm install -g @anthropic-ai/claude-code, then run claude once to sign in). Reminders work without it.');
      } catch {}
      // Install problems first (old Node, terms, pause, a Claude app pointing at a deleted copy).
      try {
        const bad = (await setupChecks({ port })).filter((c) => c.ok === false);
        if (bad.length) lines.unshift(...bad.map((c) => `✗ ${c.text}${c.fix ? `. Fix: ${c.fix}` : ''}`));
      } catch {}
      return { content: [{ type: 'text', text: `${lines.join('\n')}

How to finish setup (do one step at a time, in plain words, and let them skip anything):
1. Bring their logins over (fastest): if they use Chrome with saved passwords, open
   chrome://settings/syncSetup in the Stead window, call browser_show, and ask them to turn on sync with
   their Google account. Their saved passwords and Google sign-in come along. Skip if they'd rather not.
2. Ask which sites they want you to use for them (Google, their school or work portal, email). For each
   one not logged in, call browser_login with its sign-in page. Never ask for or type passwords.
   Optional, Claude only: if they use Claude and don't have Claude in Chrome (no mcp__claude-in-chrome__*
   tools), offer it once: "Want Claude in Chrome too? Then I can also use your everyday Chrome, where
   you're already signed in." If they say yes, open https://claude.com/claude-in-chrome in their normal browser
   with computer_command and tell them to click Add to Chrome. Extensions can only be added by them.
3. Ask a few basics forms always need, in one message: full name, email, phone, home address,
   school or job, birthday. Save what they give with brain_save into about-me.md. Tell them they
   can skip anything and can read or edit it any time in ${BRAIN_DIR}.
4. Ask what you may do for them: stead_more { tool: "stead_permissions", args: { action: "ask" } }. It shows
   them the list (sending as them, deleting, forms, commands...) as a form, or gives you the list to show
   in chat as plain choices; save what they pick with action "set". The locked lines never change.
5. Offer the phone once, in one line: "Want to text me from your phone when you're away? Takes 2
   minutes." If yes, phone_setup.
6. Finish with one line on what to ask you, e.g. "fill out this form: <link>".` }] };
    },
  }];
}

// Ready-made requests people pick from Claude's prompt menu (the + menu in Claude Desktop, /commands
// in Claude Code). Each one is a task Stead is proven at, so a first-timer starts with a win.
const P = (name, description, text, args = []) => ({ name, description, text, arguments: args });
export const PROMPTS = [
  P('setup', 'Set up the add-on: log into your sites and teach Claude your basics',
    'Set me up: run setup_check, then walk me through anything missing, one step at a time.'),
  P('fill-form', 'Fill out a form for me',
    'Fill out this form for me: {link}\nUse what you know about me (brain_recall) and ask for anything missing in one message. Stop before the final submit and show me what you filled in.',
    [{ name: 'link', description: "The form's web address", required: true }]),
  P('notes-to-doc', 'Put my notes in a Google Doc',
    'Make a Google Doc from this, with real headings and bullets, and give me the link:\n{notes}',
    [{ name: 'notes', description: 'Your notes, or what the doc should be about', required: true }]),
  P('remind-me', "Make sure I don't forget something",
    "Make sure I don't forget: {what}. Set it up so it reaches me in time, with an alert beforehand, and tell me the day and time back.",
    [{ name: 'what', description: 'What and when, e.g. "dentist Thursday 3pm"', required: true }]),
  P('clean-inbox', 'Clean up my inbox', 'My inbox is full of junk. Show me which subscriptions send me the most email, and after I pick, unsubscribe me from those.'),
  P('due-this-week', "What's due this week?", 'Check Google Classroom (and my school email) and tell me everything due in the next 7 days, soonest first, with the class for each.'),
  P('slow-computer', 'Why is my computer slow?', 'My computer feels slow or full. Find out why and tell me the top fixes in plain words; do the safe ones if I say yes.'),
  P('phone', 'Text Claude from my phone', "I want to text you from my phone when I'm away from the computer. Set it up (phone_setup)."),
];
export const SETUP_PROMPT = PROMPTS[0];
