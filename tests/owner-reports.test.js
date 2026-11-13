'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { buildOwnerReport, formatOwnerReportText, renderOwnerReportPdf, periodFor } = require('../server/owner-reports');
const now = '2026-11-13T04:05:00.000Z'; // 09:05 in Tashkent.
const at = '2026-11-12T08:00:00.000Z';
function fixture() {
  return {
    users: [{ id: 'o1', name: 'Собственник', role: 'owner' }, { id: 'e1', name: 'Анна', role: 'employee', jobTitle: 'Инженер' },
      { id: 'e2', name: 'Иван', role: 'employee', absent: true }, { id: 'old', name: 'Отключён', role: 'employee', disabled: true }],
    tickets: [{ id: 'A-001', title: 'Исправить передачу заявки', type: 'problem', status: 'closed', assigneeId: 'e1', authorId: 'e2',
      options: [{ id: 'op1', userId: 'e1', text: 'Добавить проверку', at }], decision: { optionId: 'op1', at },
      result: 'Проверка добавлена', verify: { result: 'confirmed', at, after: 'Заявки не теряются' } },
    { id: 'A-002', title: 'Срок поставки', type: 'problem', status: 'work', assigneeId: 'e2', resolveDue: '2026-11-12T00:00:00.000Z' },
    { id: 'A-003', title: 'Анонимная проблема', type: 'problem', status: 'review', authorId: 'e2', anonymous: true,
      options: [{ id: 'op3', userId: 'e2', text: 'Предложение', at }] }],
    events: [{ id: 'ev1', kind: 'status', ticketId: 'A-001', userId: 'e1', to: 'done', at },
      { id: 'ev2', kind: 'status', ticketId: 'A-001', userId: 'o1', from: 'done', to: 'closed', at }],
    ledger: [{ id: 'l1', kind: 'optionVoted', userId: 'e1', ticketId: 'A-001', amount: 2, at },
      { id: 'l2', kind: 'step', stepId: 's1', userId: 'e1', ticketId: 'A-001', amount: 5, at },
      { id: 'l3', kind: 'optionProposed', userId: 'e1', ticketId: 'A-001', amount: 5, at }]
  };
}

test('previous-day report uses Tashkent midnight including UTC boundary', () => {
  const p = periodFor(now);
  assert.equal(p.day, '2026-11-12');
  assert.equal(p.start, '2026-11-11T19:00:00.000Z');
  assert.equal(p.end, '2026-11-12T19:00:00.000Z');
  const state = fixture();
  state.tickets[0].options = [
    { id: 'first', userId: 'e1', at: p.start },
    { id: 'before', userId: 'e1', at: '2026-11-11T18:59:59.999Z' },
    { id: 'last', userId: 'e1', at: '2026-11-12T18:59:59.999Z' },
    { id: 'after', userId: 'e1', at: p.end }
  ];
  assert.deepEqual(buildOwnerReport(state, { now }).employees[0].proposals.map(p => p.optionId), ['first', 'last']);
});

test('invalid and future day inputs fail; current day never counts future actions', () => {
  for (const day of ['2026-02-30', '2026-11-14', '12.11.2026', {}, '2026-13-01']) assert.throws(() => periodFor(now, day));
  assert.throws(() => periodFor('not a date'));
  const state = fixture(); state.tickets[0].options[0].at = '2026-11-13T10:00:00Z';
  assert.equal(buildOwnerReport(state, { now, day: '2026-11-13' }).summary.proposals, 0);
});

test('report counts actual proposals, ballots, steps and confirmed outcomes without mutation', () => {
  const state = fixture(), before = JSON.stringify(state);
  const report = buildOwnerReport(state, { now });
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(report.summary, { solved: 1, resultsSubmitted: 1, proposals: 2, votes: 1, steps: 1, pending: 2, overdue: 1, employees: 2 });
  const person = report.employees[0];
  assert.equal(person.jobTitle, 'Инженер');
  for (const key of ['proposals', 'votes', 'steps', 'chosen', 'submittedResults', 'assignedSolved']) assert.equal(person[key].length, 1, key);
  assert.equal(person.coinsEarned, 12);
  assert.equal(report.solved[0].effect, 'Заявки не теряются');
  assert.equal(report.source, 'facts');
});

test('anonymous author is not exposed through personal evidence or coin totals', () => {
  const state = fixture();
  state.ledger.push({ id: 'private', kind: 'optionProposed', ticketId: 'A-003', userId: 'e2', amount: 5, at });
  const report = buildOwnerReport(state, { now });
  assert.equal(report.employees[1].proposals.length, 0);
  assert.equal(report.employees[1].coinsEarned, 0);
  assert.ok(!JSON.stringify(report.pending).includes('authorId'));
  assert.ok(report.limitations.some(s => s.includes('Анонимные')));
});

test('repeated completion events and duplicate activity records do not inflate action counts', () => {
  const state = fixture();
  state.events.push({ ...state.events[0], id: 'again' }, { ...state.events[1], id: 'again2' });
  state.ledger.push({ ...state.ledger[0], id: 'again3' }, { ...state.ledger[1], id: 'again4' });
  const report = buildOwnerReport(state, { now });
  assert.equal(report.summary.solved, 1);
  assert.equal(report.summary.votes, 1);
  assert.equal(report.summary.steps, 1);
  assert.equal(report.employees[0].submittedResults.length, 1);
  assert.equal(report.employees[0].votes.length, 1);
});

test('no activity is described as insufficient evidence, absent employees are not penalized', () => {
  const report = buildOwnerReport(fixture(), { now });
  const person = report.employees[1];
  assert.match(person.assessment, /Данных для вывода о работе вне системы недостаточно/);
  assert.match(person.assessment, /отмечено отсутствие/);
  assert.match(person.assessment, /уточнить причины и необходимую помощь/);
  assert.doesNotMatch(person.assessment, /увол|плохой|ленив|ненад[её]жен/);
});

test('legacy ballots without a dated ledger are not invented as daily participation', () => {
  const state = fixture(); state.ledger = []; state.tickets[0].options[0].votes = ['e1', 'e2'];
  const report = buildOwnerReport(state, { now });
  assert.equal(report.summary.votes, 0);
  assert.match(report.limitations.join(' '), /старые голоса без даты/);
});

test('text clearly distinguishes factual fallback and optional AI commentary', () => {
  const report = buildOwnerReport(fixture(), { now });
  assert.match(report.text, /Анализ ИИ пока не добавлен/);
  report.aiStatus = 'ready'; report.aiText = 'Есть результат по A-001. Уточните препятствия по A-002.';
  const text = formatOwnerReportText(report);
  assert.match(text, /Есть результат по A-001/);
  assert.doesNotMatch(text, /Анализ ИИ пока не добавлен/);
  assert.match(text, /Карточки: A-001/);
});

test('Russian PDF is a readable multipage document with embedded Unicode font', async () => {
  let root = __dirname;
  while (!fs.existsSync(path.join(root, 'public', 'vendor', 'NotoSans-Regular.ttf'))) {
    const parent = path.dirname(root); if (parent === root) throw new Error('Missing NotoSans-Regular.ttf'); root = parent;
  }
  const report = buildOwnerReport(fixture(), { now });
  report.aiStatus = 'ready'; report.aiText = 'Проверка кириллицы и переноса строк. '.repeat(250) + '😃';
  const bytes = await renderOwnerReportPdf(report, { fontBytes: fs.readFileSync(path.join(root, 'public', 'vendor', 'NotoSans-Regular.ttf')) });
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-');
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() > 1);
  assert.equal(pdf.getTitle(), 'МОДУС · СИГНАЛ — отчёт за 2026-11-12');
  assert.ok(bytes.length > 15000);
  const target = path.join(root, 'artifacts', 'owner-report-work', 'owner-report-sample.pdf');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
});

test('PDF refuses missing font and malformed report', async () => {
  await assert.rejects(renderOwnerReportPdf({}, { fontBytes: new Uint8Array() }), /Некорректный отчёт/);
  await assert.rejects(renderOwnerReportPdf(buildOwnerReport(fixture(), { now })), /шрифт с кириллицей/);
});
