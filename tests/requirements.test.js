'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../public/core.js');
const { start } = require('../server/index.js');
const auth = require('../server/auth.js');
const { schedule, completeTeam } = require('./team-fixture');
const TEXT = 'На складе перестал открываться турникет у главного входа';

function fixture() {
  const state = core.createSeedState(undefined, { triage: true });
  const employees = state.users.filter(u => u.role === 'employee');
  return { state, author: employees[0].id, peer: employees[1].id, owner: 'o1', manager: 'm1' };
}
function ticket(f) {
  return core.createTicket(f.state, f.author, { text: TEXT });
}
function accept(f, t) {
  core.accept(f.state, f.owner, t.id, { assigneeId: f.manager, dueDays: 3, ...schedule() });
  if (t.team) completeTeam(f.state, t);
}

describe('ТЗ: границы процесса и видимости', () => {
  it('привязка Telegram использует общую валидацию и не отвязывает другого сотрудника', () => {
    const f = fixture();
    auth.linkTelegram(core, f.state, f.author, '987654321');
    assert.throws(() => auth.linkTelegram(core, f.state, f.peer, '987654321'), { code: 'validation' });
    assert.equal(f.state.users.find(u => u.id === f.author).tgId, '987654321');
    assert.throws(() => auth.linkTelegram(core, f.state, f.peer, 'invalid'), { code: 'validation' });
  });
  it('старый маршрут статусов не пропускает назначение, результат или проверку собственника', () => {
    const f = fixture(), t = ticket(f);
    assert.throws(() => core.transition(f.state, f.owner, t.id, 'review', {}), { code: 'validation' });
    assert.equal(t.status, 'new');
    accept(f, t);
    for (const actor of [f.manager, f.owner]) {
      assert.throws(() => core.transition(f.state, actor, t.id, 'closed', { result: 'Готово без проверки' }), { code: 'forbidden' });
    }
    core.moveCard(f.state, f.manager, t.id, 'doing');
    assert.throws(() => core.moveCard(f.state, f.manager, t.id, 'check', {}), { code: 'validation' });
    core.moveCard(f.state, f.manager, t.id, 'check', { result: 'Турникет восстановлен, проверен проход' });
    assert.throws(() => core.transition(f.state, f.manager, t.id, 'work', {}), { code: 'validation' });
    core.moveCard(f.state, f.owner, t.id, 'solved', {});
    assert.equal(t.status, 'closed');
    assert.equal(t.verify.result, 'confirmed');
    const praise = core.createTicket(f.state, f.author, { text: TEXT, type: 'praise' });
    accept(f, praise);
    assert.throws(() => core.transition(f.state, f.manager, praise.id, 'done', {}), { code: 'validation' });
  });

  it('похожие обращения и ссылки чата не раскрывают чужую очередь и корзину', () => {
    const f = fixture(), secret = ticket(f), visible = ticket(f);
    accept(f, visible);
    assert.ok(core.findSimilar(f.state, TEXT, visible.id, f.owner).some(t => t.id === secret.id));
    assert.ok(!core.findSimilar(f.state, TEXT, visible.id, f.peer).some(t => t.id === secret.id));
    assert.ok(!core.getTicket(f.state, f.peer, visible.id).similar.some(t => t.id === secret.id));
    core.postChat(f.state, f.owner, { text: 'Проверить ' + secret.id });
    assert.deepEqual(core.listChat(f.state, f.peer).at(-1).refs, []);
    core.toTrash(f.state, f.owner, secret.id, 'Дубль');
    assert.ok(!core.findSimilar(f.state, TEXT, visible.id, f.peer).some(t => t.id === secret.id));
  });

  it('уточнение сохраняет колонку, ответ автора восстанавливает предыдущее состояние', () => {
    for (const status of ['review', 'work']) {
      const f = fixture(), t = ticket(f); accept(f, t);
      if (status === 'work') core.moveCard(f.state, f.manager, t.id, 'doing');
      const board = core.boardOf(t);
      core.addComment(f.state, f.manager, t.id, 'Уточните номер турникета', { clarify: true });
      assert.equal(t.status, 'clarify');
      assert.equal(core.boardOf(t), board);
      core.addComment(f.state, f.author, t.id, 'Турникет номер три', {});
      assert.equal(t.status, status);
      assert.equal(core.boardOf(t), board);
    }
  });

  it('напоминание о сроке отправляется один раз на конкретный срок', () => {
    const f = fixture(), t = ticket(f); accept(f, t);
    const now = Date.now();
    t.resolveDue = new Date(now + 23 * 3600000).toISOString();
    const count = () => f.state.notifications.filter(n => n.ticketId === t.id && /ближайшие 24 часа/.test(n.text)).length;
    core.tick(f.state, now); assert.equal(count(), 1);
    core.tick(f.state, now + 600000); assert.equal(count(), 1);
    t.resolveDue = new Date(now + 24 * 3600000).toISOString();
    core.tick(f.state, now + 600000); assert.equal(count(), 2);
  });

  it('любой сотрудник комментирует принятую карточку, внутренняя заметка защищена', () => {
    const f = fixture(), t = ticket(f);
    assert.throws(() => core.addComment(f.state, f.peer, t.id, 'Есть решение', {}), { code: 'not_found' });
    accept(f, t);
    core.addComment(f.state, f.peer, t.id, 'Предлагаю заменить блок питания', {});
    assert.throws(() => core.addComment(f.state, f.peer, t.id, 'Скрытая заметка', { internal: true }), { code: 'forbidden' });
  });

  it('исполнитель может составить план принятой карточки без ошибки статуса', () => {
    const f = fixture(), t = ticket(f); accept(f, t);
    assert.throws(() => core.claim(f.state, f.peer, t.id), { code: 'forbidden' });
    core.assign(f.state, f.owner, t.id, f.peer);
    core.claim(f.state, f.peer, t.id);
    const step = core.addStep(f.state, f.peer, t.id, { text: 'Проверить блок питания', assigneeId: f.peer });
    assert.equal(step.assigneeId, f.peer);
    assert.equal(t.plan.length, 1);
    assert.equal(t.status, 'work');
  });

  it('сотрудник берет свободный шаг и завершает его, не меняя чужие назначения', () => {
    const f = fixture(), t = ticket(f); accept(f, t);
    const step = core.addStep(f.state, f.manager, t.id, { text: 'Заменить блок питания', assigneeId: '' });
    assert.equal(step.assigneeId, null);
    assert.throws(() => core.setStep(f.state, f.peer, t.id, step.id, { claim: true, assigneeId: f.author }), { code: 'validation' });
    core.setStep(f.state, f.peer, t.id, step.id, { claim: true });
    assert.equal(step.assigneeId, f.peer);
    assert.throws(() => core.setStep(f.state, f.author, t.id, step.id, { claim: true }), { code: 'forbidden' });
    core.setStep(f.state, f.peer, t.id, step.id, { assigneeId: f.author });
    assert.equal(step.assigneeId, f.peer);
    core.setStep(f.state, f.peer, t.id, step.id, { state: 'done' });
    assert.equal(step.state, 'done');
    assert.throws(() => core.setStep(f.state, f.peer, t.id, step.id, { claim: true }), { code: 'validation' });
    const hidden = ticket(f);
    hidden.plan.push({ id: 'hidden-step', text: 'Закрытый шаг', state: 'todo', assigneeId: null });
    assert.throws(() => core.setStep(f.state, f.peer, hidden.id, 'hidden-step', { claim: true }), { code: 'not_found' });
  });
});

describe('ТЗ: HTTP-контракты сотрудников и права', () => {
  let app, base, dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modus-requirements-'));
    app = start({ port: 0, host: '127.0.0.1', dataDir: dir, demo: true, quiet: true, botToken: '', botPolling: false, b24Webhook: '', llm: { configured: false }, dailyCheckMs: 3600000 });
    base = 'http://127.0.0.1:' + await app.ready;
  });
  after(async () => { await app.close(); });
  async function api(method, path, user, body) {
    const response = await fetch(base + path, { method, headers: { 'X-Demo-User': user, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }

  it('создает сотрудника с уникальным id и сохраняет его; отклоняет неверную роль/должность', async () => {
    const state = app.store.state;
    const employee = state.users.find(u => u.role === 'employee').id;
    const data = { name: 'Новый сотрудник', dept: state.departments[0], role: 'employee' };
    assert.equal((await api('POST', '/api/admin/users', employee, data)).status, 403);
    for (const invalid of [{ ...data, role: 'owner' }, { ...data, jobTitle: 'А' }, { ...data, name: 'А' }, { ...data, tgId: '123' }]) {
      assert.equal((await api('POST', '/api/admin/users', 'o1', invalid)).status, 400);
    }
    const one = await api('POST', '/api/admin/users', 'o1', data);
    const two = await api('POST', '/api/admin/users', 'a1', data);
    assert.equal(one.status, 201); assert.equal(two.status, 201);
    assert.notEqual(one.body.id, two.body.id);
    assert.equal((await api('PUT', '/api/admin/users/' + one.body.id, 'o1', { tgId: '123456789' })).status, 200);
    for (const tgId of ['@handle', '-123', '1.5', '0', '123456789']) {
      assert.equal((await api('PUT', '/api/admin/users/' + two.body.id, 'o1', { tgId })).status, 400);
    }
    app.store.reload();
    assert.equal(app.store.state.users.find(u => u.id === one.body.id).tgId, '123456789');
    assert.equal((await api('PUT', '/api/admin/users/' + one.body.id, 'o1', { tgId: '' })).status, 200);
    assert.equal(app.store.state.users.find(u => u.id === one.body.id).tgId, '');
  });

  it('HTTP-подбор похожих обращений и старый transition соблюдают приватность и процесс', async () => {
    const employees = app.store.state.users.filter(u => u.role === 'employee');
    const created = await api('POST', '/api/tickets', employees[0].id, { text: TEXT });
    const similar = await api('GET', '/api/similar?text=' + encodeURIComponent(TEXT), employees[1].id);
    assert.ok(!similar.body.some(t => t.id === created.body.id));
    assert.equal((await api('POST', '/api/tickets/' + created.body.id + '/transition', 'o1', { to: 'review' })).status, 400);
    assert.equal((await api('POST', '/api/tickets/' + created.body.id + '/accept', 'o1', { assigneeId: 'm1', dueDays: 3, ...schedule() })).status, 200);
    completeTeam(app.store.state, app.store.state.tickets.find(t => t.id === created.body.id));
    app.store.save();
    assert.equal((await api('POST', '/api/tickets/' + created.body.id + '/transition', 'm1', { to: 'closed', result: 'Обход проверки' })).status, 403);
    assert.equal((await api('GET', '/api/tickets/' + created.body.id, 'm1')).body.status, 'review');
  });
});
