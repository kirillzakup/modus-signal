'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/core.js');
const NOW = Date.now();
const schedule = (collect = 48, vote = 72) => ({ collectUntil: new Date(NOW + collect * 3600000).toISOString(), voteUntil: new Date(NOW + vote * 3600000).toISOString() });

function fixture(ids = ['u1', 'u2', 'm1', 'o1']) {
  const state = C.emptyState();
  state.users = state.users.filter(u => ids.includes(u.id));
  const ticket = C.createTicket(state, 'u1', { text: 'В переговорной постоянно отключается экран, нужна проверка подключения.' }, NOW);
  C.accept(state, 'o1', ticket.id, { assigneeId: 'm1', ...schedule() }, NOW);
  return { state, ticket };
}
function collect(ctx) {
  const { state: s, ticket: t } = ctx;
  const a = C.proposeOption(s, 'u1', t.id, { text: 'Заменить кабель на новый сертифицированный.' }, NOW + 1);
  const b = C.proposeOption(s, 'u2', t.id, { text: 'Проверить разъёмы и настройки всех ноутбуков.' }, NOW + 2);
  C.teamPass(s, 'm1', t.id, 'Пока поддержу варианты коллег', NOW + 3);
  C.teamPass(s, 'o1', t.id, 'Варианты команды достаточны', NOW + 4);
  return { a, b };
}
function win(ctx) {
  const { state: s, ticket: t } = ctx, { a, b } = collect(ctx);
  for (const id of ['u1', 'u2', 'm1', 'o1']) C.voteOption(s, id, t.id, a.id, NOW + 10);
  return { a, b };
}
function coins(s, id, kind) { return s.ledger.filter(l => l.userId === id && l.kind === kind); }

test('accepted problem begins with all active members and cannot skip participation', () => {
  const { state: s, ticket: t } = fixture();
  assert.equal(t.team.phase, 'collect');
  assert.equal(t.team.participants.length, 4);
  assert.equal(Date.parse(t.team.collectUntil) - NOW, 48 * 3600000);
  const option = C.proposeOption(s, 'u1', t.id, { text: 'Проверить кабель подключения и порт.' }, NOW + 1);
  const denied = [
    () => C.voteOption(s, 'u2', t.id, option.id, NOW + 2),
    () => C.chooseOption(s, 'm1', t.id, option.id, 'Удобный вариант', NOW + 2),
    () => C.advanceTeam(s, 'o1', t.id, NOW + 2),
    () => C.transition(s, 'm1', t.id, 'work', {}, NOW + 2),
    () => C.transition(s, 'm1', t.id, 'done', { result: 'Готово, всё проверено' }, NOW + 2),
    () => C.moveCard(s, 'm1', t.id, 'doing', {}, NOW + 2),
    () => C.moveCard(s, 'm1', t.id, 'check', { result: 'Готово' }, NOW + 2),
    () => C.claim(s, 'u2', t.id, NOW + 2),
    () => C.addStep(s, 'm1', t.id, { text: 'Сделать работу' }, NOW + 2)
  ];
  for (const action of denied) assert.throws(action);
  t.plan.push({ id: 'legacy-step', assigneeId: 'u2', text: 'Старый шаг', state: 'todo' });
  assert.throws(() => C.setStep(s, 'u2', t.id, 'legacy-step', { state: 'done' }, NOW + 2));
  assert.equal(t.status, 'review');
});

test('proposal rewards once, duplicate text rejected, pass pays no coins and all replies start voting', () => {
  const ctx = fixture(), { state: s, ticket: t } = ctx;
  C.proposeOption(s, 'u1', t.id, { text: 'Проверить кабель подключения и порт.' }, NOW + 1);
  assert.throws(() => C.proposeOption(s, 'u1', t.id, { text: 'Другой вариант для получения монет' }, NOW + 2));
  assert.throws(() => C.proposeOption(s, 'u2', t.id, { text: '  ПРОВЕРИТЬ   кабель подключения и порт. ' }, NOW + 2));
  assert.equal(coins(s, 'u1', 'optionProposed').length, 1);
  assert.equal(coins(s, 'u1', 'optionProposed')[0].amount, 5);
  for (const id of ['u2', 'm1', 'o1']) C.teamPass(s, id, t.id, 'Пока нет своего варианта', NOW + 3);
  assert.equal(t.team.phase, 'vote');
  assert.equal(coins(s, 'u2', 'optionProposed').length, 0);
  assert.equal(C.getTicket(s, 'u1', t.id).team.respondedCount, 4);
  assert.throws(() => C.proposeOption(s, 'u2', t.id, { text: 'Опоздавший вариант после начала голосования' }, NOW + 4));
});

test('one ballot per participant, changes do not farm coins; winner is selected automatically', () => {
  const ctx = fixture(), { state: s, ticket: t } = ctx, { a, b } = collect(ctx);
  C.voteOption(s, 'u1', t.id, a.id, NOW + 10);
  C.voteOption(s, 'u1', t.id, a.id, NOW + 11);
  C.voteOption(s, 'u1', t.id, b.id, NOW + 12);
  assert.deepEqual(a.votes, []);
  assert.deepEqual(b.votes, ['u1']);
  assert.equal(coins(s, 'u1', 'optionVoted').length, 1);
  assert.equal(coins(s, 'u1', 'optionVoted')[0].amount, 2);
  for (const id of ['u2', 'm1', 'o1']) C.voteOption(s, id, t.id, b.id, NOW + 13);
  assert.equal(t.team.phase, 'ready');
  assert.equal(t.status, 'review');
  assert.equal(t.solution, b.text);
  assert.equal(t.decision.optionId, b.id);
  assert.equal(coins(s, 'u2', 'optionChosen').length, 1);
  C.voteOption(s, 'u1', t.id, b.id, NOW + 14);
  assert.throws(() => C.voteOption(s, 'u1', t.id, a.id, NOW + 14));
  assert.throws(() => C.chooseOption(s, 'o1', t.id, a.id, 'Хочу поменять выбор', NOW + 14));
  C.moveCard(s, 'm1', t.id, 'doing', {}, NOW + 15);
  assert.equal(coins(s, 'u1', 'solution').length, 0);
  C.moveCard(s, 'm1', t.id, 'check', { result: 'Кабель проверен, изображение стабильно' }, NOW + 16);
  C.moveCard(s, 'o1', t.id, 'solved', {}, NOW + 17);
  assert.equal(t.status, 'closed');
});

test('tie can only be resolved among highest-scoring options after voting', () => {
  const ctx = fixture(), { state: s, ticket: t } = ctx, { a, b } = collect(ctx);
  const extra = { id: 'third', userId: 'm1', text: 'Третий вариант без поддержки', votes: [], at: new Date(NOW).toISOString() }; t.options.push(extra);
  ['u1', 'u2'].forEach(id => C.voteOption(s, id, t.id, a.id, NOW + 10));
  ['m1', 'o1'].forEach(id => C.voteOption(s, id, t.id, b.id, NOW + 10));
  assert.equal(t.team.phase, 'vote');
  const view = C.getTicket(s, 'm1', t.id).team;
  assert.equal(view.canChoose, true);
  assert.deepEqual(view.topIds.sort(), [a.id, b.id].sort());
  assert.throws(() => C.voteOption(s, 'u1', t.id, b.id, NOW + 11), /Голосование завершено/);
  assert.equal(t.team.ballots.u1, a.id);
  C.voteOption(s, 'u1', t.id, a.id, NOW + 11);
  assert.throws(() => C.chooseOption(s, 'm1', t.id, extra.id, 'Потому что проще', NOW + 11));
  assert.throws(() => C.chooseOption(s, 'u1', t.id, a.id, 'Мне так нравится', NOW + 11));
  C.chooseOption(s, 'm1', t.id, b.id, 'При равенстве голосов этот вариант быстрее проверить', NOW + 11);
  assert.equal(t.team.phase, 'ready');
  C.chooseOption(s, 'm1', t.id, b.id, 'Повторная доставка', NOW + 12);
  assert.equal(coins(s, 'u2', 'optionChosen').length, 1);
});

test('deadlines advance once, zero options/zero votes do not fabricate a winner', () => {
  const { state: s, ticket: t } = fixture();
  C.tick(s, NOW + 49 * 3600000);
  C.tick(s, NOW + 50 * 3600000);
  assert.equal(t.team.phase, 'collect');
  assert.equal(s.notifications.filter(n => n.text.includes('предложений пока нет')).length, 1);
  const option = C.proposeOption(s, 'u1', t.id, { text: 'Поздний, но содержательный вариант решения' }, NOW + 51 * 3600000);
  assert.equal(t.team.phase, 'vote');
  C.tick(s, NOW + 76 * 3600000);
  C.tick(s, NOW + 77 * 3600000);
  assert.equal(t.team.phase, 'vote'); assert.equal(t.decision, null);
  assert.equal(s.notifications.filter(n => n.text.includes('голосов нет')).length, 1);
  C.voteOption(s, 'u2', t.id, option.id, NOW + 78 * 3600000);
  assert.equal(t.team.phase, 'ready');
});

test('migration preserves running/completed work and all historical balances', () => {
  const s = C.emptyState();
  const pending = C.createTicket(s, 'u1', { text: 'Новая проблема для проверки миграции' }, NOW);
  const review = C.createTicket(s, 'u1', { text: 'Старая принятая проблема для сбора вариантов' }, NOW);
  review.status = 'review'; review.assigneeId = 'm1';
  const work = C.createTicket(s, 'u1', { text: 'Другая проблема, над которой уже работают' }, NOW);
  work.status = 'work'; work.assigneeId = 'm1';
  const done = C.createTicket(s, 'u1', { text: 'Проблема, по которой уже записан результат' }, NOW);
  done.status = 'done'; done.assigneeId = 'm1';
  s.ledger.push({ id: 'old', userId: 'u1', amount: 71, kind: 'bonus', at: new Date(NOW).toISOString() });
  const ledger = JSON.stringify(s.ledger);
  C.ensureDefaults(s); const count = s.events.length, notifications = s.notifications.length;
  C.ensureDefaults(s);
  assert.equal(pending.team, undefined); assert.equal(review.team.phase, 'setup');
  assert.equal(review.team.collectUntil, null);
  assert.throws(() => C.proposeOption(s, 'u1', review.id, { text: 'Нельзя предлагать до назначения сроков' }, NOW));
  assert.equal(work.team, undefined); assert.equal(done.team, undefined);
  assert.equal(JSON.stringify(s.ledger), ledger);
  assert.equal(s.events.length, count); assert.equal(s.notifications.length, notifications);
});

test('disabled or absent members cannot participate and are not required for completion', () => {
  const { state: s, ticket: t } = fixture();
  s.users.find(u => u.id === 'u2').active = false;
  assert.throws(() => C.proposeOption(s, 'u2', t.id, { text: 'Попытка отключённого пользователя' }, NOW + 1));
  C.proposeOption(s, 'u1', t.id, { text: 'Заменить кабель и проверить стабильность изображения' }, NOW + 1);
  ['m1', 'o1'].forEach(id => C.teamPass(s, id, t.id, 'Нет собственного предложения', NOW + 2));
  assert.equal(t.team.phase, 'vote');
  assert.equal(C.getTicket(s, 'u1', t.id).team.total, 3);
});

test('team of more than twelve can contribute using explicitly chosen deadlines', () => {
  const s = C.emptyState();
  const t = C.createTicket(s, 'u1', { text: 'Проблема для обсуждения всей большой командой' }, NOW);
  C.accept(s, 'o1', t.id, { assigneeId: 'm1', ...schedule(12, 18) }, NOW);
  t.team.participants.forEach((id, n) => C.proposeOption(s, id, t.id, { text: 'Содержательное предложение номер ' + n + ' для решения проблемы' }, NOW + n));
  assert.ok(t.options.length > 12); assert.equal(t.team.phase, 'vote');
  assert.equal(Date.parse(t.team.collectUntil) - NOW, 12 * 3600000);
  assert.equal(Date.parse(t.team.voteUntil) - NOW, 18 * 3600000);
});

test('accept requires manager deadlines and rejects invalid schedule without modifying the ticket', () => {
  const s = C.emptyState(), t = C.createTicket(s, 'u1', { text: 'Новая проблема для проверки назначенных сроков' }, NOW);
  const original = JSON.stringify(t);
  for (const dates of [{}, schedule(-1, 5), schedule(5, 4), schedule(12, 500), { collectUntil: '2026-12-01', voteUntil: '2026-12-02' }]) {
    assert.throws(() => C.accept(s, 'o1', t.id, { assigneeId: 'm1', categoryId: 'c07', ...dates }, NOW));
    assert.equal(JSON.stringify(t), original);
  }
});

test('setup scheduling notifies members; extensions keep replies and ballots, final winner is immutable', () => {
  const s = C.emptyState(); s.users = s.users.filter(u => ['u1', 'u2', 'm1', 'o1'].includes(u.id));
  const t = C.createTicket(s, 'u1', { text: 'Старое принятое обращение ждёт нового расписания' }, NOW); t.status = 'review'; t.assigneeId = 'm1';
  C.ensureDefaults(s);
  assert.equal(t.team.phase, 'setup');
  assert.equal(C.getTicket(s, 'm1', t.id).team.canSchedule, true);
  assert.throws(() => C.setTeamDeadlines(s, 'u1', t.id, schedule(), NOW));
  C.setTeamDeadlines(s, 'm1', t.id, schedule(), NOW);
  assert.equal(t.team.phase, 'collect');
  const { a, b } = collect({ state: s, ticket: t });
  C.voteOption(s, 'u1', t.id, a.id, NOW + 5);
  C.voteOption(s, 'u2', t.id, b.id, NOW + 6);
  const before = JSON.stringify(t.team.ballots), ledger = JSON.stringify(s.ledger);
  C.setTeamDeadlines(s, 'm1', t.id, schedule(48, 100), NOW + 73 * 3600000);
  assert.equal(JSON.stringify(t.team.ballots), before); assert.equal(JSON.stringify(s.ledger), ledger);
  assert.throws(() => C.setTeamDeadlines(s, 'm1', t.id, schedule(50, 120), NOW + 74 * 3600000));
  C.voteOption(s, 'm1', t.id, a.id, NOW + 75 * 3600000);
  assert.throws(() => C.setTeamDeadlines(s, 'm1', t.id, schedule(48, 130), NOW + 101 * 3600000));
  C.advanceTeam(s, 'o1', t.id, NOW + 101 * 3600000);
  assert.equal(t.team.phase, 'ready');
  assert.throws(() => C.setTeamDeadlines(s, 'm1', t.id, schedule(48, 140), NOW + 101 * 3600000));
});

test('default demo seed builds with explicit sample deadlines', () => {
  const s = C.createSeedState(NOW);
  assert.ok(s.tickets.length > 10);
  assert.ok(s.tickets.some(t => t.team && t.team.phase === 'collect'));
  for (const t of s.tickets.filter(t => t.team)) {
    assert.ok(Date.parse(t.team.voteUntil) > Date.parse(t.team.collectUntil));
    assert.ok(Date.parse(t.resolveDue) >= Date.parse(t.team.voteUntil));
  }
});

test('overdue legacy review can receive an explicit new overall deadline without resetting balances', () => {
  const s = C.emptyState(), t = C.createTicket(s, 'u1', { text: 'Старая просроченная проблема с неработающим экраном' }, NOW - 90 * 86400000);
  t.status = 'review'; t.assigneeId = 'u2'; t.resolveDue = new Date(NOW - 86400000).toISOString();
  s.ledger.push({ id: 'historic', userId: 'u1', kind: 'bonus', amount: 17, at: new Date(NOW).toISOString() });
  C.ensureDefaults(s);
  const before = JSON.stringify(s.ledger), oldDue = t.resolveDue;
  assert.throws(() => C.setTeamDeadlines(s, 'u2', t.id, schedule(), NOW));
  assert.throws(() => C.setTeamDeadlines(s, 'u2', t.id, { ...schedule(), resolveDue: 'invalid' }, NOW));
  assert.equal(t.resolveDue, oldDue);
  const resolveDue = new Date(NOW + 96 * 3600000).toISOString();
  C.setTeamDeadlines(s, 'u2', t.id, { ...schedule(), resolveDue }, NOW);
  assert.equal(t.resolveDue, resolveDue); assert.equal(t.team.phase, 'collect');
  assert.equal(JSON.stringify(s.ledger), before);
});

test('employee responsibility is scoped to assigned tickets and can execute the chosen solution', () => {
  const ctx = fixture(), { state: s, ticket: t } = ctx;
  C.assign(s, 'o1', t.id, 'u2', NOW + 1);
  assert.equal(C.getTicket(s, 'u2', t.id).canManage, true);
  assert.equal(C.getTicket(s, 'u2', t.id).canPlan, true);
  assert.equal(C.getTicket(s, 'u1', t.id).canManage, false);
  assert.equal(C.getTicket(s, 'u1', t.id).canPlan, false);
  assert.throws(() => C.assign(s, 'u1', t.id, 'u1', NOW + 1));
  assert.throws(() => C.setTeamDeadlines(s, 'u1', t.id, schedule(50, 75), NOW + 1));
  const { a } = win(ctx);
  assert.equal(t.decision.optionId, a.id);
  assert.throws(() => C.claim(s, 'u1', t.id, NOW + 20));
  assert.throws(() => C.transition(s, 'u1', t.id, 'work', {}, NOW + 20));
  C.claim(s, 'u2', t.id, NOW + 20);
  assert.equal(t.status, 'work');
  const step = C.addStep(s, 'u2', t.id, { text: 'Заменить кабель', assigneeId: 'u2' }, NOW + 21);
  assert.throws(() => C.setStep(s, 'u1', t.id, step.id, { state: 'done' }, NOW + 22));
  C.setStep(s, 'u2', t.id, step.id, { state: 'done' }, NOW + 22);
  C.moveCard(s, 'u2', t.id, 'check', { result: 'Заменили кабель, экран работает стабильно' }, NOW + 23);
  assert.throws(() => C.verifyEffect(s, 'u2', t.id, { ok: true }, NOW + 24));
  C.verifyEffect(s, 'o1', t.id, { ok: true }, NOW + 24);
  assert.equal(t.status, 'closed');
  s.users.find(u => u.id === 'u2').active = false;
  assert.equal(C.getTicket(s, 'u2', t.id).canManage, false);
});

test('accept permits active employee and rejects disabled targets; free job title needs no department', () => {
  const s = C.emptyState(), title = 'Инженер по испытаниям оборудования';
  const employee = C.createUser(s, 'o1', { name: 'Иван Петров', jobTitle: title });
  assert.equal(employee.jobTitle, title); assert.equal(employee.dept, ''); assert.equal(employee.role, 'employee');
  assert.equal(C.bootstrap(s, 'o1').users.find(u => u.id === employee.id).jobTitle, title);
  for (const jobTitle of ['', 'Я', 'A'.repeat(101), 'test\u0000test', 123]) assert.throws(() => C.createUser(s, 'o1', { name: 'Новый человек', jobTitle }));
  const t = C.createTicket(s, 'u1', { text: 'Проблема для назначения обычного сотрудника' }, NOW);
  C.accept(s, 'o1', t.id, { assigneeId: employee.id, ...schedule() }, NOW);
  assert.equal(t.assigneeId, employee.id); assert.equal(C.getTicket(s, employee.id, t.id).canManage, true);
  s.users.find(u => u.id === employee.id).disabled = true;
  const other = C.createTicket(s, 'u1', { text: 'Проблема для проверки отключённого ответственного' }, NOW);
  assert.throws(() => C.accept(s, 'o1', other.id, { assigneeId: employee.id, ...schedule() }, NOW));
});
