'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const core = require(path.join(process.cwd(), 'public/core.js'));
const personalAssistant = require('../server/personal-assistant.js');

async function fixture(fetchImpl, env = { DEEPSEEK_API_KEY: 'unit-test-only' }) {
  const fileTools = await import(pathToFileURL(path.join(process.cwd(), 'cloudflare/files.mjs')));
  class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
  class CompanyStore {
    constructor() { this.state = core.emptyState(); this.rates = new Map(); this.reloads = 0; }
    reload() { this.reloads++; }
    rateLimit(key, max) {
      const count = this.rates.get(key) || 0;
      if (count >= max) throw Object.assign(new Error('Too many'), { status: 429, code: 'rate_limited' });
      this.rates.set(key, count + 1);
    }
  }
  const source = fs.readFileSync(path.join(__dirname, '../cloudflare/worker.mjs'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export class Company', 'class Company').split('export default {')[0];
  const createAuth = store => ({ authenticate: async request => {
    const actor = store.state.users.find(user => user.id === request.headers.get('x-test-user'));
    return actor && actor.active !== false && actor.disabled !== true ? actor : null;
  } });
  const createTelegram = () => ({ enabled: false });
  const names = ['DurableObject', 'core', 'personalAssistant', 'CompanyStore', 'createAuth', 'createTelegram', ...Object.keys(fileTools)];
  const Company = new Function(...names, source + '\nreturn Company;')(
    DurableObject, core, personalAssistant, CompanyStore, createAuth, createTelegram, ...Object.values(fileTools));
  const company = new Company({ storage: {}, waitUntil() {} }, env);
  company.assistant = personalAssistant.createPersonalAssistant({ core, env, fetchImpl });
  return company;
}
function request(body = { question: 'Как решить проблему?' }, user = 'u1', extra = {}) {
  return new Request('https://signal.test/api/assistant/ask', {
    method: 'POST', headers: { origin: 'https://signal.test', 'content-type': 'application/json', 'x-test-user': user, ...extra }, body: JSON.stringify(body)
  });
}
const answer = () => Response.json({ choices: [{ message: { content: 'Проверьте причину.' }, finish_reason: 'stop' }] });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('worker keeps company queue free during provider wait and rejects concurrent requests per user', async () => {
  const entered = deferred(), provider = deferred();
  const company = await fixture(() => { entered.resolve(); return provider.promise; });
  const pending = company.fetch(request());
  await entered.promise;
  const queue = company.serial(() => { company.store.state.companyMarker = 'saved while AI waited'; return true; });
  assert.equal(await queue, true);
  assert.equal(company.bodyBudget.count, 0);
  assert.equal((await company.fetch(request())).status, 429);
  provider.resolve(answer());
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, 'Проверьте причину.');
  assert.equal(company.store.state.companyMarker, 'saved while AI waited');
  assert.equal(company.store.reloads, 0);
  assert.equal(company.assistantPending.size, 0);
});

test('worker rejects answer after session deactivation without reverting unrelated changes', async () => {
  const entered = deferred(), provider = deferred();
  const company = await fixture(() => { entered.resolve(); return provider.promise; });
  const pending = company.fetch(request());
  await entered.promise;
  await company.serial(() => { company.store.state.users.find(u => u.id === 'u1').active = false; });
  provider.resolve(answer());
  assert.equal((await pending).status, 401);
  assert.equal(company.store.reloads, 0);
  assert.equal(company.assistantPending.size, 0);
});

test('worker checks card visibility before dispatch and again after provider response', async () => {
  const entered = deferred(), provider = deferred();
  const company = await fixture(() => { entered.resolve(); return provider.promise; });
  const ticket = core.createTicket(company.store.state, 'u1', { type: 'problem', title: 'Проблема', text: 'Нужен совет по рабочей проблеме' });
  const body = { question: 'Как решить?', ticketId: ticket.id };
  assert.equal((await company.fetch(request(body, 'u2'))).status, 404);
  const pending = company.fetch(request(body));
  await entered.promise;
  await company.serial(() => { ticket.authorId = 'u2'; });
  provider.resolve(answer());
  assert.equal((await pending).status, 404);
  assert.equal(company.store.reloads, 0);
});

test('worker requires authentication, same origin, JSON, and enforces ten questions per minute', async () => {
  let calls = 0;
  const company = await fixture(async () => { calls++; return answer(); });
  assert.equal((await company.fetch(request({}, 'missing'))).status, 401);
  assert.equal((await company.fetch(request(undefined, 'u1', { origin: 'https://elsewhere.test' }))).status, 403);
  assert.equal((await company.fetch(request(undefined, 'u1', { 'content-type': 'text/plain' }))).status, 415);
  assert.equal(calls, 0);
  for (let i = 0; i < 10; i++) assert.equal((await company.fetch(request())).status, 200);
  assert.equal((await company.fetch(request())).status, 429);
  assert.equal(calls, 10);
});

test('worker exposes actionable safe errors and releases reservations on provider failures', async () => {
  const company = await fixture(async () => new Response('secret provider details', { status: 402 }));
  const response = await company.fetch(request());
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, 'ai_balance');
  assert.match(body.error, /администратору/);
  assert.doesNotMatch(body.error, /secret/);
  assert.equal(company.assistantPending.size, 0);
  assert.equal(company.store.reloads, 0);
  const health = await company.fetch(new Request('https://signal.test/api/health'));
  assert.deepEqual((await health.json()).assistant, { configured: true, provider: 'deepseek', model: 'deepseek-flash' });
});
