// serve as a self-healing proxy, not a passthrough.
//
// Claude Code <-> (this process) <-> @playwright/mcp. Every JSON-RPC line is forwarded.
// When a browser_click or browser_type comes back with Playwright's actionability
// timeout ("visible, enabled and stable"), we don't hand Claude the failure — we
// retry the way that actually works on shadow-DOM / Material inputs: resolve the
// same ref through the child's own browser_evaluate and dispatch a real click /
// focus on the element, then (for type) drive the keyboard over our own CDP
// connection. Claude sees one successful call. The failure never reaches it.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHealer } from './heal.js';

export function startProxy({ cli, port, log = () => {}, record = () => {}, args: extra = [] }) {
  const child = spawn(process.execPath, [cli, '--cdp-endpoint', `http://127.0.0.1:${port}`, ...extra], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const pending = new Map();      // id -> { method, name, args }  (requests from Claude)
  const internal = new Map();     // id -> resolve                  (our own retry requests)
  let seq = 0;
  const nextId = () => `stead-${++seq}`;

  const toChild = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  const toClient = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

  function ask(name, args) {
    return new Promise((resolve) => {
      const id = nextId();
      internal.set(id, resolve);
      toChild({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    });
  }

  const heal = createHealer({ ask, port, record, log });

  // Claude -> child
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'tools/call' && msg.id !== undefined) {
        pending.set(msg.id, { name: msg.params?.name, args: msg.params?.arguments });
      }
    } catch {}
    child.stdin.write(line + '\n');
  });

  // child -> Claude (with interception)
  createInterface({ input: child.stdout }).on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }

    if (msg.id !== undefined && internal.has(msg.id)) {
      internal.get(msg.id)(msg.result ?? { isError: true, content: [{ type: 'text', text: JSON.stringify(msg.error) }] });
      internal.delete(msg.id);
      return;
    }

    const req = msg.id !== undefined ? pending.get(msg.id) : null;
    if (req) pending.delete(msg.id);

    if (req && msg.result?.isError) {
      try {
        const healed = await heal(req.name, req.args, msg.result);
        if (healed) { toClient({ ...msg, result: healed }); return; }
      } catch (e) { log(`self-heal failed: ${e.message}`); }
    }
    process.stdout.write(line + '\n');
  });

  process.stdin.on('end', () => child.stdin.end());
  child.on('exit', (code) => process.exit(code ?? 0));
  return child;
}
