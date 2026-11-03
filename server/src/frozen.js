// A tab whose page has stopped responding (a script stuck in a loop, a renderer that hung) hangs
// every browser tool, not just its own: @playwright/mcp reads the title of every open tab after each
// call, with no timeout. Nothing on the Playwright side can rescue that, so this goes around it,
// straight to each tab over DevTools, and finds the one that no longer answers. server.js decides
// what to do with it: a tab Stead opened is closed; one of the person's is theirs to close.

// Does this tab still run JavaScript? A tab showing an alert/confirm/beforeunload can't evaluate
// either, but it isn't hung (Playwright handles dialogs), and Chrome reports an open dialog when
// Page is enabled.
async function answers(wsUrl, ms) {
  const ws = new globalThis.WebSocket(wsUrl);
  try {
    return await new Promise((ok) => {
      const t = setTimeout(() => ok(false), ms);
      const done = (v) => { clearTimeout(t); ok(v); };
      ws.onerror = () => done(true); // can't tell: never close a tab on a guess
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
        ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '1', returnByValue: true } }));
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.method === 'Page.javascriptDialogOpening' || m.id === 2) done(true);
      };
    });
  } finally {
    try { ws.close(); } catch {}
  }
}

async function pageList(port) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal })).json()).filter((x) => x.type === 'page');
  } catch { return null; } finally { clearTimeout(t); }
}

// The ids of the open page tabs (to tell which tab a browser_tabs new opened).
export async function pageIds(port) {
  return new Set((await pageList(port) || []).map((p) => p.id));
}

export async function closeTab(port, id) {
  try { await fetch(`http://127.0.0.1:${port}/json/close/${id}`); return true; } catch { return false; }
}

// Every page tab that fails to evaluate `1` within probeMs, once: [{ id, title, url }].
export async function frozenTabs(port, { probeMs = 4000 } = {}) {
  if (typeof globalThis.WebSocket !== 'function') return []; // Node 20: no way to check, so leave it
  const pages = (await pageList(port) || []).filter((x) => x.webSocketDebuggerUrl);
  const alive = await Promise.all(pages.map((p) => answers(p.webSocketDebuggerUrl, probeMs)));
  return pages.filter((_, i) => !alive[i]).map(({ id, title, url }) => ({ id, title, url }));
}

// One failed probe isn't a hung tab: a Sheets recalculation or a heavy page load can block for
// seconds and recover. A tab counts only after failing two looks in a row (the caller spaces them).
export function watchdog(port, { probeMs } = {}) {
  let before = new Set();
  return async () => {
    const now = await frozenTabs(port, { probeMs });
    const hung = now.filter((t) => before.has(t.id));
    before = new Set(now.map((t) => t.id));
    return hung;
  };
}

// Closes every page tab that fails one probe. Only for tests and tools that already know the tab is
// hung; the server goes through watchdog() and closes only tabs it opened.
export async function closeFrozenTabs(port, { probeMs = 4000 } = {}) {
  const closed = [];
  for (const t of await frozenTabs(port, { probeMs })) if (await closeTab(port, t.id)) closed.push({ title: t.title, url: t.url });
  return closed;
}
