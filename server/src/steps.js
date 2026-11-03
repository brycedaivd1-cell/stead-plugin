// browser_steps: several clicks, typings and selections on one page in one call, so a form costs one
// round trip instead of one per field. It is never a way around the approval gate:
// - every step runs through the same browser call as browser_click / browser_type /
//   browser_select_option (heal rescues, frozen-tab and crash handling, snapshots remembered);
// - every step is judged on the element it actually resolved to, by the gate in dry-run mode;
// - a step that needs their yes stops the batch, and confirmed: true never carries into a batch:
//   that step is then done on its own, with its own tool and their yes.
// It also stops at the first failure, a failed expect, or when the page moves to another site.

const DO = {
  click: (s, t) => ['browser_click', { ...t, ...(s.double ? { doubleClick: true } : {}) }],
  type: (s, t) => ['browser_type', { ...t, text: String(s.value ?? ''), ...(s.submit ? { submit: true } : {}) }],
  select: (s, t) => ['browser_select_option', { ...t, values: (Array.isArray(s.value) ? s.value : [s.value]).map((v) => String(v ?? '')) }],
};
export const STEPS_MAX = 20;

const textOf = (r) => (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const origin = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; } };
const resultOf = (r) => { try { return JSON.parse((textOf(r).match(/### Result\n(.*)/) || [])[1]); } catch { return null; } };
const firstLine = (r) => textOf(r).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';

// In the page (through run_code): does the element exist and take input, and what page is this.
const EXPECT = (sel, wantText) => `async (page) => {
  const loc = page.locator(${JSON.stringify(sel)});
  const n = await loc.count().catch(() => 0);
  const o = { url: page.url(), exists: n > 0 };
  if (n) o.enabled = await loc.first().isEnabled().catch(() => false);
  if (${JSON.stringify(wantText)}) o.hasText = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase().includes(${JSON.stringify(String(wantText || '').toLowerCase())});
  return o;
}`;

// steps: [{do: click|type|select, ref | role + name, value, submit, double, expect: {exists, enabled, textIncludes, urlIncludes}}]
// deps: call (the full browser call), raw (callBrowser, for snapshot and run_code), gate (dry check),
// snapshots, diff (onlyChanges), logStep (activity log, one line per step).
export async function runBrowserSteps({ steps, max } = {}, { call, raw, gate, snapshots, diff = (r) => r, logStep = () => {} }) {
  const limit = Math.min(STEPS_MAX, Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : STEPS_MAX);
  const all = Array.isArray(steps) ? steps : [];
  const say = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
  if (!all.length) return say('Give steps: [{do: "type", ref: "e12", value: "Ada"}, {do: "click", role: "button", name: "Next"}, ...].', true);
  if (all.length > STEPS_MAX) return say(`At most ${STEPS_MAX} steps per call; this had ${all.length}. Split it.`, true);
  const list = all.slice(0, limit);

  const before = snapshots.page();
  let home = origin(before.url);
  const out = [];
  let done = 0, failedAt = null, why = '', last = null, notRun = 0;

  const fresh = async () => { const r = await raw('browser_snapshot', {}).catch(() => null); if (r && !r.isError) snapshots.remember(r); };
  // The ref this step acts on, and its role and name as the page shows them now.
  const resolve = async (s) => {
    if (s.ref || s.target) {
      const ref = String(s.ref || s.target).trim().replace(/^\[?ref=|\]$/g, '');
      if (!/^(f\d+)?e\d+$/.test(ref)) return { error: `"${ref}" is not a ref from the snapshot (like e12); name it by role + name instead` };
      let hit = snapshots.lookup(ref);
      if (!hit) { await fresh(); hit = snapshots.lookup(ref); }
      return hit ? { ref, ...hit } : { error: `ref ${ref} is not on the page any more` };
    }
    if (!s.name) return { error: 'give ref, or role + name' };
    let refs = snapshots.refsFor(s.role, s.name);
    if (refs.length !== 1) { await fresh(); refs = snapshots.refsFor(s.role, s.name); }
    const what = `${s.role ? `${s.role} ` : ''}"${s.name}"`;
    if (!refs.length) return { error: `no ${what} on the page` };
    if (refs.length > 1) return { error: `${refs.length} elements match ${what} (${refs.slice(0, 5).join(', ')}); use the ref` };
    return { ref: refs[0], ...snapshots.lookup(refs[0]) };
  };
  const checkExpect = async (e, ref) => {
    if (!e || typeof e !== 'object') return '';
    const r = resultOf(await raw('browser_run_code_unsafe', { code: EXPECT(`aria-ref=${ref}`, e.textIncludes || '') }).catch(() => null));
    if (!r) return 'the page could not be checked';
    if (e.exists === false ? r.exists : !r.exists) return e.exists === false ? 'the element is still there' : 'the element is gone';
    if (e.enabled === true && !r.enabled) return 'the element is greyed out (disabled)';
    if (e.enabled === false && r.enabled) return 'the element is enabled';
    if (e.textIncludes && !r.hasText) return `the page does not say "${e.textIncludes}"`;
    if (e.urlIncludes && !String(r.url || '').includes(String(e.urlIncludes))) return `the page is ${r.url}, not one with "${e.urlIncludes}"`;
    return '';
  };

  for (const [i, s0] of list.entries()) {
    // A step's own confirmed (or the batch's) is never passed on: the gate runs dry either way.
    const { confirmed, ...s } = s0 && typeof s0 === 'object' ? s0 : {};
    const n = i + 1;
    const stop = (w) => { failedAt = n; why = w; notRun = n + 1; out.push(`${n}. ${s.do || '?'}: STOPPED: ${w}`); };
    const make = DO[s.do];
    if (!make) { stop(`unknown do "${s.do}" (click, type or select)`); break; }
    const el = await resolve(s);
    if (el.error) { stop(el.error); break; }
    const label = `${el.role || 'element'} "${el.name || s.name || el.ref}"`;
    const bad = await checkExpect(s.expect, el.ref);
    if (bad) { stop(`expected ${JSON.stringify(s.expect)} on ${label}, but ${bad}`); break; }
    const [tool, args] = make(s, { target: el.ref, element: el.name || s.name || s.element || '' });
    const g = await gate(tool, args);
    if (g?.result) {
      logStep(tool, args, g.outcome || 'held');
      stop(g.verdict ? `needs their yes: ${g.doing} would ${g.verdict.what}. Steps never carry a yes: tell them exactly what will happen, ask in chat, and on a yes do this one step alone with ${tool} and confirmed: true` : firstLine(g.result));
      break;
    }
    let r;
    try { r = await call(tool, args); } catch (e) { r = say(String(e.message || e), true); }
    logStep(tool, args, (r.isError ? 'failed' : 'ok') + (g?.outcome ? `:${g.outcome}` : ''));
    last = r;
    if (r.isError) { stop(firstLine(r) || 'it failed'); break; }
    done = n;
    out.push(`${n}. ${s.do} ${label}: ok`);
    const now = origin(snapshots.page().url);
    if (!home) home = now;
    else if (now && now !== home) {
      if (n < list.length) { failedAt = n + 1; notRun = n + 1; why = `step ${n} moved the page to ${now}; nothing after it ran on the new site`; out.push(`(stopped: ${why})`); }
      break;
    }
  }
  if (notRun && notRun <= list.length) out.push(`(steps ${notRun}-${list.length} not run)`);
  if (list.length < all.length) out.push(`(max ${limit}: steps ${limit + 1}-${all.length} were left for another call)`);

  // One picture of the page at the end: what changed since the batch began.
  let page = '';
  if (done) {
    const r = await raw('browser_snapshot', {}).catch(() => null);
    if (r && !r.isError) { snapshots.remember(r); page = textOf(diff(r, before)); } else page = textOf(last);
  }
  const head = JSON.stringify(failedAt ? { done, of: list.length, failedAt, why } : { done, of: list.length });
  return say([head, ...out, page].filter(Boolean).join('\n'), Boolean(failedAt));
}

export const browserStepsTool = {
  name: 'browser_steps',
  description: 'Several clicks, typings and selections on this page in one call. Step: {do: click|type|select, ref (e12) or role + name, value, submit?, expect?: {enabled, textIncludes, urlIncludes}}. Stops at a failure, a step needing their yes (do it alone), or another site.',
  inputSchema: {
    type: 'object',
    properties: {
      steps: { type: 'array', items: { type: 'object' }, description: `Up to ${STEPS_MAX}, in order` },
      max: { type: 'number', description: 'Run only the first N' },
    },
    required: ['steps'],
  },
};
