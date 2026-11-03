// Standing grants: "yes, and allow <category> on <host> for 24h". A grant lets the gate go ahead
// without asking again, for one kind of step on one site, a few times, for a while.
//   - The only way one is made is the person's own answer to the gate's pop-up (approve.js check(),
//     answer 'grant'). No tool makes one, and grants.json is a control file: file_write refuses it
//     and a command that touches it needs their yes (safety.js CONTROL_FILES and GUARDED).
//   - Paying and cancelling or changing a paid plan are never granted, whatever the file says, and a
//     step Stead could not check never is either.
//   - A send grant names one exact recipient and only matches a send to that recipient.
// No HMAC: a model with a shell runs as the same user and could read any key. The barrier is the
// control-file fence plus the guarded command paths plus creation only through the pop-up.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME_DIR } from './paths.js';

export const NEVER = new Set(['pay', 'account', 'unknown', 'leak']);
export const DAY_MS = 24 * 3600 * 1000;
export const DEFAULT_USES = 20;

const norm = (s) => String(s ?? '').trim().toLowerCase();

// Can this verdict be offered as a standing grant at all?
export function grantable(v) {
  if (!v || NEVER.has(v.category) || !norm(v.host)) return false;
  if (v.category === 'send' && !norm(v.recipient)) return false;
  return true;
}

// The answer the pop-up offers next to yes and no.
export const offerFor = (v) => `yes, and allow ${v.category}${v.category === 'send' ? ` to ${v.recipient}` : ''} on ${v.host} for 24h`;

const valid = (g, now) => g && typeof g === 'object'
  && !NEVER.has(g.category)
  && norm(g.host)
  && Number.isFinite(g.maxUses) && Number.isFinite(g.used) && g.used < g.maxUses
  && Number.isFinite(g.expires) && g.expires > now
  && g.createdVia === 'elicitation'
  && (g.category !== 'send' || norm(g.recipient));

const targetOk = (g, name) => {
  if (g.target == null || g.target === '') return true;
  try { return new RegExp(g.target, 'i').test(String(name ?? '')); } catch { return false; }
};

export function createGrants({ file = path.join(HOME_DIR, 'grants.json'), now = () => Date.now() } = {}) {
  const load = () => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch { return []; }
  };
  const save = (list) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file);
  };

  // The grant that covers this verdict, with one use spent, or null. Spent and expired grants are
  // dropped from the file as a side effect.
  function match(v) {
    if (!v || NEVER.has(v.category)) return null;
    const t = now();
    const list = load();
    const live = list.filter((g) => valid(g, t));
    const g = live.find((x) => x.category === v.category
      && norm(x.host) === norm(v.host)
      && (x.category !== 'send' || norm(x.recipient) === norm(v.recipient))
      && targetOk(x, v.name));
    if (!g) {
      if (live.length !== list.length) { try { save(live); } catch {} }
      return null;
    }
    g.used += 1;
    try { save(live.filter((x) => x.used < x.maxUses)); } catch { return null; } // can't record the use: don't use it
    return { ...g };
  }

  // Only approve.js calls this, and only with the person's own pop-up answer.
  function add(v, { createdVia, maxUses = DEFAULT_USES, ttlMs = DAY_MS, target = null } = {}) {
    if (createdVia !== 'elicitation') throw new Error('grants are only made from the person\'s own answer');
    if (!grantable(v)) throw new Error(`${v?.category || 'this'} can never be granted${v?.category === 'send' ? ' without one exact recipient' : ''}`);
    const g = {
      id: crypto.randomBytes(4).toString('hex'),
      category: v.category,
      host: norm(v.host),
      ...(v.category === 'send' ? { recipient: norm(v.recipient) } : {}),
      target,
      maxUses,
      used: 0,
      expires: now() + ttlMs,
      createdVia,
    };
    const list = load().filter((x) => valid(x, now()));
    list.push(g);
    save(list);
    return { ...g };
  }

  return { match, add, list: () => load().filter((x) => valid(x, now())), file };
}
