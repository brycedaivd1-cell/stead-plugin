// The director: the AI's own tool calls are the controller in her hands. Each call says where the
// work is happening (a window, a point on the screen, the browser) and what kind of work it is, so
// she pops over there and acts it out: presses what's clicked, sits on the window typing what's typed,
// reads, writes it down, throws a message off to their phone. Nothing here asks a model anything;
// it's all read off the call itself, so it costs nothing.
//
// The pure parts (cueOf, coalesce, narrate, siteName) are exported for the tests; createDirector keeps
// the little bit of state they need and hands the body its messages through emit().

const bare = (t) => String(t || '').replace(/^mcp__[^_]+__/, '');
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const hostOf = (u) => { try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`).host.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

// Tools that find their own target (a point or a window) and report it themselves, from inside the
// tool (src/desktop/tools.js): the server's generic cue skips them so she isn't sent twice.
export const SELF_CUED = new Set(['desktop_click', 'desktop_act', 'desktop_mouse', 'desktop_scroll', 'desktop_type', 'desktop_keys', 'desktop_focus', 'desktop_open_app', 'desktop_open_file']);

// What she does for a call, and where: { move, at } or null (nothing worth acting out).
// move: press type scroll look read write code wave throw grab present ask
// at: 'point' | 'window' (the tool reports which) | 'browser' (Stead's Chrome) | 'here' (where she is)
export function cueOf(tool, args = {}) {
  const n = bare(tool);
  const a = args || {};
  switch (n) {
    case 'desktop_click': return { move: 'press', at: 'point' };
    case 'desktop_mouse': return { move: a.action === 'drag' ? 'grab' : 'look', at: 'point' };
    case 'desktop_scroll': return { move: 'scroll', at: 'point' };
    case 'desktop_type': case 'desktop_keys': return { move: 'type', at: 'window' };
    case 'desktop_focus': return { move: 'look', at: 'window' };
    case 'desktop_open_app': case 'desktop_open_file': return { move: 'wave', at: 'window' };
    case 'desktop_act': {
      const act = String(a.action || 'click');
      if (/^(set_value|replace_all)$/.test(act)) return { move: 'type', at: 'window' };
      if (/^scroll_/.test(act)) return { move: 'scroll', at: 'window' };
      if (/^(close_window|minimize)$/.test(act)) return { move: 'wave', at: 'window' };
      if (/^(maximize|restore)$/.test(act)) return { move: 'look', at: 'window' };
      return { move: 'press', at: 'window' };
    }
    case 'desktop_read': case 'desktop_read_text': case 'desktop_find': case 'desktop_wait': case 'desktop_screenshot': case 'desktop_windows':
      return { move: 'look', at: 'here' };
    case 'browser_navigate': case 'browser_navigate_back': case 'browser_show': return { move: 'look', at: 'browser' };
    case 'browser_tabs': return a.action === 'new' || a.action === 'select' ? { move: 'look', at: 'browser' } : null;
    case 'browser_click': case 'browser_hover': case 'browser_select_option': case 'browser_file_upload': case 'browser_mouse_click_xy': case 'browser_drag': case 'browser_drop':
      return { move: 'press', at: 'browser' };
    case 'browser_type': case 'browser_fill_form': case 'browser_press_key': case 'browser_login': return { move: 'type', at: 'browser' };
    case 'browser_mouse_wheel': return { move: 'scroll', at: 'browser' };
    case 'browser_snapshot': case 'browser_find': case 'browser_evaluate': case 'browser_wait_for': case 'browser_take_screenshot': case 'browser_steps':
      return { move: 'look', at: 'browser' };
    case 'browser_pdf_save': return { move: 'write', at: 'browser' };
    case 'file_read': case 'docread': case 'clipboard_read': case 'brain_recall': case 'brain_read': case 'brain_search': case 'later_list':
      return { move: 'read', at: 'here' };
    case 'file_write': case 'paste_formatted': case 'later_add': case 'later_done': case 'brain_save': case 'learn': case 'toolbox_save':
      return { move: 'write', at: 'here' };
    case 'computer_command': case 'toolbox_run': return { move: 'code', at: 'here' };
    case 'phone_send': return { move: 'throw', at: 'here' };
    case 'stead_present': return { move: 'present', at: 'here' };
    default: return null;
  }
}

// Somewhere to be, as a key: two calls at the same key are the same place. A spot inside a window is
// keyed under it ("hwnd:42/pt:3,4", "browser/el:e12"): that window is the spot's family.
export const placeKey = (where) => {
  if (!where) return '';
  if (where.key) return String(where.key);
  const fam = where.hwnd ? `hwnd:${where.hwnd}/` : '';
  if (where.rect) { const r = where.rect; return `${fam}win:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`; }
  if (Number.isFinite(where.x) && Number.isFinite(where.y)) return `${fam}pt:${Math.round(where.x / 60)},${Math.round(where.y / 60)}`;
  return '';
};
const familyOf = (key) => String(key || '').split('/')[0];

// Whether she pops somewhere new for this call. 30 rapid calls must not be 30 teleports: she only goes
// when the place changed AND she has been where she is long enough to be seen doing it (dwell);
// otherwise she stays and keeps acting where she is. Inside the window she's already in, the window
// itself counts as where she is (a type or a read after a click there doesn't send her to its top),
// and a new spot in it waits longer (near): an AI clicks and types every few seconds, and a pop on
// each one is spam.
// at: where she is now { key, since } (or null); key: where this call happens ('' = no place).
export function coalesce(at, key, now, { dwell = 1500, near = 8000 } = {}) {
  if (!key) return { go: false, at };
  if (at && at.key === key) return { go: false, at };
  const same = !!at && familyOf(at.key) === familyOf(key);
  if (same && key === familyOf(key)) return { go: false, at };
  if (at && now - at.since < (same ? near : dwell)) return { go: false, at };
  return { go: true, at: { key, since: now } };
}

// A site's name the way they'd say it.
const SITES = {
  'mail.google.com': 'Gmail', 'docs.google.com': 'Google Docs', 'drive.google.com': 'Drive', 'calendar.google.com': 'Calendar',
  'classroom.google.com': 'Classroom', 'sheets.google.com': 'Sheets', 'google.com': 'Google', 'youtube.com': 'YouTube',
  'outlook.live.com': 'Outlook', 'outlook.office.com': 'Outlook', 'outlook.office365.com': 'Outlook', 'github.com': 'GitHub',
  'linkedin.com': 'LinkedIn', 'chatgpt.com': 'ChatGPT', 'claude.ai': 'Claude', 'x.com': 'X', 'reddit.com': 'Reddit',
};
export function siteName(url) {
  const h = hostOf(url);
  if (!h) return '';
  if (SITES[h]) return SITES[h];
  const parts = h.split('.').filter(Boolean);
  if (parts.length < 2) return '';
  // example.co.uk -> example; app.notion.so -> notion
  const two = /^(co|com|org|net|gov|edu|ac)$/.test(parts[parts.length - 2]) && parts.length > 2;
  const label = parts[parts.length - (two ? 3 : 2)];
  return label ? label[0].toUpperCase() + label.slice(1) : '';
}

const MAX_LINE = 40;
// Fill {x} in so the line stays under 40 characters: a long name is cut, never the line.
const fill = (t, x = '') => {
  const room = MAX_LINE - (t.length - 3);
  let v = String(x || '').replace(/\s+/g, ' ').trim();
  if (v.length > room) v = room > 4 ? `${v.slice(0, room - 3).trimEnd()}...` : '';
  return v || !t.includes('{x}') ? t.replace('{x}', v) : null;
};

// The lines: a few takes on each, said in turn (never at random), short and warm.
export const LINES = {
  start: ['On it!', "Let's do this.", 'Right away!', 'Leave it to me.'],
  site: ['Popping over to {x}!', 'Off to {x}.', 'Hopping into {x}.'],
  app: ['Opening {x} for you.', 'Here comes {x}!', 'Pulling up {x}.'],
  saved: ['Saved {x}.', 'Got it, {x} is saved.', '{x}: saved.'],
  later: ["Got it, it's on your list.", 'Jotted that down.', "Noted. I'll remind you."],
  remember: ["I'll remember that.", 'Noted for next time.', 'Filed away.'],
  phone: ['Sent to your phone!', 'Check your phone!', 'On its way to your phone.'],
  deck: ['Presenting!', 'Ta-da! Have a look.', 'Your deck is up!'],
  ask: ['Need your OK on this one!', 'Quick check with you first.', 'Your call on this one.'],
  error: ["Hmm, that didn't take.", 'Snag. Trying another way.', "That one fought back."],
  done: ['All done!', 'Done and dusted.', "That's taken care of."],
};
// The rotation: which take each kind is on. Deterministic, so tests know what she'll say.
export const pickLine = (kind, x, turn = 0) => {
  const list = LINES[kind];
  if (!list) return null;
  for (let i = 0; i < list.length; i++) {
    const l = fill(list[(turn + i) % list.length], x);
    if (l && l.length <= MAX_LINE) return l;
  }
  return null;
};

// The lines that say how a call came out: said once it has, and only if it worked.
export const OUTCOMES = new Set(['saved', 'later', 'remember', 'phone', 'deck']);

// Is this call worth a line, and which kind? { kind, x } or null. ctx: { lastSite, lastApp, fresh }
// fresh: the first step of a new piece of work (nothing for a while before it).
export function narrate(tool, args = {}, ctx = {}) {
  const n = bare(tool);
  const a = args || {};
  if (n === 'browser_navigate' || (n === 'browser_tabs' && a.action === 'new' && a.url)) {
    const s = siteName(a.url);
    if (s && s !== ctx.lastSite) return { kind: 'site', x: s, site: s };
  }
  if (n === 'desktop_open_app') {
    const app = String(a.name || '').trim();
    if (app && app !== ctx.lastApp) return { kind: 'app', x: app, app };
  }
  if (n === 'file_write') { const f = base(a.path); if (f) return { kind: 'saved', x: f }; }
  if (n === 'later_add') return { kind: 'later' };
  if (n === 'brain_save' || n === 'learn') return { kind: 'remember' };
  if (n === 'phone_send') return { kind: 'phone' };
  if (n === 'stead_present') return { kind: 'deck' };
  if (ctx.fresh) return { kind: 'start' };
  return null;
}

// Her state for the server's whole life: where she is, what she last said, when work last happened.
// emit(msg) sends to the body; bubble() says what her bubble is showing ('' when nothing): a line the
// AI wrote (say, chat) is never talked over. quiet: no lines at all (her own jobs: what the AI writes
// already shows in her bubble).
// Work is still going while a call runs or a question waits on them (begin/ended, asking/answered): the
// rest timer only starts once nothing is. stuckMs: a call that never reports back stops counting then.
// canGo(): false keeps her where she is (walking is off), and then nothing is looked up for her either.
export function createDirector({ emit, now = () => Date.now(), bubble = () => '', quiet = false, gap = 6000, restMs = 15000, stuckMs = 300000, missMs = 10000, canGo = () => true, timers = { set: setTimeout, clear: clearTimeout } } = {}) {
  let at = null, lastMove = '', lastSent = 0, lastLine = 0, lastKind = '', lastStep = 0, steps = 0, site = '', app = '', homeTimer = null, hushUntil = 0, errors = 0, lastOops = 0;
  let inflight = 0, waiting = 0;
  const turns = {}, misses = {};
  const talkingOver = () => { const b = String(bubble() || ''); return b !== '' && b !== 'narrate' && b !== 'status'; };
  const line = (kind, x, { force = false } = {}) => {
    const t = now();
    if (quiet || t < hushUntil || talkingOver()) return null;
    if (!force && t - lastLine < gap) return null;
    const l = pickLine(kind, x, turns[kind] || 0);
    if (!l) return null;
    turns[kind] = (turns[kind] || 0) + 1; lastLine = t; lastKind = kind;
    emit({ type: 'say', text: l, kind: 'narrate', ttl: 3500, speak: false });
    return l;
  };
  // Work over (no calls for a while): a word if it was a real job, then she pops home.
  const rest = () => {
    homeTimer = null;
    if (steps >= 3) line('done', '', { force: true });
    // How it went, so she has a reason to react (Motive.cs): a real job with no failed step is a win.
    const ok = steps >= 3 && errors === 0 && !inflight && !waiting, n = steps;
    at = null; lastMove = ''; steps = 0; site = ''; app = ''; inflight = 0; waiting = 0; errors = 0;
    emit({ type: 'act', move: 'home', ok, steps: n });
  };
  const restLater = () => {
    if (homeTimer) timers.clear(homeTimer);
    homeTimer = timers.set(rest, inflight || waiting ? stuckMs : restMs);
    if (homeTimer && homeTimer.unref) homeTimer.unref();
  };

  // A tool call starting. where: null, { x, y }, { rect: { x, y, w, h } }, or { key, resolve } where
  // resolve() finds the place only if she's actually going (a browser lookup costs a round trip).
  async function step(tool, args = {}, where = null) {
    const cue = cueOf(tool, args);
    const t = now();
    const fresh = !lastStep || t - lastStep > restMs;
    lastStep = t; steps++;
    restLater();
    let said = narrate(tool, args, { lastSite: site, lastApp: app, fresh });
    if (said && OUTCOMES.has(said.kind)) said = fresh ? { kind: 'start' } : null;   // that's said when it's done
    if (said) {
      if (said.site) site = said.site;
      if (said.app) app = said.app;
      line(said.kind, said.x);
    }
    if (!cue) return null;
    const key = cue.at === 'browser' && !where ? 'browser' : placeKey(where);
    // A place that just couldn't be found (a hidden tab, a window that's gone) isn't looked up again for
    // a while: every lookup is a round trip ahead of the real call.
    const missed = !!key && misses[key] > t;
    const c = canGo() && !missed ? coalesce(at, key, t) : { go: false, at };
    let msg = { type: 'act', move: cue.move, secs: 15 };
    if (c.go) {
      let place = where;
      if (where && typeof where.resolve === 'function') { try { place = await where.resolve(); } catch { place = null; } }
      if (place && place.rect && place.rect.w > 0) msg = { ...msg, ...rectMsg(place.rect), ...(place.hwnd ? { hwnd: place.hwnd } : {}) };   // the window itself, when known
      else if (place && Number.isFinite(place.x) && Number.isFinite(place.y)) msg = { ...msg, x: Math.round(place.x), y: Math.round(place.y) };
      if (msg.w || Number.isFinite(msg.x)) { msg.pop = true; at = c.at; } else misses[key] = t + missMs;
    }
    // The same move in the same place moments ago: she's already doing it.
    if (!msg.pop && msg.move === lastMove && t - lastSent < 700) return null;
    lastMove = msg.move; lastSent = t;
    emit(msg);
    return msg;
  }
  const rectMsg = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

  // A call starting (every call, before its step): work is going until it ends.
  function begin() { inflight++; restLater(); }
  // A call finished. It worked: what came of it, if that's worth a line ("Saved essay.md."), through the
  // gap. It failed: a word (rate-limited like the rest, unless her last line said something worked).
  // silent: only counted (she isn't showing).
  function ended(tool, args, result, { silent = false } = {}) {
    inflight = Math.max(0, inflight - 1);
    lastStep = now();
    if (!silent) {
      if (result && result.isError) {
        errors++;
        if (cueOf(tool, args)) line('error', '', { force: OUTCOMES.has(lastKind) });
        // A step failed: her body stumbles, at most once every 20s however many fail in a row.
        if (now() - lastOops > 20000) { lastOops = now(); emit({ type: 'outcome', ok: false, steps }); }
      }
      else {
        const said = narrate(tool, args, {});
        if (said && OUTCOMES.has(said.kind)) line(said.kind, said.x, { force: true });
      }
    }
    restLater();
  }
  // Waiting on their yes: she turns to them and points at the question, whatever else is going on.
  // Nothing sends her home while it's open; answered() when it's back.
  function asking() {
    waiting++;
    restLater();
    at = { key: 'ask', since: now() };   // she's at their question now: the next call's place is new
    line('ask', '', { force: true });
    emit({ type: 'act', move: 'ask', secs: 30 });
  }
  // The AI just put its own words in her bubble (stead_say): no lines of hers over them for a while.
  const quietFor = (ms) => { hushUntil = Math.max(hushUntil, now() + ms); };
  function answered() { waiting = Math.max(0, waiting - 1); lastStep = now(); restLater(); }
  return { step, begin, ended, asking, answered, rest, quietFor, get at() { return at; }, get busy() { return inflight + waiting; } };
}
