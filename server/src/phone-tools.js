// Claude's side of the phone: connect their phone (Telegram) once, then text them messages and
// files. The listener that turns their texts into work lives in phone.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './paths.js';
import { fencedPath } from './safety.js';
import { ensureScheduler, installTick } from './later.js';
import * as P from './phone.mjs';

const text = (t, isError = false) => ({ content: [{ type: 'text', text: String(t) }], ...(isError ? { isError: true } : {}) });

const HOW = `How they connect their phone (about 2 minutes, free):
1. Install Telegram on their phone (App Store / Play Store) if they don't have it.
2. In Telegram, search for @BotFather (the one with the blue check), tap Start, send /newbot, then
   pick any name and a username ending in "bot" (e.g. maya_helper_bot).
3. BotFather replies with a token like 123456789:AAH... They give it to you: best is
   "npx stead-ai phone" in a terminal on this computer (it never passes through chat); or they paste it
   here and you call phone_setup with token. The token only lets someone send messages as their new bot,
   and they can revoke it any time in BotFather.`;

function start() {
  installTick(HOME_DIR);
  const s = ensureScheduler();
  P.ensureListener(HOME_DIR);
  return s.ok ? '' : `\nWARNING: the background service didn't start (${s.error}), so texts are only answered while this chat is open.`;
}

export const phoneTools = [
  {
    name: 'phone_setup',
    description: 'Let them text you from their phone, anywhere: their texts become jobs you do here, and you text back. Reminders reach it too. Free, via Telegram. No arguments: start or check; token: their bot token; off: true disconnects.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'The bot token from @BotFather, only if they pasted it in chat' },
        off: { type: 'boolean', description: 'Disconnect their phone' },
        voice: { type: 'boolean', description: 'Set up voice notes (~200 MB download), if they ask' },
      },
    },
    run: async ({ token, off, voice }, ctx = {}) => {
      if (off) { P.unpair(HOME_DIR); return text('Disconnected. Their phone no longer reaches this computer. (They can also delete the bot in BotFather.)'); }
      if (voice) {
        const r = await P.setupVoice(HOME_DIR);
        return r.ok ? text('Voice notes are set up: their voice notes are turned into text on this computer (nothing is uploaded). Tell them to try one.') : text(r.error, true);
      }
      const cfg = P.config(HOME_DIR);
      if (cfg?.chatId && !token) {
        return text(`Connected: they text @${cfg.bot} and you work here. Listener ${P.listenerRunning(HOME_DIR) ? 'running' : 'starting'}.${start()}`);
      }
      const pending = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'phone-pairing.json'), 'utf8')); } catch { return null; } })();
      if (!token && pending) {
        const r = await P.waitForPairing(HOME_DIR, 75);
        if (r.ok) return text(`Connected${r.name ? ` to ${r.name}'s phone` : ''}. They got a welcome text. From now on they can text @${pending.bot} anything they'd do on this computer, and "stop" cancels a running job.${start()}`);
        if (r.error) return text(`${r.error} (call phone_setup with the token again for a new code)`, true);
        return text(`Not paired yet. Tell them: open https://t.me/${r.bot} on their phone, tap Start, and send the code ${r.code}. Then call phone_setup again.`);
      }
      if (!token && ctx.askText) {
        const t = await ctx.askText('Paste the bot token BotFather gave you (it looks like 123456789:AAH...). It goes straight to Stead on this computer, not into the chat.', 'Bot token');
        if (t === '') return text('They cancelled. Nothing changed.');
        if (t) token = t;
      }
      if (!token) return text(HOW);
      let p;
      try { p = await P.startPairing(token, HOME_DIR); } catch (e) { return text(`${e.message}\n\n${HOW}`, true); }
      return text(`Token works (bot @${p.bot}). Now tell them exactly this: open ${p.link} on their phone, tap Start, and send the code ${p.code}. Once they say they sent it, call phone_setup again (no arguments) to finish.`);
    },
  },
  {
    name: 'phone_send',
    description: "Text their phone (after phone_setup): a message and/or a file from this computer (up to 50 MB).",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        file: { type: 'string', description: 'Full path' },
      },
    },
    run: async ({ text: t, file }) => {
      if (!P.isPaired(HOME_DIR)) return text('No phone is connected. phone_setup connects one (2 minutes, free).', true);
      if (!t && !file) return text('Give text, file, or both.', true);
      try {
        if (file) {
          if (fencedPath(file)) return text(`Refused: ${file} is in a protected location.`, true);
          if (!fs.existsSync(file)) return text(`No file at ${file}.`, true);
          await P.sendFile(file, t || '', HOME_DIR);
        } else await P.sendText(t, HOME_DIR);
        return text('Sent to their phone.');
      } catch (e) { return text(`Couldn't send: ${e.message}`, true); }
    },
  },
];

export function phoneStatusLine() {
  const cfg = P.config(HOME_DIR);
  return cfg?.chatId
    ? `✓ Phone: they can text @${cfg.bot} from anywhere and you work here.`
    : '· Phone: not connected (optional: phone_setup lets them text you from anywhere, and reminders reach their phone).';
}
