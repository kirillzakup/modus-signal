'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOwnerReport } = require('../server/owner-reports');
const { enrichOwnerReport } = require('../server/owner-report-ai');
const report = () => buildOwnerReport({ users: [{ id: 'e1', name: 'Анна', jobTitle: 'Инженер', role: 'employee' }], tickets: [], ledger: [], events: [] }, { now: '2026-11-13T04:00:00Z' });
const env = { DEEPSEEK_API_KEY: 'test-only-not-a-real-key' };
const answer = text => Response.json({ choices: [{ finish_reason: 'stop', message: { content: text } }] });
test('without key report remains factual and no request occurs', async () => {
  const result = await enrichOwnerReport(report(), { fetchImpl() { throw new Error('must not call'); } });
  assert.equal(result.aiStatus, 'notconfigured'); assert.equal(result.source, 'facts');
});
test('AI commentary never mutates facts or original report; provider gets bounded context', async () => {
  const input = report(), before = JSON.stringify(input);
  input.employees[0].assessment = 'а'.repeat(50000);
  const result = await enrichOwnerReport(input, { env, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'deepseek-flash'); assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.ok(body.messages[1].content.length <= 40000);
    assert.match(body.messages[0].content, /Не рекомендуй увольнение/);
    return answer('Недостаточно данных для вывода о работе Анны вне системы.');
  } });
  assert.equal(result.aiStatus, 'ready'); assert.equal(result.source, 'ai');
  assert.deepEqual(result.summary, input.summary); assert.deepEqual(result.employees, input.employees);
  assert.equal(input.aiText, ''); assert.equal(input.source, 'facts');
  assert.equal(JSON.parse(before).summary.solved, result.summary.solved);
});
test('balance, malformed, truncated, oversized, and network failures preserve factual fallback', async () => {
  const cases = [() => new Response('private provider error', { status: 402 }), () => new Response('bad json'),
    () => Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }),
    () => new Response('x'.repeat(100001)), () => { throw new Error('secret in error'); }];
  for (const fetchImpl of cases) {
    const result = await enrichOwnerReport(report(), { env, fetchImpl });
    assert.equal(result.aiStatus, 'unavailable'); assert.equal(result.aiText, '');
    assert.doesNotMatch(JSON.stringify(result), /secret in error|private provider error|test-only-not-a-real-key/);
  }
});
test('timeout ends even when a provider mock ignores AbortSignal', async () => {
  const result = await enrichOwnerReport(report(), { env, timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
  assert.equal(result.aiStatus, 'unavailable');
});
