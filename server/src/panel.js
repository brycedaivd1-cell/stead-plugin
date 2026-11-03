// The control page: one local web page where the person sees and changes everything Stead keeps
// about them. What it remembers (edit or delete any line), what's scheduled (cancel it), everything
// it has done, the phone link, and pause. Trust comes from being able to look.
//
// It listens on 127.0.0.1 only, on a random port, and every request must carry a random token
// that only the page it opened knows, so other websites in their browser can't read or change it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME_DIR, BRAIN_DIR } from './paths.js';
import { isPaused, setPaused, hasConsent } from './safety.js';
import { looksSecret } from './brain.js';
import * as L from './later-tick.mjs';
import * as P from './phone.mjs';

const read = (f, d = '') => { try { return fs.readFileSync(f, 'utf8'); } catch { return d; } };
const brainFiles = () => { try { return fs.readdirSync(BRAIN_DIR).filter((f) => f.endsWith('.md')).sort(); } catch { return []; } };
const okName = (f) => /^[\w .()-]+\.md$/.test(f) && !f.includes('..');

function state() {
  let later = [];
  try { later = L.load(HOME_DIR).items; } catch {} // a damaged later.json must not hide the rest of the page
  const log = read(path.join(HOME_DIR, 'activity.log')).trim().split(/\r?\n/).filter(Boolean).slice(-150).reverse();
  const phone = P.config(HOME_DIR);
  return {
    home: HOME_DIR,
    brainDir: BRAIN_DIR,
    paused: isPaused(),
    terms: hasConsent(),
    brain: brainFiles().map((f) => ({ file: f, text: read(path.join(BRAIN_DIR, f)) })),
    later: later.filter((i) => i.status === 'open').map((i) => ({ id: i.id, kind: i.kind, what: i.what, when: i.at ? L.fmt(i.at) : '', repeat: i.repeat || '', last: i.history?.at(-1)?.summary || '' })),
    done: later.filter((i) => i.status !== 'open').slice(-15).reverse().map((i) => ({ what: i.what, status: i.status, closed: i.closed || '' })),
    log,
    phone: phone?.chatId ? `@${phone.bot}` : '',
  };
}

function act(body) {
  switch (body.op) {
    case 'pause': setPaused(Boolean(body.on)); return 'ok';
    case 'save': {
      if (!okName(body.file)) throw new Error('Bad file name.');
      const text = String(body.text ?? '');
      if (looksSecret(text)) throw new Error('Not saved: something in it looks like a password, card number or other secret. Stead never keeps those.');
      const f = path.join(BRAIN_DIR, body.file);
      fs.mkdirSync(BRAIN_DIR, { recursive: true });
      if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak`);
      fs.writeFileSync(f, text.endsWith('\n') ? text : `${text}\n`);
      return 'saved';
    }
    case 'forget': {
      if (!okName(body.file)) throw new Error('Bad file name.');
      const f = path.join(BRAIN_DIR, body.file);
      const lines = read(f).split('\n');
      const i = lines.indexOf(String(body.line));
      if (i < 0) throw new Error('That line changed; reload the page.');
      fs.copyFileSync(f, `${f}.bak`);
      lines.splice(i, 1);
      fs.writeFileSync(f, lines.join('\n'));
      return 'forgotten';
    }
    case 'cancel': {
      const it = L.update((d) => {
        const x = d.items.find((y) => y.id === body.id && y.status === 'open');
        if (x) { x.status = 'cancelled'; x.pending = false; x.closed = new Date().toISOString(); x.closedBy = 'control page'; }
        return x;
      }, HOME_DIR);
      if (!it) throw new Error('Already gone.');
      return 'cancelled';
    }
    case 'phone-off': P.unpair(HOME_DIR); return 'disconnected';
    default: throw new Error('Unknown action.');
  }
}

let running = null; // { url, server }

export async function startPanel() {
  if (running) return running.url;
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const host = req.headers.host || '';
    // DNS rebinding: a page that resolves its own name to 127.0.0.1 still sends its own Host.
    if (!/^127\.0\.0\.1:\d+$/.test(host)) { res.statusCode = 403; return res.end('Forbidden'); }
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (u.pathname === '/' && u.searchParams.get('t') === token) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
      return res.end(PAGE.replace('__TOKEN__', token));
    }
    if (req.headers['x-stead-token'] !== token) { res.statusCode = 403; return res.end('Forbidden'); }
    res.setHeader('content-type', 'application/json');
    try {
      if (u.pathname === '/api/state' && req.method === 'GET') return res.end(JSON.stringify(state()));
      if (u.pathname === '/api/act' && req.method === 'POST') {
        let body = '';
        for await (const c of req) { body += c; if (body.length > 2e6) throw new Error('Too big.'); }
        return res.end(JSON.stringify({ ok: true, result: act(JSON.parse(body || '{}')) }));
      }
      res.statusCode = 404; return res.end('{}');
    } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: e.message })); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  running = { server, url: `http://127.0.0.1:${server.address().port}/?t=${token}` };
  return running.url;
}

export function stopPanel() { running?.server.close(); running = null; }

// Their everyday browser, not the Stead one: this page is for them.
export function openInBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => {});
  p.unref();
}

export const panelTools = [{
  name: 'stead_panel',
  description: 'Open their Stead control page: what you remember (they can edit or delete it), reminders and jobs, a log of what you did, a pause switch. Offer it when they ask what you know or did, or want something forgotten.',
  inputSchema: { type: 'object', properties: {} },
  run: async () => {
    const url = await startPanel();
    openInBrowser(url);
    return { content: [{ type: 'text', text: 'Opened their control page in their browser. It works while this chat is open (or run "npx stead-ai panel" any time).' }] };
  },
}];

const PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stead</title>
<style>
:root { --bg:#0b0b0c; --panel:#141416; --line:#26262a; --ink:#f2f2ef; --dim:#9a9a9f; --faint:#6b6b70; --warn:#e8c46a; --bad:#ef7d7d; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
.wrap { max-width: 920px; margin: 0 auto; padding: 28px 16px 64px; }
header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom: 28px; }
h1 { font-size: 22px; margin:0; letter-spacing:-0.02em; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); font-weight:600; margin: 36px 0 12px; }
.card { background: var(--panel); border:1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; }
.row { display:flex; gap:12px; align-items:flex-start; justify-content:space-between; }
.muted { color: var(--dim); } .faint { color: var(--faint); font-size: 13px; }
button { background: transparent; color: var(--ink); border:1px solid var(--line); border-radius: 7px; padding: 6px 12px; font: inherit; font-size: 13.5px; cursor: pointer; }
button:hover { border-color: var(--dim); } button.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
button.x { border:0; color: var(--faint); padding: 0 6px; font-size: 16px; line-height: 1.4; } button.x:hover { color: var(--bad); }
.status { display:flex; align-items:center; gap:10px; }
.dot { width:9px; height:9px; border-radius:50%; background:#5fd38d; } .dot.off { background: var(--warn); }
ul.lines { list-style:none; margin:0; padding:0; } ul.lines li { display:flex; justify-content:space-between; gap:8px; padding: 3px 0; border-bottom: 1px solid #1c1c1f; } ul.lines li:last-child { border:0; }
textarea { width:100%; min-height: 160px; background:#0f0f11; color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:10px; font: 13.5px/1.5 Consolas, ui-monospace, monospace; }
pre.log { margin:0; max-height: 360px; overflow:auto; font: 12.5px/1.55 Consolas, ui-monospace, monospace; color: var(--dim); white-space: pre-wrap; word-break: break-word; }
.msg { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: var(--ink); color: var(--bg); padding: 8px 14px; border-radius: 8px; display:none; }
.msg.bad { background: var(--bad); }
@media (max-width: 600px) { header { flex-direction: column; align-items: flex-start; } }
</style>
<div class="wrap">
  <header><h1>Stead</h1><div class="status"><span class="dot" id="dot"></span><span id="st"></span><button id="pause"></button></div></header>
  <p class="muted">Everything Stead keeps about you lives on this computer, in plain notes. Change or delete anything here.</p>
  <h2>What it remembers</h2><div id="brain"></div>
  <h2>Reminders and scheduled jobs</h2><div id="later"></div>
  <h2>Phone</h2><div id="phone" class="card"></div>
  <h2>Everything it did (newest first)</h2><div class="card"><pre class="log" id="log"></pre></div>
  <p class="faint" id="where"></p>
</div>
<div class="msg" id="msg"></div>
<script>
const T = '__TOKEN__';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function say(t, bad) { const m = $('msg'); m.textContent = t; m.className = 'msg' + (bad ? ' bad' : ''); m.style.display = 'block'; setTimeout(() => (m.style.display = 'none'), 2600); }
async function act(body) {
  const r = await fetch('/api/act', { method: 'POST', headers: { 'x-stead-token': T, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) { say(j.error, true); return false; }
  say(j.result[0].toUpperCase() + j.result.slice(1) + '.'); load(); return true;
}
async function load() {
  const s = await (await fetch('/api/state', { headers: { 'x-stead-token': T } })).json();
  $('dot').className = 'dot' + (s.paused || !s.terms ? ' off' : '');
  $('st').textContent = s.paused ? 'Paused: it can look but not change anything' : (s.terms ? 'Active' : 'Waiting for you to accept the terms');
  $('pause').textContent = s.paused ? 'Resume' : 'Pause';
  $('pause').onclick = () => act({ op: 'pause', on: !s.paused });
  $('brain').innerHTML = s.brain.length ? '' : '<div class="card muted">Nothing yet.</div>';
  for (const f of s.brain) {
    const c = document.createElement('div'); c.className = 'card';
    const lines = f.text.split('\\n').filter((l) => l.trim() && !/^#/.test(l.trim()));
    c.innerHTML = '<div class="row"><b>' + esc(f.file.replace(/\\.md$/, '')) + '</b><button data-edit>Edit</button></div>' +
      '<ul class="lines">' + lines.map((l, i) => '<li><span>' + esc(l.replace(/^\\s*[-*]\\s*/, '')) + '</span><button class="x" title="Forget this" data-i="' + i + '">×</button></li>').join('') + '</ul>';
    c.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => act({ op: 'forget', file: f.file, line: lines[b.dataset.i] })));
    c.querySelector('[data-edit]').onclick = () => {
      c.innerHTML = '<b>' + esc(f.file) + '</b><textarea></textarea><div class="row" style="margin-top:8px"><span class="faint">Passwords, card and ID numbers are refused.</span><span><button data-cancel>Cancel</button> <button class="primary" data-save>Save</button></span></div>';
      c.querySelector('textarea').value = f.text;
      c.querySelector('[data-cancel]').onclick = load;
      c.querySelector('[data-save]').onclick = () => act({ op: 'save', file: f.file, text: c.querySelector('textarea').value });
    };
    $('brain').appendChild(c);
  }
  $('later').innerHTML = s.later.length ? '' : '<div class="card muted">Nothing scheduled.</div>';
  for (const i of s.later) {
    const c = document.createElement('div'); c.className = 'card row';
    c.innerHTML = '<div><b>' + esc(i.what) + '</b><div class="faint">' + esc([i.kind.replace('_', '-'), i.when, i.repeat && 'repeats ' + i.repeat, i.last && 'last: ' + i.last].filter(Boolean).join(' · ')) + '</div></div><button>Cancel</button>';
    c.querySelector('button').onclick = () => act({ op: 'cancel', id: i.id });
    $('later').appendChild(c);
  }
  $('phone').innerHTML = s.phone ? '<div class="row"><span>Connected: you can text <b>' + esc(s.phone) + '</b> from anywhere.</span><button>Disconnect</button></div>' : '<span class="muted">Not connected. Ask Claude: "set up my phone".</span>';
  if (s.phone) $('phone').querySelector('button').onclick = () => confirm('Disconnect your phone?') && act({ op: 'phone-off' });
  $('log').textContent = s.log.join('\\n') || 'Nothing yet.';
  $('where').textContent = 'Stored in ' + s.home + '. Memory notes: ' + s.brainDir + '.';
}
load();
</script>
</html>`;
