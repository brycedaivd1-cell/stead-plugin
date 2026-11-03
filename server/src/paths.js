// Where Stead keeps things. One place, so a rename never strands someone's data.
// The product was called "hands", then "Otto", before it was Stead: anyone who already has
// ~/.otto, ~/.hands or their -profile folders keeps using them (their memory and site logins live
// there), new installs get the Stead names. STEAD_* env vars win; OTTO_* and HANDS_* still work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = (k) => process.env[`STEAD_${k}`] || process.env[`OTTO_${k}`] || process.env[`HANDS_${k}`] || '';
const has = (dir, f) => fs.existsSync(path.join(dir, f));

// The folder that holds their data, not just the newest one that exists. "Exists" alone broke a
// real install: a log, a plugin copy or a license file created ~/.stead, and from then on Stead read
// an empty ~/.stead while their consent, memory, tools and reminders sat untouched in ~/.hands
// (every action refused, a blank brain, reminders split from the scheduler that fires them).
// Order: the folder where they accepted the terms, then any with memory/tools/reminders, then any
// that exists, then the current name. Newest name first at each step.
// later-tick.mjs runs on its own from the data folder and keeps a copy of this rule: change both.
export function resolveHome(home = os.homedir()) {
  const dirs = ['.stead', '.otto', '.hands'].map((d) => path.join(home, d));
  return dirs.find((d) => has(d, 'consent.json'))
    || dirs.find((d) => ['brain', 'tools', 'later.json'].some((f) => has(d, f)))
    || dirs.find((d) => fs.existsSync(d))
    || dirs[0];
}

// Same rule for the browser profile: the one with their logins (a cookie jar) wins over one that
// merely exists, so site logins never split between ~/.hands-profile and ~/.stead-profile.
export function resolveProfile(name = 'default', home = os.homedir()) {
  const suffix = name === 'default' ? '' : `-${name}`;
  const dirs = ['stead', 'otto', 'hands'].map((n) => path.join(home, `.${n}-profile${suffix}`));
  return dirs.find((d) => has(d, 'Default/Network/Cookies') || has(d, 'Default/Cookies'))
    || dirs.find((d) => fs.existsSync(d))
    || dirs[0];
}

export const PRODUCT = 'Stead';
export const HOME_DIR = env('HOME') || resolveHome();
export const BRAIN_DIR = env('BRAIN_DIR') || path.join(HOME_DIR, 'brain');
export const HEAL_LOG = path.join(HOME_DIR, 'heal.jsonl');
export const termsAcceptedByEnv = () => env('TERMS_ACCEPTED') === 'true';

export const profileDir = (name = 'default') => resolveProfile(name);
