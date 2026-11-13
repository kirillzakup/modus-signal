'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');
const core = require(path.join(process.cwd(), 'public/core.js'));
const personalAssistant = require('../server/personal-assistant.js');
const realRequire = createRequire(path.join(process.cwd(), 'server/index.js'));

function boot(fetchImpl) {
  let handler;
  const store = { state: core.emptyState(), save() {}, close() {}, reloads: 0, reload() { this.reloads++; } };
  const server = { once() {}, listen(port, host, ready) { ready(); }, address() { return { port: 0 }; }, close(fn) { fn(); } };
  const mocks = {
    'node:http': { createServer(fn) { handler = fn; return server; } },
    './personal-assistant.js': personalAssistant,
    './db.js': { openStore: () => store },
    './agent.js': { createAgent: () => ({ runDaily() {}, onDaily() {} }) },
    './integrations/bitrix24.js': { createBitrix24: () => ({ enabled: false, pending: async () => {} }) }
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8'))(
    name => mocks[name] || realRequire(name), module, module.exports, path.join(process.cwd(), 'server'));
  const app = module.exports.start({ port: 0, demo: true, quiet: true, botToken: '', llm: { configured: false }, assistantEnv: { DEEPSEEK_API_KEY: 'unit-test-only' }, assistantFetchImpl: fetchImpl });
  function api(url, user = 'u1', body) {
    const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: body == null ? 'GET' : 'POST', url, headers: { 'x-demo-user': user, 'content-type': 'application/json' } });
    return new Promise(resolve => {
      const res = { setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; }, end(value) { resolve({ status: this.status, body: JSON.parse(value) }); } };
      handler(req, res);
    });
  }
  return { app, store, api };
}
const answer = () => Response.json({ choices: [{ message: { content: 'Проверьте причину.' }, finish_reason: 'stop' }] });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('Node route returns answer and health info while enforcing per-user ten/minute limit', async t => {
  let calls = 0;
  const f = boot(async () => { calls++; return answer(); }); t.after(() => f.app.close());
  const health = await f.api('/api/health');
  assert.deepEqual(health.body.assistant, { configured: true, provider: 'deepseek', model: 'deepseek-flash' });
  assert.deepEqual((await f.api('/api/assistant/info')).body, health.body.assistant);
  assert.equal((await f.api('/api/assistant/ask', 'missing', { question: 'Что делать?' })).status, 401);
  for (let i = 0; i < 10; i++) {
    const result = await f.api('/api/assistant/ask', 'u1', { question: 'Что делать?' });
    assert.equal(result.status, 200); assert.equal(result.body.source, 'deepseek');
  }
  assert.equal((await f.api('/api/assistant/ask', 'u1', { question: 'Что делать?' })).status, 429);
  assert.equal(calls, 10);
});

test('Node route prevents duplicate calls and rechecks active account without state rollback', async t => {
  const entered = deferred(), provider = deferred();
  let calls = 0;
  const f = boot(() => { entered.resolve(); return ++calls === 1 ? provider.promise : Promise.resolve(answer()); }); t.after(() => f.app.close());
  const pending = f.api('/api/assistant/ask', 'u1', { question: 'Что делать?' });
  await entered.promise;
  assert.equal((await f.api('/api/assistant/ask', 'u1', { question: 'Ещё вопрос?' })).status, 429);
  f.store.state.users.find(u => u.id === 'u1').disabled = true;
  f.store.state.marker = 'concurrent write';
  provider.resolve(answer());
  assert.equal((await pending).status, 403);
  assert.equal(f.store.state.marker, 'concurrent write');
  assert.equal(f.store.reloads, 0);
  f.store.state.users.find(u => u.id === 'u1').disabled = false;
  assert.equal((await f.api('/api/assistant/ask', 'u1', { question: 'Повторить?' })).status, 200);
});
