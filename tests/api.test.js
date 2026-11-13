'use strict';
/**
 * Интеграционные тесты API МОДУС · СИГНАЛ (node:test, без внешних зависимостей).
 * Сценарии хакатона (a)–(f) + права, анонимность, Telegram initData, CSV, хранение,
 * интеграция Битрикс24 и Telegram-бот на локальных заглушках.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { start } = require('../server/index.js');
const { signInitData, validateInitData } = require('../server/auth.js');

const BOT_TOKEN = '123456:TEST-fake-token';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'modus-test-')); }

async function boot(over = {}) {
  if (over.triage === undefined) over = Object.assign({ triage: false }, over); // прежние сценарии — без фильтра собственника
  const dir = over.dataDir || tmpDir();
  const app = start(Object.assign({ port: 0, host: '127.0.0.1', dataDir: dir, demo: true, quiet: true, botToken: BOT_TOKEN, botPolling: false, b24Webhook: '', llm: { configured: false }, dailyCheckMs: 3600000 }, over));
  const port = await app.ready;
  const base = `http://127.0.0.1:${port}`;
  async function api(method, url, { user, body, headers } = {}) {
    const h = Object.assign({}, headers || {});
    if (user) h['X-Demo-User'] = user;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* не JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  }
  return { app, base, api, dir };
}

function tma(user, extra = {}) {
  return 'tma ' + signInitData(Object.assign({ auth_date: Math.floor(Date.now() / 1000), query_id: 'AAH-test', user }, extra), BOT_TOKEN);
}

/** Простая HTTP-заглушка: записывает запросы, отвечает handler(path, body). */
function fakeServer(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(d || '{}'); } catch (_) { /* ignore */ }
      calls.push({ path: req.url, body });
      const out = await handler(req.url, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

describe('МОДУС · СИГНАЛ API', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(async () => { await ctx.app.close(); });

  it('health без авторизации и 401 без заголовков', async () => {
    const h = await ctx.api('GET', '/api/health');
    assert.equal(h.status, 200);
    assert.deepEqual(h.json, { ok: true, mode: 'server', demo: true, version: '5.0.0', bot: false, llm: { configured: false, provider: null, model: null }, assistant: { configured: false, provider: 'deepseek', model: 'deepseek-flash' } });
    const r = await ctx.api('GET', '/api/tickets');
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'unauthorized');
    const u = await ctx.api('GET', '/api/tickets', { user: 'nobody' });
    assert.equal(u.status, 401);
  });

  it('статика: /core.js как JavaScript, обход каталогов запрещён', async () => {
    const r = await fetch(ctx.base + '/core.js');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
    await r.text();
    for (const p of ['/../server/db.js', '/%2e%2e/server/db.js', '/..%2fserver%2fdb.js']) {
      const x = await new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: new URL(ctx.base).port, path: p }, (res) => { res.resume(); resolve(res.statusCode); });
      });
      assert.notEqual(x, 200, p);
    }
  });

  it('bootstrap возвращает пользователя и справочники', async () => {
    const r = await ctx.api('GET', '/api/bootstrap', { user: 'u1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.me.id, 'u1');
    assert.ok(r.json.categories.length >= 18);
    assert.ok(r.json.dict.STATUSES.new);
  });

  let createdId;
  it('(a) создание обращения: тип, категория, описание, вложения', async () => {
    const up = await fetch(ctx.base + '/api/files', { method: 'POST', headers: { 'X-Demo-User': 'u1', 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('заявка.pdf') }, body: Buffer.alloc(20480, 1) });
    assert.equal(up.status, 201);
    const pdf = await up.json();
    const r = await ctx.api('POST', '/api/tickets', {
      user: 'u1',
      body: {
        type: 'problem', categoryId: 'c01', text: 'В заявках на кабель не указана длина трассы и тип изоляции.',
        solution: 'Сделать поле длины обязательным', priority: 'high',
        attachments: [pdf, { id: 'x1', name: 'фото.jpg', size: 102400, type: 'image/jpeg', url: 'https://evil.example/x.jpg' }]
      }
    });
    assert.equal(r.status, 201);
    const t = r.json;
    createdId = t.id;
    assert.match(t.id, /^A-\d{3}$/);
    assert.equal(t.type, 'problem');
    assert.equal(t.categoryId, 'c01');
    assert.equal(t.status, 'new');
    assert.equal(t.source, 'web');
    assert.equal(t.priority, 'high');
    assert.deepEqual(t.attachments, [
      { id: pdf.id, name: 'заявка.pdf', size: 20480, type: 'application/pdf', kind: 'doc', url: '/api/files/' + pdf.id },
      { id: 'x1', name: 'фото.jpg', size: 102400, type: 'image/jpeg', kind: 'image', url: '' } // чужой URL отброшен
    ]);
    assert.equal(t.assigneeId, 'm1');
    assert.ok(t.respondDue && t.resolveDue);
    assert.ok(t.events.some((e) => e.kind === 'created'));
    // валидация
    const bad = await ctx.api('POST', '/api/tickets', { user: 'u1', body: { type: 'idea', categoryId: 'c01', text: 'коротко' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'validation');
    const noSol = await ctx.api('POST', '/api/tickets', { user: 'u1', body: { type: 'idea', categoryId: 'c01', text: 'Достаточно длинное описание идеи для проверки' } });
    assert.equal(noSol.status, 400);
    assert.match(noSol.json.error, /решени/);
  });

  it('(b) маршрутизация к владельцу категории и замещение при отсутствии', async () => {
    const own = await ctx.api('POST', '/api/tickets', { user: 'u3', body: { type: 'problem', categoryId: 'c07', text: 'Синхронизация остатков между системами работает с задержкой.' } });
    assert.equal(own.json.assigneeId, 'm7');
    const r = await ctx.api('POST', '/api/tickets', { user: 'u2', body: { type: 'problem', categoryId: 'c03', text: 'Дубли карточек позиций в каталоге оборудования мешают подбору.' } });
    assert.equal(r.status, 201);
    assert.equal(r.json.assigneeId, 'm1', 'владелец c03 (m3) в отпуске → замещающий m1');
    const ev = r.json.events.find((e) => e.kind === 'assigned');
    assert.match(ev.text, /замещение/);
    // если отсутствует и замещающий — администратор
    const abs = await ctx.api('PUT', '/api/admin/users/m1', { user: 'a1', body: { absent: true, absentNote: 'Командировка' } });
    assert.equal(abs.status, 200);
    const r2 = await ctx.api('POST', '/api/tickets', { user: 'u2', body: { type: 'problem', categoryId: 'c03', text: 'Ещё одна проблема с дублями карточек в каталоге.' } });
    assert.equal(r2.json.assigneeId, 'a1');
    await ctx.api('PUT', '/api/admin/users/m1', { user: 'a1', body: { absent: false } });
  });

  it('права: сотрудник не может менять статус (403)', async () => {
    const r = await ctx.api('POST', `/api/tickets/${createdId}/transition`, { user: 'u1', body: { to: 'review' } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'forbidden');
    const other = await ctx.api('POST', `/api/tickets/${createdId}/transition`, { user: 'm7', body: { to: 'review' } });
    assert.equal(other.status, 403, 'руководитель чужой категории тоже не может');
  });

  it('(c) смена статуса, запрос уточнения, ответ автора возвращает на рассмотрение, история сохраняется', async () => {
    let r = await ctx.api('POST', `/api/tickets/${createdId}/transition`, { user: 'm1', body: { to: 'review', comment: 'Берём в разбор' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'review');
    assert.ok(r.json.firstResponseAt);
    r = await ctx.api('POST', `/api/tickets/${createdId}/comments`, { user: 'm1', body: { text: 'Приложите пример заявки, пожалуйста', clarify: true } });
    assert.equal(r.json.status, 'clarify');
    r = await ctx.api('POST', `/api/tickets/${createdId}/comments`, { user: 'm1', body: { text: 'Внутренняя заметка для коллег', internal: true } });
    assert.equal(r.status, 200);
    r = await ctx.api('POST', `/api/tickets/${createdId}/comments`, { user: 'u1', body: { text: 'Пример приложил, это заявка №45' } });
    assert.equal(r.json.status, 'review');
    const h = await ctx.api('GET', `/api/tickets/${createdId}`, { user: 'u1' });
    const kinds = h.json.events.map((e) => e.kind + (e.to ? ':' + e.to : ''));
    assert.deepEqual(kinds.filter((k) => k.startsWith('status')), ['status:review', 'status:clarify', 'status:review']);
    assert.ok(kinds.includes('comment'));
    assert.ok(!h.json.events.some((e) => e.internal), 'автор не видит внутренние заметки');
    const hm = await ctx.api('GET', `/api/tickets/${createdId}`, { user: 'm1' });
    assert.ok(hm.json.events.some((e) => e.internal), 'ответственный видит внутренние заметки');
    // недопустимый переход
    const bad = await ctx.api('POST', `/api/tickets/${createdId}/transition`, { user: 'm1', body: { to: 'new' } });
    assert.equal(bad.status, 400);
  });

  it('(d) автор видит результат, включая мотивированный отказ; отказ без причины → 400', async () => {
    const noReason = await ctx.api('POST', `/api/tickets/${createdId}/transition`, { user: 'm1', body: { to: 'rejected' } });
    assert.equal(noReason.status, 400);
    assert.match(noReason.json.error, /мотивирован/);
    const rej = await ctx.api('POST', `/api/tickets/${createdId}/transition`, { user: 'm1', body: { to: 'rejected', rejectReason: 'Шаблон заявки меняется централизованно в Q3' } });
    assert.equal(rej.status, 200);
    const seen = await ctx.api('GET', `/api/tickets/${createdId}`, { user: 'u1' });
    assert.equal(seen.json.status, 'rejected');
    assert.equal(seen.json.rejectReason, 'Шаблон заявки меняется централизованно в Q3');
    const notes = await ctx.api('GET', '/api/notifications', { user: 'u1' });
    assert.ok(notes.json.some((n) => n.ticketId === createdId && /Причина/.test(n.text)));
    // реализация с эффектом «Было → Стало»
    let r = await ctx.api('POST', '/api/tickets/A-003/transition', { user: 'm1', body: { to: 'done', result: 'Введено правило проверки номенклатуры', impact: { metric: 'Время проверки, мин', before: '40', after: '15' } } });
    assert.equal(r.status, 200);
    r = await ctx.api('GET', '/api/tickets/A-003', { user: 'u2' });
    assert.equal(r.json.status, 'done');
    assert.equal(r.json.result, 'Введено правило проверки номенклатуры');
    assert.equal(r.json.impact.after, '15');
    const prof = await ctx.api('GET', '/api/profile', { user: 'u2' });
    assert.ok(prof.json.ledger.some((l) => l.kind === 'implemented'));
  });

  it('(e) фильтры по подразделению, категории, статусу и просрочке', async () => {
    const od = await ctx.api('GET', '/api/tickets?overdue=1', { user: 'm2' });
    const ids = od.json.map((t) => t.id);
    assert.ok(ids.includes('A-007') && ids.includes('A-011'), ids.join(','));
    assert.equal(od.json.find((t) => t.id === 'A-007').overdue.kind, 'response');
    assert.equal(od.json.find((t) => t.id === 'A-011').overdue.kind, 'response');
    const f = await ctx.api('GET', '/api/tickets?dept=' + encodeURIComponent('Бухгалтерия') + '&categoryId=c07&status=new&overdue=1', { user: 'm7' });
    assert.deepEqual(f.json.map((t) => t.id), ['A-007']);
    const st = await ctx.api('GET', '/api/tickets?status=clarify', { user: 'm2' });
    assert.ok(st.json.every((t) => t.status === 'clarify') && st.json.length >= 2);
    const q = await ctx.api('GET', '/api/tickets?q=' + encodeURIComponent('приложения к договору'), { user: 'm2' });
    assert.deepEqual(q.json.map((t) => t.id), ['A-009']);
    const mine = await ctx.api('GET', '/api/tickets?scope=mine', { user: 'u4' });
    assert.ok(mine.json.length >= 4 && mine.json.every((t) => t.mine));
    // эскалация при старте выполнена планировщиком
    const a7 = await ctx.api('GET', '/api/tickets/A-007', { user: 'm7' });
    assert.ok(a7.json.escalated);
    assert.ok(a7.json.events.some((e) => e.kind === 'escalated'));
  });

  it('(f) аналитика: byType, closedShare, avgFirstResponseH; сотруднику — 403', async () => {
    const r = await ctx.api('GET', '/api/analytics', { user: 'm2' });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.byType).sort(), ['idea', 'praise', 'problem']);
    assert.equal(typeof r.json.closedShare, 'number');
    assert.ok(r.json.closedShare > 0);
    assert.equal(typeof r.json.avgFirstResponseH, 'number');
    assert.ok(Array.isArray(r.json.overdue));
    const e = await ctx.api('GET', '/api/analytics', { user: 'u1' });
    assert.equal(e.status, 403);
  });

  let anonId;
  it('анонимное обращение скрывает автора от ответственного', async () => {
    const r = await ctx.api('POST', '/api/tickets', { user: 'u2', body: { type: 'problem', categoryId: 'c07', text: 'Пароли к общим учёткам передаются в мессенджере.', anonymous: true } });
    assert.equal(r.status, 201);
    anonId = r.json.id;
    assert.equal(r.json.authorId, 'u2', 'автор видит себя');
    const m = await ctx.api('GET', `/api/tickets/${anonId}`, { user: 'm7' });
    assert.equal(m.json.authorId, null);
    assert.equal(m.json.authorName, 'Анонимно');
    assert.equal(m.json.authorDept, '—');
    assert.ok(m.json.events.every((e) => e.userId !== 'u2'));
    assert.ok(!JSON.stringify(m.json).includes('"u2"'));
    const list = await ctx.api('GET', '/api/tickets?categoryId=c07', { user: 'm7' });
    assert.equal(list.json.find((t) => t.id === anonId).authorId, null);
  });

  it('CSV-выгрузка: BOM, разделитель «;», анонимность сохраняется; сотруднику — 403', async () => {
    const r = await fetch(ctx.base + '/api/export.csv', { headers: { 'X-Demo-User': 'm2' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = buf.toString('utf8').slice(1);
    const lines = text.trim().split('\r\n');
    assert.equal(lines[0], 'Номер;Тип;Категория;Автор;Подразделение;Приоритет;Статус;Ответственный;Создано;Первый ответ;Закрыто;Просрочено;Результат/причина отказа;Поддержали');
    const anonLine = lines.find((l) => l.startsWith(anonId + ';'));
    assert.match(anonLine, /;Анонимно;—;/);
    const e = await ctx.api('GET', '/api/export.csv', { user: 'u1' });
    assert.equal(e.status, 403);
  });

  it('голосование, похожие обращения, лидерборд, уведомления, награды', async () => {
    let r = await ctx.api('POST', '/api/tickets/A-001/vote', { user: 'u8' });
    assert.equal(r.json.voted, true);
    r = await ctx.api('POST', '/api/tickets/A-001/vote', { user: 'u1' });
    assert.equal(r.status, 400, 'нельзя голосовать за своё');
    r = await ctx.api('GET', '/api/similar?text=' + encodeURIComponent('Повторный ввод сведений в разных рабочих системах'), { user: 'u1' });
    assert.ok(r.json.some((s) => s.id === 'A-007'));
    r = await ctx.api('GET', '/api/leaderboard', { user: 'u1' });
    assert.ok(Array.isArray(r.json) && r.json.length > 0);
    r = await ctx.api('GET', '/api/notifications', { user: 'u1' });
    assert.ok(r.json.some((n) => !n.read));
    r = await ctx.api('POST', '/api/notifications/read', { user: 'u1', body: {} });
    assert.equal(r.json.unread, 0);
    r = await ctx.api('POST', '/api/rewards/dayoff/redeem', { user: 'u1' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Недостаточно (баллов|монет)/);
    r = await ctx.api('GET', '/api/profile/u3', { user: 'u1' });
    assert.equal(r.json.user.id, 'u3');
  });

  it('администрирование: категории, настройки, права', async () => {
    let r = await ctx.api('POST', '/api/admin/categories', { user: 'a1', body: { name: 'Склад и логистика', owner: 'm1', backup: 'm2' } });
    assert.equal(r.status, 201);
    const catId = r.json.id;
    r = await ctx.api('PUT', `/api/admin/categories/${catId}`, { user: 'a1', body: { owner: 'm10' } });
    assert.equal(r.json.owner, 'm10');
    r = await ctx.api('PUT', `/api/admin/categories/${catId}`, { user: 'm1', body: { owner: 'm1' } });
    assert.equal(r.status, 403);
    r = await ctx.api('PUT', '/api/admin/settings', { user: 'a1', body: { anonymousAllowed: false } });
    assert.equal(r.json.anonymousAllowed, false);
    r = await ctx.api('POST', '/api/tickets', { user: 'u1', body: { type: 'problem', categoryId: 'c01', text: 'Анонимная подача при выключенной настройке', anonymous: true } });
    assert.equal(r.status, 400);
    await ctx.api('PUT', '/api/admin/settings', { user: 'a1', body: { anonymousAllowed: true } });
    r = await ctx.api('PUT', '/api/admin/users/u1', { user: 'u1', body: { tgId: '999', role: 'admin' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.tgId, undefined, 'сотрудник не может сам назначить Telegram ID');
    assert.equal(r.json.role, 'employee');
    r = await ctx.api('POST', '/api/admin/reset', { user: 'm1' });
    assert.equal(r.status, 403);
  });

  it('ошибки: 404 для обращения и метода, некорректный JSON, лимит тела 1 МБ', async () => {
    let r = await ctx.api('GET', '/api/tickets/A-999', { user: 'u1' });
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'not_found');
    r = await ctx.api('GET', '/api/nope', { user: 'u1' });
    assert.equal(r.status, 404);
    r = await fetch(ctx.base + '/api/tickets', { method: 'POST', headers: { 'X-Demo-User': 'u1', 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(r.status, 400);
    r = await fetch(ctx.base + '/api/tickets', { method: 'POST', headers: { 'X-Demo-User': 'u1', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 10) }) }).catch((e) => ({ status: 'reset' }));
    assert.ok(r.status === 413 || r.status === 'reset');
    r = await fetch(ctx.base + '/api/tickets', { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.match(r.headers.get('access-control-allow-headers'), /X-Demo-User/);
  });

  describe('Telegram Mini App initData', () => {
    it('валидация: корректная подпись принимается, изменённая и устаревшая — отклоняются', () => {
      const user = { id: 424242, first_name: 'Тест', username: 'tester' };
      const signed = signInitData({ auth_date: Math.floor(Date.now() / 1000), query_id: 'Q1', user }, BOT_TOKEN);
      const ok = validateInitData(signed, BOT_TOKEN);
      assert.equal(ok.user.id, 424242);
      const tampered = signed.replace('424242', '424243');
      assert.throws(() => validateInitData(tampered, BOT_TOKEN), (e) => e.status === 401 && e.code === 'bad_init_data');
      assert.throws(() => validateInitData(signed, 'other:token'), (e) => e.code === 'bad_init_data');
      const old = signInitData({ auth_date: Math.floor(Date.now() / 1000) - 25 * 3600, user }, BOT_TOKEN);
      assert.throws(() => validateInitData(old, BOT_TOKEN), (e) => e.code === 'init_data_expired');
      const noHash = signed.replace(/&?hash=[0-9a-f]+/, '');
      assert.throws(() => validateInitData(noHash, BOT_TOKEN), (e) => e.status === 401);
    });

    it('HTTP: link_required → привязка → вход по initData, подмена → 401', async () => {
      const tgUser = { id: 777001, first_name: 'Мини', language_code: 'ru' };
      let r = await ctx.api('GET', '/api/bootstrap', { headers: { Authorization: tma(tgUser) } });
      assert.equal(r.status, 401);
      assert.equal(r.json.code, 'link_required');
      r = await ctx.api('POST', '/api/tg/link', { headers: { Authorization: tma(tgUser) }, body: { userId: 'u4' } });
      assert.equal(r.status, 200);
      assert.equal(r.json.me.id, 'u4');
      r = await ctx.api('GET', '/api/bootstrap', { headers: { Authorization: tma(tgUser) } });
      assert.equal(r.status, 200);
      assert.equal(r.json.me.id, 'u4');
      assert.equal(r.json.auth, 'tma');
      r = await ctx.api('POST', '/api/tickets', { headers: { Authorization: tma(tgUser) }, body: { type: 'praise', categoryId: 'c16', text: 'Спасибо коллегам из сервиса за быстрый выезд!' } });
      assert.equal(r.status, 201);
      assert.equal(r.json.source, 'tma');
      const tampered = tma(tgUser).replace('777001', '777002');
      r = await ctx.api('GET', '/api/bootstrap', { headers: { Authorization: tampered } });
      assert.equal(r.status, 401);
      assert.equal(r.json.code, 'bad_init_data');
      r = await ctx.api('POST', '/api/tg/link', { headers: { Authorization: tampered }, body: { userId: 'a1' } });
      assert.equal(r.status, 401);
    });
  });
});

describe('Хранение в SQLite', () => {
  it('данные переживают перезапуск, счётчики продолжаются; reset пересоздаёт демо', async () => {
    const dir = tmpDir();
    let ctx = await boot({ dataDir: dir });
    const r = await ctx.api('POST', '/api/tickets', { user: 'u5', body: { type: 'problem', categoryId: 'c13', text: 'Проверка сохранения обращения после перезапуска.' } });
    const id = r.json.id;
    await ctx.app.close();
    assert.ok(fs.existsSync(path.join(dir, 'modus.db')));
    ctx = await boot({ dataDir: dir });
    const g = await ctx.api('GET', `/api/tickets/${id}`, { user: 'u5' });
    assert.equal(g.status, 200);
    assert.equal(g.json.text, 'Проверка сохранения обращения после перезапуска.');
    const n = await ctx.api('POST', '/api/tickets', { user: 'u5', body: { type: 'problem', categoryId: 'c13', text: 'Второе обращение — номер должен идти следующим.' } });
    assert.equal(Number(n.json.id.slice(2)), Number(id.slice(2)) + 1);
    // порядок событий сохраняется
    assert.deepEqual(g.json.events.map((e) => e.kind).slice(0, 2), ['created', 'assigned']);
    const rs = await ctx.api('POST', '/api/admin/reset', { user: 'a1' });
    assert.equal(rs.status, 200);
    assert.equal(rs.json.tickets, 20);
    await ctx.app.close();
  });
});

describe('Интеграция Битрикс24 (заглушка)', () => {
  it('«В работе» → tasks.task.add, «Реализовано» → task.commentitem.add', async () => {
    const fake = await fakeServer((p) => (p.includes('tasks.task.add') ? { result: { task: { id: 5150 } } } : { result: 77 }));
    const ctx = await boot({ b24Webhook: fake.url + '/rest/1/secret/', b24UserMap: JSON.stringify({ m1: 12, default: 1 }) });
    try {
      let r = await ctx.api('POST', '/api/tickets/A-001/transition', { user: 'm1', body: { to: 'work', comment: 'Берём' } });
      assert.equal(r.status, 200);
      await ctx.app.b24.pending();
      const add = fake.calls.find((c) => c.path.endsWith('tasks.task.add.json'));
      assert.ok(add, 'создана задача');
      assert.match(add.body.fields.TITLE, /^\[Сигнал\] A-001 /);
      assert.equal(add.body.fields.RESPONSIBLE_ID, 12);
      assert.equal(ctx.app.store.state.tickets.find((t) => t.id === 'A-001').b24TaskId, '5150');
      r = await ctx.api('POST', '/api/tickets/A-001/transition', { user: 'm1', body: { to: 'done', result: 'Шаблон заявки обновлён' } });
      await ctx.app.b24.pending();
      const cm = fake.calls.find((c) => c.path.endsWith('task.commentitem.add.json'));
      assert.equal(cm.body.TASKID, '5150');
      assert.match(cm.body.FIELDS.POST_MESSAGE, /Шаблон заявки обновлён/);
    } finally {
      await ctx.app.close();
      fake.srv.close();
    }
  });

  it('ошибка Битрикс24 не ломает API', async () => {
    const ctx = await boot({ b24Webhook: 'http://127.0.0.1:1/rest/1/x/' });
    try {
      const r = await ctx.api('POST', '/api/tickets/A-001/transition', { user: 'm1', body: { to: 'work' } });
      assert.equal(r.status, 200);
      await ctx.app.b24.pending();
    } finally { await ctx.app.close(); }
  });
});

describe('Telegram-бот (заглушка Bot API)', () => {
  it('/start с выбором демо-роли, /new по шагам, /my, /inbox и доставка уведомлений', async () => {
    const fake = await fakeServer(async (p) => {
      if (p.endsWith('/getUpdates')) { await new Promise((r) => setTimeout(r, 100)); return { ok: true, result: [] }; }
      return { ok: true, result: p.endsWith('/sendMessage') ? { message_id: 1 } : true };
    });
    const ctx = await boot({ botPolling: true, tgApiBase: fake.url, publicUrl: 'https://signal.example.ru', dispatchMs: 3600000 });
    const bot = ctx.app.bot;
    const sent = () => fake.calls.filter((c) => c.path.endsWith('/sendMessage')).map((c) => c.body);
    const chat = { id: 5001, type: 'private' };
    const from = { id: 5001, first_name: 'Сотрудник' };
    const msg = (text) => ({ update_id: 1, message: { message_id: 1, chat, from, text } });
    const cb = (data) => ({ update_id: 2, callback_query: { id: 'cq', from, data, message: { message_id: 2, chat } } });
    try {
      await new Promise((r) => setTimeout(r, 150));
      const health = await ctx.api('GET', '/api/health');
      assert.equal(health.json.bot, true);
      assert.ok(fake.calls.some((c) => c.path.endsWith('/setChatMenuButton') && c.body.menu_button.web_app.url.startsWith('https://signal.example.ru')));
      assert.ok(fake.calls.some((c) => c.path.endsWith('/setMyCommands')));

      await bot.handleUpdate(msg('/start'));
      let last = sent().at(-1);
      assert.match(last.text, /Ваш голос в улучшениях компании/);
      assert.ok(JSON.stringify(last.reply_markup).includes('link:u1'));

      await bot.handleUpdate(cb('link:u1'));
      assert.equal(ctx.app.store.state.users.find((u) => u.id === 'u1').tgId, '5001');

      await bot.handleUpdate(msg('/new'));
      await bot.handleUpdate(cb('new:type:problem'));
      last = sent().at(-1);
      assert.equal(last.reply_markup.inline_keyboard[0].length, 2, 'категории по 2 в ряд');
      await bot.handleUpdate(cb('new:cat:c03'));
      await bot.handleUpdate(msg('Коротко'));
      assert.match(sent().at(-1).text, /не менее 15/);
      await bot.handleUpdate(msg('В каталоге два артикула одной камеры, путаемся при подборе.'));
      assert.ok(JSON.stringify(sent().at(-1).reply_markup).includes('new:skip'));
      await bot.handleUpdate(cb('new:skip'));
      last = sent().at(-1);
      const id = (last.text.match(/A-\d{3}/) || [])[0];
      assert.ok(id, last.text);
      assert.match(last.text, /Руководитель закупок/);
      assert.match(last.text, /Первый ответ — до/);
      const t = ctx.app.store.state.tickets.find((x) => x.id === id);
      assert.equal(t.source, 'bot');
      assert.equal(t.assigneeId, 'm1');

      await bot.handleUpdate(msg('/my'));
      assert.ok(sent().at(-1).text.includes(id));

      await bot.handleUpdate(msg('/inbox'));
      assert.match(sent().at(-1).text, /доступен ответственным/);

      // Руководитель привязывает Telegram и получает уведомление о новом обращении
      const mChat = { id: 6001, type: 'private' }, mFrom = { id: 6001, first_name: 'Руководитель' };
      await bot.handleUpdate({ update_id: 3, callback_query: { id: 'c2', from: mFrom, data: 'link:m1', message: { message_id: 3, chat: mChat } } });
      const before = sent().length;
      const r = await ctx.api('POST', '/api/tickets', { user: 'u2', body: { type: 'idea', categoryId: 'c01', text: 'Предлагаю общий шаблон заявки для всех отделов.', solution: 'Сделать шаблон в общей папке' } });
      await bot.dispatchOnce();
      const toManager = sent().slice(before).find((m) => m.chat_id === '6001' && m.text.includes(r.json.id));
      assert.ok(toManager, 'уведомление доставлено руководителю');
      assert.equal(toManager.parse_mode, 'HTML');
      assert.equal(toManager.reply_markup.inline_keyboard[0][0].web_app.url, `https://signal.example.ru/#/t/${r.json.id}`);
      assert.ok(ctx.app.store.state.notifications.every((n) => n.delivered), 'все уведомления помечены доставленными');

      await bot.handleUpdate({ update_id: 4, message: { message_id: 4, chat: mChat, from: mFrom, text: '/inbox' } });
      const inbox = sent().at(-1).text;
      assert.match(inbox, /Входящие/);
      assert.ok(inbox.includes(r.json.id), 'новое обращение во входящих руководителя');
    } finally {
      await ctx.app.close();
      fake.srv.close();
    }
  });
});
