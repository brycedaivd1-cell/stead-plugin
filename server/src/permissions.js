// What the person lets Stead do: the iffy steps, each with their own choice ("just do it", "ask me
// each time", "never"), asked once (setup, or when they ask what Stead may do) and kept in
// permissions.json. The approval gate (approve.js) reads it on every held step.
//   - Nothing chosen, or a broken file: every line is its default, which is how Stead behaved before
//     anyone could choose. Choosing only ever moves the lines they picked.
//   - The locked lines (paying, a paid plan, an official form's final submit, deleting for good,
//     passwords) are shown so they know, and no choice or file changes them: the gate never asks
//     this file about them.
//   - A choice that loosens a line is only saved from the person's own answer: their pop-up or their
//     form, never on Claude's word (a yes "relayed" from chat could be a page talking), the same as a
//     grant. A loosened line is stronger than a grant (every site, no end, scheduled jobs too), so no
//     confirmed flag stands in for them. Tightening is saved straight away. permissions.json is a control file: file_write refuses it
//     and a command that touches it needs their yes (safety.js CONTROL_FILES and GUARDED).
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR } from './paths.js';

const WORDS = { go: 'just do it', ask: 'ask me each time', never: 'never' };

// choices: loosest first. cats: the gate categories the line covers.
export const ITEMS = [
  { id: 'send', label: 'Send emails, messages and posts as me', choices: ['go', 'ask', 'never'], def: 'ask', cats: ['send', 'post'] },
  { id: 'delete', label: 'Delete files or emails (recoverable: they go to the trash)', choices: ['go', 'ask', 'never'], def: 'ask', cats: ['delete'] },
  { id: 'forms', label: 'Submit forms (not official ones: government, school, job, medical and money forms always ask)', choices: ['go', 'ask'], def: 'go', cats: ['form'] },
  { id: 'batch', label: 'One "yes" covers a whole multi-step task (several clicks)', choices: ['go', 'some', 'ask'], def: 'some', cats: [],
    words: { go: 'just do it (15 minutes, same site)', some: 'only its confirm step and a quick cleanup', ask: 'ask me each step' } },
  { id: 'remember', label: 'Remember a "yes" for 24 hours for the same kind of step on the same site', choices: ['go', 'never'], def: 'go', cats: [],
    words: { go: 'offer it when asking', never: 'never' } },
  { id: 'steered', label: 'Keep going after a web page tried to give Stead instructions', choices: ['go', 'ask', 'never'], def: 'ask', cats: ['leak'],
    words: { go: 'just do it', ask: 'ask me each time', never: 'stop' } },
  { id: 'commands', label: 'Run commands on the computer (saved script tools, terminals and script files too)', choices: ['go', 'ask', 'never'], def: 'go', cats: ['command'] },
  { id: 'install', label: 'Install apps and packages', choices: ['go', 'ask', 'never'], def: 'go', cats: ['install'] },
  { id: 'settings', label: 'Change account settings', choices: ['go', 'ask', 'never'], def: 'go', cats: ['settings'] },
];

// Shown, never changeable. The gate looks up only the categories an item above names (cats), so
// pay, account, submit and unknown never reach this file.
export const LOCKED = [
  ['Pay or buy anything', 'always ask'],
  ['Cancel, downgrade or change a paid plan', 'always ask'],
  ['The final submit of an official form (government, school, job, medical, money)', 'always ask'],
  ['Delete for good (empty the trash, delete an account)', 'always ask'],
  ['Type, read or save passwords and 2FA codes', 'never'],
];
const LOCKED_IDS = /^(pay|payments?|purchases?|buy|account|plan|official|submit|passwords?|2fa|codes?|unknown)$/i;

const byId = new Map(ITEMS.map((i) => [i.id, i]));
// The line that covers a gate category, or null (then nothing they pick touches it).
export const itemFor = (category) => ITEMS.find((i) => i.cats.includes(category)) || null;
export const wordFor = (item, c) => (item.words && item.words[c]) || WORDS[c] || c;
export const defaults = () => Object.fromEntries(ITEMS.map((i) => [i.id, i.def]));

// "just do it", "Ask me each time", "go": the choice's key, or null.
export function choiceOf(item, value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  return item.choices.find((c) => c === v || wordFor(item, c).toLowerCase() === v || WORDS[c] === v) || null;
}

// Looser = earlier in the item's list.
export const looser = (item, a, b) => item.choices.indexOf(a) < item.choices.indexOf(b);

export function createPermissions({ file = path.join(HOME_DIR, 'permissions.json'), now = () => Date.now() } = {}) {
  // Every line's choice. A missing, broken or tampered file gives the defaults for whatever it got wrong.
  const read = () => {
    const out = defaults();
    let j = null;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { choices: out, chosen: false }; }
    const c = j && typeof j === 'object' && j.choices && typeof j.choices === 'object' && !Array.isArray(j.choices) ? j.choices : {};
    for (const item of ITEMS) {
      const k = typeof c[item.id] === 'string' && item.choices.includes(c[item.id]) ? c[item.id] : null;
      if (k) out[item.id] = k;
    }
    return { choices: out, chosen: Number.isFinite(j?.at), at: j?.at };
  };
  const save = (choices) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, at: now(), choices }, null, 2));
    fs.renameSync(tmp, file);
  };

  // What a set of answers would change: { changes: [{item, from, to, looser}], bad: [why...] }.
  function plan(answers = {}) {
    const cur = read().choices;
    const changes = [], bad = [];
    for (const [id, value] of Object.entries(answers || {})) {
      const item = byId.get(id);
      if (!item) { bad.push(LOCKED_IDS.test(id) ? `${id} is locked: it always asks (or never happens), whatever anyone picks` : `there is no permission "${id}"`); continue; }
      const to = choiceOf(item, value);
      if (!to) { bad.push(`"${value}" isn't a choice for ${item.id} (pick ${item.choices.map((c) => `"${wordFor(item, c)}"`).join(', ')})`); continue; }
      if (to !== cur[item.id]) changes.push({ item, from: cur[item.id], to, looser: looser(item, to, cur[item.id]) });
    }
    return { changes, bad };
  }

  // Save these changes (from plan()). The caller has already got the person's yes for any looser one.
  function apply(changes) {
    const next = { ...read().choices };
    for (const ch of changes) next[ch.item.id] = ch.to;
    save(next);
    return next;
  }

  return {
    file,
    read,
    plan,
    apply,
    // The person's choice for a line ('go' | 'ask' | 'never' | 'some'...).
    get: (id) => read().choices[id],
  };
}

// The list as they'd read it, with what is picked now.
export function describe(perms) {
  const { choices, chosen } = perms.read();
  const lines = ITEMS.map((i) => `- ${i.label}: ${wordFor(i, choices[i.id])}${choices[i.id] === i.def ? ' (default)' : ''}   [${i.id}: ${i.choices.map((c) => wordFor(i, c)).join(' / ')}]`);
  const locked = LOCKED.map(([l, w]) => `- ${l}: ${w.toUpperCase()} (locked)`);
  return `${chosen ? 'What they chose' : 'Nothing chosen yet (these are the defaults)'}:\n${lines.join('\n')}\nLocked, for their safety (shown so they know; nobody can change these):\n${locked.join('\n')}`;
}

// One line for brain_recall: only what differs from the defaults.
export function summary(perms) {
  let r;
  try { r = perms.read(); } catch { return ''; }
  const diff = ITEMS.filter((i) => r.choices[i.id] !== i.def).map((i) => `${i.label}: ${wordFor(i, r.choices[i.id])}`);
  return diff.length ? diff.join('; ') : '';
}

// The pop-up form: one choice per line, today's pick first.
export function formSchema(perms) {
  const { choices } = perms.read();
  const properties = {};
  for (const i of ITEMS) {
    const words = i.choices.map((c) => wordFor(i, c));
    properties[i.id] = { type: 'string', title: i.label, enum: words, default: wordFor(i, choices[i.id]) };
  }
  return { type: 'object', properties };
}

export function permissionsTools({ perms = createPermissions() } = {}) {
  const show = (extra = '') => ({ content: [{ type: 'text', text: `${describe(perms)}${extra ? `\n\n${extra}` : ''}` }] });
  const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
  return [{
    name: 'stead_permissions',
    description: 'What Stead may do without asking: show the list, ask the person (a form, or the list in chat), or set what they picked. Locked lines (paying, paid plans, official forms, passwords) never change.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['show', 'ask', 'set'] },
        choices: { type: 'object', description: 'set: {line id: their choice}, e.g. {"send":"ask me each time"}' },
      },
    },
    run: async ({ action = 'show', choices } = {}, ctx = {}) => {
      if (action === 'show') return show('Show them this as plain choices; to change a line, call again with action "set".');
      if (action === 'ask') {
        // Their own answer in a form: saved as given, since it is them picking, not Claude.
        const got = ctx.askForm ? await ctx.askForm(`What may Stead do for you without asking? Pick one for each line. These always ask, whatever you pick: ${LOCKED.map(([l, w]) => `${l.toLowerCase()} (${w})`).join('; ')}.`, formSchema(perms)) : null;
        if (got && typeof got === 'object') {
          const { changes, bad } = perms.plan(got);
          if (changes.length) perms.apply(changes);
          return show(`Saved from their own answer${changes.length ? ` (${changes.length} changed)` : ' (nothing changed)'}.${bad.length ? ` Ignored: ${bad.join('; ')}.` : ''} Tell them in one line, and that they can change it any time by asking.`);
        }
        if (got === '') return show('They closed the form without choosing: nothing changed.');
        return show(`Their app cannot show a form. Show them this list in chat as plain choices (one short line each, the locked lines too), let them answer in their own words, then call again with action "set" and their choices. A choice that asks less is saved straight away; one that lets Stead do more needs their own pop-up, and if their app has none they change it themselves in ${perms.file}.`);
      }
      if (action !== 'set') return fail(`action must be show, ask or set.`);
      if (!choices || typeof choices !== 'object' || Array.isArray(choices)) return fail('set needs choices: {line id: their choice}.');
      const { changes, bad } = perms.plan(choices);
      if (bad.length && !changes.length) return fail(`Nothing saved: ${bad.join('; ')}.`);
      const loose = changes.filter((c) => c.looser);
      if (loose.length) {
        const what = loose.map((c) => `${c.item.label}: ${wordFor(c.item, c.to)}`).join('; ');
        if (process.env.STEAD_UNATTENDED === '1') return fail('Not from a scheduled job: only the person, at the computer, can let Stead do more.');
        const a = ctx.askHuman ? await ctx.askHuman(`Let Stead do more without asking?\n\n${what}\n\nAllow it?`) : null;
        if (a === false) return fail('They said no. Nothing was changed.');
        if (a === 'no-answer') return fail('They didn\'t answer the pop-up: nothing was changed. Ask them in chat once they are there.');
        // Only their own answer counts: a yes Claude passes on from chat could be a page talking.
        if (a !== true) {
          return fail(`Held: this lets Stead do more without asking (${what}), and only their own answer can allow that: a yes passed on in chat can't. Call again with action "ask" to show them the form. If their app can show neither a form nor a pop-up, tell them they can change it themselves in ${perms.file}.`);
        }
      }
      if (changes.length) perms.apply(changes);
      return show(`${changes.length ? `Saved ${changes.length} change${changes.length > 1 ? 's' : ''}.` : 'Nothing changed.'}${bad.length ? ` Not saved: ${bad.join('; ')}.` : ''}`);
    },
  }];
}
