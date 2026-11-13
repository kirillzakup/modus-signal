'use strict';

// Pure report data and PDF output shared by Node and Cloudflare Workers.
// Callers must enforce owner access before building, saving or downloading.
const DAY = 86400000;
const OFFSET = 5 * 3600000; // Asia/Tashkent has UTC+05:00, without daylight saving.
const OPEN = new Set(['new', 'review', 'clarify', 'work']);
const clean = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '';
const stamp = value => typeof value === 'number' ? value : Date.parse(value);
const list = value => Array.isArray(value) ? value : [];
const dayAt = value => new Date(value + OFFSET).toISOString().slice(0, 10);
const order = (a, b) => String(a.id).localeCompare(String(b.id), 'en');
const localTime = value => Number.isFinite(stamp(value)) ? new Date(stamp(value)).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Не указан';

function periodFor(now, day) {
  const value = stamp(now == null ? Date.now() : now);
  if (!Number.isFinite(value)) throw new Error('Некорректная дата отчёта');
  const key = day == null ? dayAt(value - DAY) : day;
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('Дата отчёта: ГГГГ-ММ-ДД');
  const midnight = Date.parse(key + 'T00:00:00.000Z');
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== key || key > dayAt(value)) throw new Error('Некорректный день отчёта');
  const start = midnight - OFFSET, end = start + DAY;
  return { day: key, start: new Date(start).toISOString(), end: new Date(end).toISOString(), timezone: 'Asia/Tashkent', snapshotAt: new Date(value).toISOString() };
}

function buildOwnerReport(state, options = {}) {
  if (!state || typeof state !== 'object') throw new Error('Нет данных компании');
  const period = periodFor(options.now, options.day);
  const start = stamp(period.start), end = Math.min(stamp(period.end), stamp(period.snapshotAt) + 1);
  const during = at => { const t = stamp(at); return Number.isFinite(t) && t >= start && t < end; };
  const users = list(state.users), tickets = list(state.tickets).filter(t => t.type !== 'praise' && t.status !== 'trash');
  const byTicket = new Map(tickets.map(t => [t.id, t]));
  const employeeMap = new Map(users.filter(u => u.id && u.role !== 'owner' && u.role !== 'public' && u.active !== false && u.disabled !== true).map(u => [u.id, {
    id: u.id, name: clean(u.name, 100) || 'Сотрудник', jobTitle: clean(u.jobTitle, 100), absent: !!u.absent,
    proposals: [], votes: [], chosen: [], steps: [], submittedResults: [], assignedSolved: [], coinsEarned: 0,
    currentAssigned: [], overdue: [], assessment: ''
  }]));
  const add = (userId, field, ticket, extra = {}) => {
    const row = employeeMap.get(userId);
    // Do not reconstruct an anonymous author's identity through activity tables.
    if (!row || (ticket.anonymous && ticket.authorId === userId)) return;
    const item = Object.assign({ ticketId: ticket.id, title: clean(ticket.title, 160) }, extra);
    const key = item.eventId || item.stepId || item.optionId || item.ticketId;
    if (!row[field].some(x => (x.eventId || x.stepId || x.optionId || x.ticketId) === key)) row[field].push(item);
  };
  let proposalCount = 0;
  for (const ticket of tickets) {
    for (const proposal of list(ticket.options)) {
      if (during(proposal.at)) { proposalCount++; add(proposal.userId, 'proposals', ticket, { optionId: proposal.id, at: proposal.at }); }
      if (ticket.decision && ticket.decision.optionId === proposal.id && during(ticket.decision.at)) add(proposal.userId, 'chosen', ticket, { optionId: proposal.id, at: ticket.decision.at });
    }
  }
  const voteKeys = new Set(), stepKeys = new Set();
  for (const entry of list(state.ledger)) {
    if (!during(entry.at)) continue;
    const ticket = byTicket.get(entry.ticketId), person = employeeMap.get(entry.userId);
    if (person && !(ticket && ticket.anonymous && ticket.authorId === entry.userId) && Number.isFinite(entry.amount) && entry.amount > 0) person.coinsEarned += entry.amount;
    if (!ticket) continue;
    if (entry.kind === 'optionVoted') {
      const key = entry.userId + ':' + ticket.id;
      if (!voteKeys.has(key)) { voteKeys.add(key); add(entry.userId, 'votes', ticket, { at: entry.at }); }
    }
    if (entry.kind === 'step' && entry.stepId && !stepKeys.has(entry.stepId)) {
      stepKeys.add(entry.stepId); add(entry.userId, 'steps', ticket, { stepId: entry.stepId, at: entry.at });
    }
  }
  const events = list(state.events).filter(e => byTicket.has(e.ticketId));
  const solvedIds = new Set(), resultIds = new Set();
  for (const event of events) {
    if (!during(event.at) || event.kind !== 'status') continue;
    const ticket = byTicket.get(event.ticketId);
    if (event.to === 'done') { resultIds.add(ticket.id); add(event.userId, 'submittedResults', ticket, { at: event.at }); }
    if (event.from === 'done' && event.to === 'closed') solvedIds.add(ticket.id);
  }
  for (const ticket of tickets) {
    if (ticket.verify && ticket.verify.result === 'confirmed' && during(ticket.verify.at)) solvedIds.add(ticket.id);
  }
  const ref = ticket => ({ id: ticket.id, title: clean(ticket.title, 160), status: ticket.status,
    assigneeId: ticket.assigneeId || null, assigneeName: clean((users.find(u => u.id === ticket.assigneeId) || {}).name, 100),
    resolveDue: ticket.resolveDue || null, result: clean(ticket.result, 1500), effect: clean(ticket.verify && ticket.verify.after, 500) });
  const solved = tickets.filter(t => solvedIds.has(t.id)).map(ref).sort(order);
  const pending = tickets.filter(t => OPEN.has(t.status) || t.status === 'done').map(ref).sort(order);
  const overdue = pending.filter(t => OPEN.has(t.status) && Number.isFinite(stamp(t.resolveDue)) && stamp(t.resolveDue) < stamp(period.snapshotAt));
  for (const ticket of tickets) {
    if (solvedIds.has(ticket.id)) add(ticket.assigneeId, 'assignedSolved', ticket);
    if (OPEN.has(ticket.status) || ticket.status === 'done') add(ticket.assigneeId, 'currentAssigned', ticket);
    if (overdue.some(t => t.id === ticket.id)) add(ticket.assigneeId, 'overdue', ticket);
  }
  const employees = [...employeeMap.values()].sort(order);
  for (const person of employees) {
    const actions = person.proposals.length + person.votes.length + person.steps.length + person.submittedResults.length;
    person.assessment = actions ? 'За день зафиксировано: предложений — ' + person.proposals.length + ', голосов — ' + person.votes.length + ', выполненных шагов — ' + person.steps.length + ', результатов передано на проверку — ' + person.submittedResults.length + '.' : 'За этот день в системе нет зафиксированных предложений, голосов, выполненных шагов или переданных результатов. Данных для вывода о работе вне системы недостаточно.';
    if (person.absent) person.assessment += ' В профиле отмечено отсутствие.';
    if (person.overdue.length) person.assessment += ' На момент отчёта есть ' + person.overdue.length + ' просроченных назначенных проблем: ' + person.overdue.map(t => t.ticketId).join(', ') + '. Нужно уточнить причины и необходимую помощь.';
  }
  const report = { id: 'daily-' + period.day, kind: 'owner-daily', version: 1, at: period.snapshotAt, day: period.day, period,
    source: 'facts', model: '', aiStatus: 'not_requested', aiText: '',
    summary: { solved: solved.length, resultsSubmitted: resultIds.size, proposals: proposalCount, votes: voteKeys.size,
      steps: stepKeys.size, pending: pending.length, overdue: overdue.length, employees: employees.length },
    solved, pending, overdue, employees,
    limitations: [
      'Учтены только действия, зафиксированные в приложении. Отсутствие активности здесь не означает, что сотрудник не работал.',
      'Голоса и шаги считаются по первому начислению монет; старые голоса без даты не включены в дневную статистику.',
      'Назначенные проблемы, ответственные и просрочки показаны на момент формирования; это не исторический снимок на конец дня.',
      'Анонимные действия не раскрываются через персональную статистику. Подтверждение результата относится к команде; один ответственный не обязательно выполнил всю работу.'
    ] };
  report.text = formatOwnerReportText(report);
  return report;
}

function formatOwnerReportText(report) {
  const s = report.summary;
  const lines = ['МОДУС · СИГНАЛ', 'Отчёт собственнику за ' + report.day, 'Сформирован: ' + localTime(report.at) + ' (Ташкент, UTC+5)',
    '', 'Итоги дня', 'Подтверждено решений: ' + s.solved + '. Передано на проверку: ' + s.resultsSubmitted + '.',
    'Предложений: ' + s.proposals + '. Голосов: ' + s.votes + '. Выполнено шагов: ' + s.steps + '.',
    'Сейчас открыто и на проверке: ' + s.pending + '. Просрочено: ' + s.overdue + '.', '', 'Решённые вопросы'];
  if (!report.solved.length) lines.push('За этот день подтверждённых решений нет.');
  for (const item of report.solved) {
    lines.push(item.id + ' — ' + item.title, 'Результат: ' + (item.result || 'Не указан') + (item.effect ? '\nЭффект: ' + item.effect : ''));
    if (OPEN.has(item.status)) lines.push('После подтверждения вопрос вновь открыт. Текущий результат требует повторной проверки.');
  }
  lines.push('', 'Требуют внимания');
  if (!report.overdue.length) lines.push('На момент формирования просрочек нет.');
  for (const item of report.overdue) lines.push(item.id + ' — ' + item.title + '. Ответственный: ' + (item.assigneeName || 'Не назначен') + '. Срок: ' + localTime(item.resolveDue));
  lines.push('', 'Участие сотрудников');
  for (const person of report.employees) {
    lines.push(person.name + (person.jobTitle ? ' · ' + person.jobTitle : ''), person.assessment);
    lines.push('Выбрано предложений: ' + person.chosen.length + '. Подтверждено назначенных проблем: ' + person.assignedSolved.length + '. Начислено монет: ' + person.coinsEarned + '.');
    const evidence = [...new Set(['proposals', 'votes', 'chosen', 'steps', 'submittedResults', 'assignedSolved'].flatMap(key => person[key].map(t => t.ticketId)))];
    if (evidence.length) lines.push('Карточки: ' + evidence.join(', '));
  }
  lines.push('', 'Комментарий ИИ');
  lines.push(report.aiStatus === 'ready' && report.aiText ? clean(report.aiText, 20000) : 'Отчёт по фактам. Анализ ИИ пока не добавлен.');
  lines.push('', 'Как читать отчёт', ...report.limitations);
  return lines.join('\n');
}

async function renderOwnerReportPdf(report, { fontBytes } = {}) {
  if (!report || report.kind !== 'owner-daily' || !report.summary || !Array.isArray(report.employees)) throw new Error('Некорректный отчёт');
  if (!(fontBytes instanceof Uint8Array) && !(fontBytes instanceof ArrayBuffer)) throw new Error('Для PDF нужен шрифт с кириллицей');
  const { PDFDocument, rgb } = require('pdf-lib');
  const fontkitModule = require('@pdf-lib/fontkit');
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkitModule.default || fontkitModule);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const supported = new Set(font.getCharacterSet());
  const safe = text => Array.from(text).map(char => supported.has(char.codePointAt(0)) ? char : '?').join('');
  const navy = rgb(0.035, 0.16, 0.24), grey = rgb(0.32, 0.38, 0.44);
  const width = 595.28, height = 841.89, margin = 44, maxWidth = width - 2 * margin;
  let page, y;
  function newPage() { page = doc.addPage([width, height]); y = height - margin; }
  function line(text, size, color) {
    if (!page || y < margin + 30) newPage();
    page.drawText(text, { x: margin, y, size, font, color }); y -= size * 1.5;
  }
  function wrap(text, size) {
    let current = '';
    for (const char of Array.from(safe(text))) {
      if (font.widthOfTextAtSize(current + char, size) > maxWidth && current) {
        const split = current.lastIndexOf(' ');
        if (split > current.length * 0.5) { line(current.slice(0, split), size, navy); current = current.slice(split + 1) + char; }
        else { line(current, size, navy); current = char; }
      } else current += char;
    }
    if (current) line(current, size, navy);
  }
  const headings = new Set(['Итоги дня', 'Решённые вопросы', 'Требуют внимания', 'Участие сотрудников', 'Комментарий ИИ', 'Как читать отчёт']);
  for (const paragraph of formatOwnerReportText(report).split('\n')) {
    if (!paragraph) { if (page) y -= 7; continue; }
    wrap(paragraph, paragraph === 'МОДУС · СИГНАЛ' ? 18 : headings.has(paragraph) ? 13 : 10);
  }
  for (const [index, current] of doc.getPages().entries()) current.drawText('МОДУС · СИГНАЛ | ' + report.day + ' | ' + (index + 1) + ' / ' + doc.getPageCount(), { x: margin, y: 25, size: 8, font, color: grey });
  doc.setTitle('МОДУС · СИГНАЛ — отчёт за ' + report.day); doc.setAuthor('МОДУС · СИГНАЛ');
  doc.setCreationDate(new Date(report.at)); doc.setModificationDate(new Date(report.at));
  return doc.save();
}

module.exports = { buildOwnerReport, formatOwnerReportText, renderOwnerReportPdf, periodFor };
