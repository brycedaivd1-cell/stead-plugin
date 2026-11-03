// `stead report`: everything needed to fix a problem, in one text file on their own computer.
// Nothing is sent anywhere: they read it, then send it to whoever helps them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_DIR, HEAL_LOG } from './paths.js';
import { CONFIG_PATH, desktopConfigPaths, codexConfigPath, looseJson } from './config.js';

// Strip what could identify them or their accounts: URL queries and fragments (tokens, search
// terms, form values), email addresses, long numbers (phones, IDs, card digits), and their home
// folder (their Windows user name).
export function redact(text, home = os.homedir()) {
  let t = String(text);
  if (home) t = t.split(home).join('~');
  return t
    .replace(/\b(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, '$1?...')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\d[\d -]{4,}\d/g, (m) => (/^\d{4}-\d\d-\d\d$/.test(m) || m.replace(/\D/g, '').length < 6 ? m : '[number]'));
}

const tail = (file, n) => {
  try { return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-n); } catch { return []; }
};

function configured(file, test) {
  try { return test(fs.readFileSync(file, 'utf8')) ? 'yes' : 'no'; } catch { return 'not installed'; }
}

export function build({ version, doctor, terms, paused, name = 'stead' }) {
  const heal = tail(HEAL_LOG, 500).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const counts = {};
  for (const h of heal) counts[h.outcome || 'unknown'] = (counts[h.outcome || 'unknown'] || 0) + 1;
  const json = (s) => { try { return !!looseJson(s).mcpServers?.[name]; } catch { return false; } };
  const lines = [
    `Stead problem report, ${new Date().toISOString()}`,
    'Private details (web addresses after the ?, emails, long numbers, your user name) are removed.',
    'Read it before sending anyway.',
    '',
    '## Setup',
    `Stead ${version} | Node ${process.version} | ${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
    `Terms accepted: ${terms ? 'yes' : 'NO'} | Paused: ${paused ? 'YES' : 'no'}`,
    // Every Claude Desktop copy, the Store version's private one included: a mismatch there is
    // exactly why Claude Desktop can't see Stead after a normal init.
    [`Claude Code: ${configured(CONFIG_PATH, json)}`, ...desktopConfigPaths().map((p) => `${p.app}: ${configured(p.file, json)}`), `ChatGPT/Codex: ${configured(codexConfigPath(), (s) => s.includes(`[mcp_servers.${name}]`))}`].join(' | '),
    '',
    '## Checks (stead doctor)',
    ...doctor,
    '',
    `## Click rescues (last ${heal.length})`,
    Object.keys(counts).length ? Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' | ') : 'none yet',
    ...heal.slice(-10).map((h) => `${h.at}  ${h.tool}  ${h.reason || ''} -> ${h.outcome || ''}`),
    '',
    '## Last 30 actions',
    ...(tail(path.join(HOME_DIR, 'activity.log'), 30).length ? tail(path.join(HOME_DIR, 'activity.log'), 30) : ['nothing yet']),
  ];
  return redact(lines.join('\n')) + '\n';
}

export function writeReport(text) {
  const desk = path.join(os.homedir(), 'Desktop');
  const dir = fs.existsSync(desk) ? desk : HOME_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `stead-report-${new Date().toISOString().slice(0, 10)}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}
