// Push instead of poll: the UI hears "something changed" over a streaming connection the moment it happens. Same token as every other call, bursts merged, bounded, and cleaned up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.mjs';
import { withDefaults } from '../src/config.mjs';
import { createServer, hostsFor } from '../src/server.mjs';

const TOKEN = 'test-token-0123456789-abcdefghij';
async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-')); const e = new Engine(withDefaults({ stateDir: path.join(root, 's'), agent: { kind: 'shell' }, sandbox: { kind: 'local' }, projects: [] }), { configPath: path.join(root, 'c.json'), env: {}, factories: {} });
  const tmp = createServer(e, { token: TOKEN, allowedHosts: [] }); await new Promise((r) => tmp.listen(0, '127.0.0.1', r)); const port = tmp.address().port; tmp.close(); const srv = createServer(e, { token: TOKEN, allowedHosts: hostsFor('127.0.0.1', port) }); await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { e, port, close: () => { srv.closeAllConnections(); srv.close(); } };
}
// read the stream until `done(text)` is true or the timeout
async function listen(port, { token = TOKEN, until, ms = 3000 } = {}) {
  const ctl = new AbortController(); const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctl.signal }); if (!res.ok) return { res, text: '' };
  const reader = res.body.getReader(); const dec = new TextDecoder(); let text = ''; const t = setTimeout(() => ctl.abort(), ms); try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); if (until?.(text)) break; } } catch { /* aborted */ } clearTimeout(t); ctl.abort(); return { res, text };
}

test('stream: needs the token, says hello, and is a text/event-stream', async () => {
  const { port, close } = await boot(); try {
    assert.equal((await listen(port, { token: null })).res.status, 401); const a = await listen(port, { until: (t) => t.includes('event: hello') }); assert.equal(a.res.status, 200); assert.match(a.res.headers.get('content-type'), /text\/event-stream/); assert.match(a.text, /event: hello/);
  } finally { close(); }
});

test('stream: a change is pushed once, with its topics, and bursts are merged', async () => {
  const { e, port, close } = await boot(); try {
    const p = listen(port, { until: (t) => t.includes('event: change') }); await new Promise((r) => setTimeout(r, 150));
    e.notify('usage'); e.notify('models'); e.notify('usage'); e._audit({ what: 'x' });   // four things in a burst
    const { text } = await p; const changes = [...text.matchAll(/event: change\ndata: (.+)\n/g)].map((m) => JSON.parse(m[1])); assert.equal(changes.length, 1, 'merged into one message'); assert.deepEqual(changes[0].topics.sort(), ['audit', 'models', 'usage']);
  } finally { close(); }
});

test('stream: what changes things says so: a run event, a settings change, the router, the audit trail', async () => {
  const { e, close } = await boot(); try { const heard = []; e.bus.on('change', (t) => heard.push(...t)); const wait = () => new Promise((r) => setTimeout(r, 320));
  e._event({ type: 'phase', run: 'r', phase: 'agent', at: new Date().toISOString() }); await wait(); e._persist(); await wait(); e._audit({ what: 'x' }); await wait(); e.router().noteOk('a/b:free', { ms: 1, usage: {} }); await wait();
  for (const t of ['activity', 'config', 'audit', 'models']) assert.ok(heard.includes(t), `${t} was announced`); } finally { close(); }
});

test('stream: a closed connection is forgotten (no listener left behind) and the number of open streams is bounded', async () => {
  const { e, port, close } = await boot(); try {
    const before = e.bus.listenerCount('change'); await listen(port, { until: (t) => t.includes('hello') }); await new Promise((r) => setTimeout(r, 120)); assert.equal(e.bus.listenerCount('change'), before, 'the listener went with the connection');
    const open = []; for (let i = 0; i < 16; i++) { const ctl = new AbortController(); const r = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ctl.signal }); open.push([ctl, r]); }
    const extra = await fetch(`http://127.0.0.1:${port}/api/stream`, { headers: { Authorization: `Bearer ${TOKEN}` } }); assert.equal(extra.status, 429); for (const [c] of open) c.abort();
  } finally { close(); }
});
