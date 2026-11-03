// Plans and license keys, checked entirely on this computer.
//
// Zero infrastructure on purpose: a key is a signed note ("this person, this plan, until this
// date") and the public key below checks the signature offline. Nothing is sent anywhere, so
// PRIVACY.md stays true, and there's no server to pay for or keep up.
//
// To change pricing later, edit POLICY and publish a release. The price itself lives wherever
// keys are sold; the add-on only needs to know whether a key is valid.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR as DATA } from './paths.js';

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAeJU5UnBxMkK803krSXRqMRKD6dJzmNqq/ZpuT6l49WY=
-----END PUBLIC KEY-----`;

export const POLICY = {
  // null = free, with no end date. Bryce's rule: never charge while nobody is paying. A paid plan
  // starts only by publishing a release that sets a date here, announced 30+ days ahead; nothing in
  // the add-on can lock people out by itself.
  freeUntil: null,
  // After freeUntil, tools keep working this many days and each answer carries a notice.
  graceDays: 14,
  price: '$20/month',
  // Where people get a key once it's paid. null = "ask Bryce" until a store exists.
  buyUrl: null,
  contact: 'bryce_david1@outlook.com',
  // Never gated: checking setup and reading their own memory.
  alwaysFree: new Set(['setup_check', 'brain_read', 'brain_search', 'brain_recall', 'brain_forget', 'stead_panel', // seeing and deleting what it knows is never locked
    'phone_setup', 'later_done']), // nor disconnecting their phone or closing a reminder that would keep firing
};

export const LICENSE_FILE = path.join(DATA, 'license.key');
const DAY = 86400000;

const b64u = (s) => Buffer.from(s, 'base64url');

// A key is "<payload>.<signature>", both base64url. Payload: {sub, plan, exp?, iat}.
export function verify(token) {
  try {
    const [p, s] = String(token).trim().split('.');
    if (!p || !s) return null;
    if (!crypto.verify(null, b64u(p), PUBLIC_KEY, b64u(s))) return null;
    const claims = JSON.parse(b64u(p).toString('utf8'));
    return claims && claims.sub && claims.plan ? claims : null;
  } catch { return null; }
}

function readToken() {
  if (process.env.STEAD_LICENSE) return process.env.STEAD_LICENSE;
  try { return fs.readFileSync(LICENSE_FILE, 'utf8'); } catch { return null; }
}

export function activate(token) {
  const claims = verify(token);
  if (!claims) return { ok: false, reason: 'That key is not valid (check it was copied whole).' };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(LICENSE_FILE, String(token).trim());
  return { ok: true, claims };
}

function buyLine() {
  return POLICY.buyUrl ? `Get a key at ${POLICY.buyUrl}` : `Email ${POLICY.contact} for a key`;
}

// A date in a key or in POLICY means the whole of that day, local time, wherever they are.
const endOfDay = (d) => Date.parse(`${d}T23:59:59`);

// mode: licensed | beta | grace | locked
export function status(now = Date.now()) {
  return statusFor(verify(readToken() || ''), now);
}

// Split out so the rules can be checked with any claims, no signing key needed.
export function statusFor(claims, now = Date.now()) {
  const keyEnd = claims?.exp ? endOfDay(claims.exp) : Infinity;
  if (claims && now <= keyEnd) return { mode: 'licensed', claims, message: `Licensed to ${claims.sub} (${claims.plan}${claims.exp ? `, until ${claims.exp}` : ''}).` };

  if (!POLICY.freeUntil) return { mode: 'beta', message: 'Free beta.' };
  const freeEnd = endOfDay(POLICY.freeUntil);
  const lapsed = claims ? ` Your key ended ${claims.exp}.` : '';
  if (now <= freeEnd) return { mode: 'beta', message: `Free beta until ${POLICY.freeUntil}.${lapsed}` };
  // A paid key that runs out gets the same grace as the end of the beta: a renewal that's a few days
  // late never stops someone in the middle of a task.
  const renew = Boolean(claims) && keyEnd > freeEnd;
  const graceEnd = (renew ? keyEnd : freeEnd) + POLICY.graceDays * DAY;
  const how = `${buyLine()}, then run: npx stead-ai activate <key>`;
  if (now <= graceEnd) {
    const left = Math.ceil((graceEnd - now) / DAY);
    return { mode: 'grace', message: renew
      ? `Your Stead key ended ${claims.exp}. Stead keeps working for ${left} more day(s); to keep it going, renew (${POLICY.price}). ${how}`
      : `The free beta ended ${POLICY.freeUntil}.${lapsed} Stead keeps working for ${left} more day(s); after that it needs a key (${POLICY.price}). ${how}` };
  }
  return { mode: 'locked', message: renew
    ? `Your Stead key ended ${claims.exp}, so Stead needs a new one now (${POLICY.price}). ${how}`
    : `The free beta ended ${POLICY.freeUntil}, so Stead needs a key now (${POLICY.price}).${lapsed} ${how}` };
}

// For the tool-call handler: { block } to refuse with a message, { notice } to append one.
export function gate(toolName, now = Date.now()) {
  if (POLICY.alwaysFree.has(toolName)) return {};
  const s = status(now);
  if (s.mode === 'locked') return { block: `${s.message} Tell the person this, in plain words.` };
  if (s.mode === 'grace') return { notice: `(Stead: ${s.message})` };
  return {};
}
