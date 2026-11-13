import { test } from 'node:test';
import assert from 'node:assert/strict';
import core from '../public/core.js';
import teamFixture from './team-fixture.js';
const { schedule, completeTeam } = teamFixture;
import { routeApi } from '../cloudflare/routes.mjs';
import { createProductionState } from '../cloudflare/seed.mjs';

function fixture() {
  const store = { state: createProductionState() };
  const owner = store.state.users[0];
  const manager = core.createUser(store.state, owner.id, { name: 'Ответственный Иван', dept: 'Закупки', role: 'manager' });
  const employee = core.createUser(store.state, owner.id, { name: 'Сотрудник Анна', dept: 'Закупки', role: 'employee' });
  const admin = core.createUser(store.state, owner.id, { name: 'Администратор Пётр', dept: 'Управление', role: 'admin' });
  async function call(method, path, body = {}, me = owner) {
    const request = new Request('https://signal.test' + path, { method });
    const response = await routeApi({ request, body, me, store });
    if (!response) return null;
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
    return { status: response.status, data, response };
  }
  return { store, owner, manager, employee, admin, call };
}

test('production state has one real owner and no demo identities, appeals or known links', () => {
  const state = createProductionState();
  assert.deepEqual(state.users.map(u => u.id), ['o1']);
  for (const key of ['tickets', 'events', 'ledger', 'notifications', 'chat', 'reports', 'redemptions']) assert.equal(state[key].length, 0, key);
  assert.equal(state.entries.length, 2);
  assert.ok(state.entries.every(e => e.code.length >= 10 && !['site', 'office', 'object-demo'].includes(e.code)));
  assert.ok(state.categories.every(c => c.owner === 'o1' && c.backup === 'o1'));
  core.ensureDefaults(state);
  assert.equal(state.entries.length, 2);
  assert.equal(state.settings.fallbackUser, 'o1');
});

test('private routes deny anonymous access and bootstrap exposes no demo login', async () => {
  const f = fixture();
  for (const path of ['/api/bootstrap', '/api/tickets', '/api/owner/digest', '/api/admin/entries', '/api/analytics', '/api/profile', '/api/agent/ask']) {
    await assert.rejects(f.call(path.endsWith('/ask') ? 'POST' : 'GET', path, {}, null), { status: 401, code: 'unauthorized' });
  }
  const boot = await f.call('GET', '/api/bootstrap');
  assert.equal(boot.data.demo, false);
  assert.equal(boot.data.auth, 'session');
  assert.equal(boot.data.me.id, 'o1');
  assert.equal(await f.call('GET', '/api/missing'), null);
  await assert.rejects(f.call('POST', '/api/admin/reset'), { status: 403 });
});

test('public submission stays private, follows all four columns, then exposes only its result', async () => {
  const f = fixture(), entry = f.store.state.entries[0];
  const submitted = await f.call('POST', '/api/public/tickets', { code: entry.code, text: 'Дверь у входа в офис не закрывается, требуется замена ручки', contactName: 'Посетитель', contactPhone: '+998901234567' }, null);
  assert.equal(submitted.status, 201);
  const { id, trackCode } = submitted.data;
  assert.ok(trackCode.length >= 16);
  assert.equal((await f.call('GET', '/api/tickets?box=board', {}, f.employee)).data.length, 0);
  await assert.rejects(f.call('GET', '/api/tickets/' + id, {}, f.employee), { code: 'not_found' });
  await assert.rejects(f.call('POST', '/api/tickets/' + id + '/accept', { assigneeId: f.manager.id }, f.manager), { code: 'forbidden' });
  assert.equal((await f.call('POST', '/api/tickets/' + id + '/accept', { assigneeId: f.manager.id, dueDays: 3, ...schedule() })).data.board, 'todo');
  await assert.rejects(f.call('POST', '/api/tickets/' + id + '/move', { col: 'doing' }, f.manager), { code: 'validation' });
  completeTeam(f.store.state, f.store.state.tickets.find(t => t.id === id));
  assert.equal((await f.call('POST', '/api/tickets/' + id + '/move', { col: 'doing' }, f.manager)).data.board, 'doing');
  await assert.rejects(f.call('POST', '/api/tickets/' + id + '/move', { col: 'check' }, f.manager), { code: 'validation' });
  await f.call('POST', '/api/tickets/' + id + '/move', { col: 'check', result: 'Ручка заменена, дверь проверена' }, f.manager);
  await assert.rejects(f.call('POST', '/api/tickets/' + id + '/move', { col: 'solved' }, f.manager), { code: 'forbidden' });
  await f.call('POST', '/api/tickets/' + id + '/move', { col: 'solved' });
  const status = (await f.call('GET', '/api/public/track/' + trackCode, {}, null)).data;
  assert.equal(status.state, 'solved');
  assert.equal(status.result, 'Ручка заменена, дверь проверена');
  for (const key of ['assigneeId', 'assigneeName', 'comments', 'contact', 'authorId', 'events']) assert.equal(status[key], undefined, key);
});

test('client cannot use the internal accepted flag to bypass owner intake validation', async () => {
  const f=fixture(),entry=f.store.state.entries[0];
  const {id}=(await f.call('POST','/api/public/tickets',{code:entry.code,text:'Неисправность оборудования требует проверки ответственным'},null)).data;
  await f.call('POST','/api/tickets/'+id+'/assign',{userId:f.manager.id});
  await assert.rejects(f.call('POST','/api/tickets/'+id+'/transition',{to:'review',accepted:true}),{code:'validation'});
  const ticket=f.store.state.tickets.find(t=>t.id===id);
  assert.equal(ticket.status,'new');
  assert.ok(!ticket.acceptedAt);
});

test('honeypot does not create an appeal, disabled source and unknown tracking codes are rejected', async () => {
  const f = fixture(), entry = f.store.state.entries[0];
  assert.equal((await f.call('POST', '/api/public/tickets', { code: entry.code, website: 'spam' }, null)).status, 201);
  assert.equal(f.store.state.tickets.length, 0);
  await f.call('PUT', '/api/admin/entries/' + entry.id, { active: false });
  await assert.rejects(f.call('POST', '/api/public/tickets', { code: entry.code, text: 'Достаточно длинное обращение' }, null), { code: 'forbidden' });
  await assert.rejects(f.call('GET', '/api/public/track/aaaaaaaaaaaaaaaaaaaaaaaa', {}, null), { code: 'not_found' });
});

test('aggregate and agent routes cannot expose a pending private appeal to employees or administrators', async () => {
  const f = fixture(), entry = f.store.state.entries[0];
  const { id } = (await f.call('POST', '/api/public/tickets', { code: entry.code, text: 'Конфиденциальный новый сигнал о проблеме' }, null)).data;
  assert.equal((await f.call('GET', '/api/analytics', {}, f.manager)).data.total, 0);
  const methods = await f.call('GET', '/api/method', {}, f.employee);
  assert.ok(!JSON.stringify(methods.data).includes(id));
  assert.ok(!JSON.stringify((await f.call('GET', '/api/solutions', {}, f.employee)).data).includes(id));
  for (const user of [f.employee, f.manager, f.admin]) {
    await assert.rejects(f.call('GET', '/api/owner/digest', {}, user), { status: 403 });
    await assert.rejects(f.call('POST', '/api/agent/solutions', { ticketId: id }, user), { code: 'not_found' });
  }
});

test('workplace user management requires administrative authority and cannot manufacture an owner', async () => {
  const f = fixture();
  await assert.rejects(f.call('POST', '/api/admin/users', { name: 'Новый пользователь', dept: 'Закупки' }, f.employee), { code: 'forbidden' });
  const result = await f.call('POST', '/api/admin/users', { name: 'Новый пользователь', dept: 'Закупки', role: 'employee' });
  assert.equal(result.status, 201);
  assert.equal(result.data.name, 'Новый пользователь');
  await assert.rejects(f.call('PUT', '/api/admin/users/' + result.data.id, { role: 'owner' }, f.admin), { status: 403 });
  await assert.rejects(f.call('PUT', '/api/admin/users/o1', { role: 'employee' }, f.owner), { status: 403 });
  await assert.rejects(f.call('PUT', '/api/admin/users/' + result.data.id, { tgId: '987654321' }, f.employee), { code: 'forbidden' });
  await assert.rejects(f.call('PUT', '/api/admin/users/o1', { tgId: '987654321' }, f.admin), { code: 'forbidden' });
  await assert.rejects(f.call('PUT', '/api/admin/users/' + f.admin.id, { tgId: '987654321' }, f.admin), { code: 'forbidden' });
  await assert.rejects(f.call('PUT', '/api/admin/users/' + result.data.id, { role: 'manager' }, f.admin), { code: 'forbidden' });
  await assert.rejects(f.call('POST', '/api/admin/users', { name: 'Новый администратор', dept: 'Управление', role: 'admin' }, f.admin), { code: 'forbidden' });
  await f.call('PUT', '/api/admin/users/' + f.admin.id, { absent: true }, f.admin);
  await f.call('PUT', '/api/admin/users/' + result.data.id, { tgId: '987654321' }, f.admin);
  assert.equal(f.store.state.users.find(u => u.id === 'o1').role, 'owner');
});

test('all read-only screens operate on empty production data and report fallback is honest', async () => {
  const f = fixture();
  for (const path of ['/api/tasks', '/api/solutions', '/api/game', '/api/game/season', '/api/method', '/api/chat', '/api/owner/people', '/api/owner/redemptions', '/api/rewards', '/api/similar', '/api/analytics', '/api/leaderboard', '/api/profile', '/api/notifications', '/api/export.csv']) {
    const result = await f.call('GET', path);
    assert.equal(result.status, 200, path);
  }
  const report = await f.call('POST', '/api/owner/report');
  assert.equal(report.status, 201);
  assert.equal(report.data.source, 'rules');
  assert.equal((await f.call('GET', '/api/owner/reports')).data.length, 1);
  const answer = await f.call('POST', '/api/agent/ask', { question: 'Что требует внимания?' });
  assert.equal(answer.data.source, 'rules');
  assert.equal(answer.data.model, null);
});

test('current stored role overrides stale identity claims, profile hides other Telegram IDs and bad URLs fail cleanly', async () => {
  const f = fixture();
  await assert.rejects(f.call('GET', '/api/bootstrap', {}, { id: 'missing', role: 'owner' }), { status: 401 });
  await assert.rejects(f.call('GET', '/api/owner/digest', {}, { ...f.employee, role: 'owner' }), { status: 403 });
  f.store.state.users.find(u => u.id === f.manager.id).tgId = '123456789';
  assert.equal((await f.call('GET', '/api/profile/' + f.manager.id, {}, f.employee)).data.user.tgId, undefined);
  assert.equal((await f.call('GET', '/api/profile', {}, f.manager)).data.user.tgId, '123456789');
  await assert.rejects(f.call('GET', '/api/tickets/%FF', {}, f.owner), { status: 400 });
});
