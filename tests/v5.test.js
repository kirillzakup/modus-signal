'use strict';
/**
 * МОДУС · СИГНАЛ 5.0: вход по ссылке и QR-коду, фильтр собственника, корзина, доска.
 * Сервер запускается с включённым фильтром собственника (режим по умолчанию).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { start } = require('../server/index.js');
const core = require('../public/core.js');
const { schedule, completeTeam } = require('./team-fixture');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'modus-v5-')); }

async function boot(over = {}) {
  const app = start(Object.assign({ port: 0, host: '127.0.0.1', dataDir: tmpDir(), demo: true, quiet: true, botToken: '', botPolling: false, b24Webhook: '', llm: { configured: false }, dailyCheckMs: 3600000, publicPerHour: 50 }, over));
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
    return { status: r.status, json, text };
  }
  return { app, base, api };
}

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

const TEXT = 'На объекте не открывается турникет после обновления прошивки, охрана пропускает людей вручную.';

describe('Вход по ссылке и QR-коду', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(async () => { await ctx.app.close(); });

  it('форма доступна без входа: точка входа, обращение, страница статуса', async () => {
    const e = await ctx.api('GET', '/api/public/entry/object-demo');
    assert.equal(e.status, 200);
    assert.equal(e.json.active, true);
    assert.match(e.json.name, /Объект/);

    const r = await ctx.api('POST', '/api/public/tickets', { body: { code: 'object-demo', text: TEXT, contactName: 'Айдар', contactPhone: '+7 700 111-22-33' } });
    assert.equal(r.status, 201);
    assert.match(r.json.id, /^A-\d+$/);
    assert.ok(r.json.trackCode.length >= 20, 'код статуса неугадываемый');

    const s = await ctx.api('GET', '/api/public/track/' + r.json.trackCode);
    assert.equal(s.status, 200);
    assert.equal(s.json.state, 'wait');
    assert.equal(s.json.id, r.json.id);
    assert.equal(s.json.contact, undefined, 'страница статуса не раскрывает контакт');
    assert.equal(s.json.assigneeName, undefined, 'и не раскрывает сотрудников');
    ctx.ticket = r.json;
  });

  it('неизвестная ссылка — 404, короткий текст — 400, чужой код статуса — 404', async () => {
    assert.equal((await ctx.api('GET', '/api/public/entry/nope')).status, 404);
    assert.equal((await ctx.api('POST', '/api/public/tickets', { body: { code: 'nope', text: TEXT } })).status, 404);
    assert.equal((await ctx.api('POST', '/api/public/tickets', { body: { code: 'site', text: 'коротко' } })).status, 400);
    assert.equal((await ctx.api('POST', '/api/public/tickets', { body: { code: 'site', text: TEXT, contactPhone: 'позвоните мне <script>' } })).status, 400);
    assert.equal((await ctx.api('GET', '/api/public/track/aaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);
    assert.equal((await ctx.api('GET', '/api/public/track/x')).status, 404);
  });

  it('поле-ловушка: бот получает «успех», обращение не создаётся', async () => {
    const before = (await ctx.api('GET', '/api/tickets?box=inbox', { user: 'o1' })).json.length;
    const r = await ctx.api('POST', '/api/public/tickets', { body: { code: 'site', text: TEXT, website: 'http://spam.example' } });
    assert.equal(r.status, 201);
    assert.equal((await ctx.api('GET', '/api/tickets?box=inbox', { user: 'o1' })).json.length, before);
  });

  it('публичные адреса не требуют входа, остальные — требуют', async () => {
    assert.equal((await ctx.api('GET', '/api/tickets')).status, 401);
    assert.equal((await ctx.api('GET', '/api/admin/entries')).status, 401);
    assert.equal((await ctx.api('POST', '/api/tickets/A-001/accept', { body: {} })).status, 401);
  });

  it('точки входа: создаёт администратор, отключённая ссылка не принимает обращения', async () => {
    assert.equal((await ctx.api('GET', '/api/admin/entries', { user: 'u1' })).status, 403);
    assert.equal((await ctx.api('POST', '/api/admin/entries', { user: 'm1', body: { name: 'Объект: склад' } })).status, 403);
    const c = await ctx.api('POST', '/api/admin/entries', { user: 'a1', body: { name: 'Объект: ТРЦ «Меридиан»', kind: 'object' } });
    assert.equal(c.status, 201);
    assert.equal(c.json.code.length, 10);
    assert.equal(c.json.kindLabel, 'Объект');
    const ok = await ctx.api('POST', '/api/public/tickets', { body: { code: c.json.code, text: TEXT } });
    assert.equal(ok.status, 201);
    assert.match(ok.json.entryName, /Меридиан/);
    const list = await ctx.api('GET', '/api/admin/entries', { user: 'o1' });
    assert.equal(list.json.find((x) => x.id === c.json.id).total, 1);

    const off = await ctx.api('PUT', '/api/admin/entries/' + c.json.id, { user: 'a1', body: { active: false } });
    assert.equal(off.json.active, false);
    assert.equal((await ctx.api('POST', '/api/public/tickets', { body: { code: c.json.code, text: TEXT } })).status, 403);
    assert.equal((await ctx.api('GET', '/api/public/entry/' + c.json.code)).json.active, false);
  });

  it('ограничение частоты: не больше заданного числа обращений с одного адреса в час', async () => {
    const c2 = await boot({ publicPerHour: 2 });
    try {
      assert.equal((await c2.api('POST', '/api/public/tickets', { body: { code: 'site', text: TEXT } })).status, 201);
      assert.equal((await c2.api('POST', '/api/public/tickets', { body: { code: 'site', text: TEXT } })).status, 201);
      const r = await c2.api('POST', '/api/public/tickets', { body: { code: 'site', text: TEXT } });
      assert.equal(r.status, 429);
      assert.equal(r.json.code, 'too_many');
    } finally { await c2.app.close(); }
  });

  it('файл по ссылке: загрузка без входа только с действующим кодом точки входа', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    const bad = await fetch(ctx.base + '/api/public/files?code=nope', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-File-Name': 'a.png' }, body: png });
    assert.equal(bad.status, 404);
    const ok = await fetch(ctx.base + '/api/public/files?code=site', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-File-Name': 'foto.png' }, body: png });
    assert.equal(ok.status, 201);
    const f = await ok.json();
    assert.match(f.url, /^\/api\/files\//);
    const t = await ctx.api('POST', '/api/public/tickets', { body: { code: 'site', text: TEXT, attachments: [f] } });
    assert.equal(t.status, 201);
    const v = await ctx.api('GET', '/api/tickets/' + t.json.id, { user: 'o1' });
    assert.equal(v.json.attachments.length, 1);
  });
});

describe('Фильтр собственника и корзина', () => {
  let ctx, pub;
  before(async () => {
    ctx = await boot();
    pub = (await ctx.api('POST', '/api/public/tickets', { body: { code: 'office', text: TEXT, contactName: 'Айдар', contactPhone: '+7 700 111-22-33' } })).json;
  });
  after(async () => { await ctx.app.close(); });

  it('новое обращение видит только собственник; на доске его нет', async () => {
    const boot1 = await ctx.api('GET', '/api/bootstrap', { user: 'o1' });
    assert.equal(boot1.json.triage, true);
    assert.equal(boot1.json.canTriage, true);
    assert.ok(boot1.json.inboxCount >= 1);
    assert.equal((await ctx.api('GET', '/api/bootstrap', { user: 'm1' })).json.canTriage, false);

    const inbox = await ctx.api('GET', '/api/tickets?box=inbox', { user: 'o1' });
    assert.ok(inbox.json.some((t) => t.id === pub.id));
    const mine = inbox.json.find((t) => t.id === pub.id);
    assert.equal(mine.entryName, 'Офис, вход');
    assert.equal(mine.contact.phone, '+7 700 111-22-33');
    assert.equal(mine.assigneeId, null);

    for (const u of ['u1', 'm1', 'a1']) {
      assert.equal((await ctx.api('GET', '/api/tickets?box=inbox', { user: u })).json.length, 0, u + ' не видит входящие');
      assert.ok(!(await ctx.api('GET', '/api/tickets', { user: u })).json.some((t) => t.id === pub.id));
      assert.ok(!(await ctx.api('GET', '/api/tickets?box=board', { user: u })).json.some((t) => t.id === pub.id));
      assert.equal((await ctx.api('GET', '/api/tickets/' + pub.id, { user: u })).status, 404);
    }
  });

  it('сотрудник подаёт одним полем: обращение ждёт собственника, автор его видит', async () => {
    const r = await ctx.api('POST', '/api/tickets', { user: 'u2', body: { text: 'В переговорной на втором этаже не работает экран для презентаций.' } });
    assert.equal(r.status, 201);
    assert.equal(r.json.status, 'new');
    assert.equal(r.json.pending, true);
    assert.equal(r.json.assigneeId, null);
    assert.equal((await ctx.api('GET', '/api/tickets/' + r.json.id, { user: 'u2' })).status, 200, 'автор видит своё');
    assert.equal((await ctx.api('GET', '/api/tickets/' + r.json.id, { user: 'u3' })).status, 404, 'коллега — нет');
    // до решения собственника карточку нельзя взять в работу или перевести
    assert.equal((await ctx.api('POST', `/api/tickets/${r.json.id}/claim`, { user: 'm1' })).status, 400);
    assert.equal((await ctx.api('POST', `/api/tickets/${r.json.id}/transition`, { user: 'a1', body: { to: 'work' } })).status, 403);
    assert.equal((await ctx.api('POST', `/api/tickets/${r.json.id}/accept`, { user: 'a1', body: {} })).status, 403);
    ctx.internal = r.json.id;
  });

  it('«В корзину»: обращение исчезает, автор видит «Не принято»; из корзины можно вернуть', async () => {
    assert.equal((await ctx.api('POST', `/api/tickets/${pub.id}/trash`, { user: 'm1', body: { reason: 'Спам' } })).status, 403);
    const t = await ctx.api('POST', `/api/tickets/${pub.id}/trash`, { user: 'o1', body: { reason: 'Спам' } });
    assert.equal(t.status, 200);
    assert.equal(t.json.status, 'trash');
    assert.equal(t.json.trashReason, 'Спам');
    assert.ok(!(await ctx.api('GET', '/api/tickets?box=inbox', { user: 'o1' })).json.some((x) => x.id === pub.id));
    assert.ok((await ctx.api('GET', '/api/tickets?box=trash', { user: 'o1' })).json.some((x) => x.id === pub.id));
    assert.ok(!(await ctx.api('GET', '/api/tickets', { user: 'o1' })).json.some((x) => x.id === pub.id), 'в общем списке корзины нет');
    assert.equal((await ctx.api('GET', '/api/tickets?box=trash', { user: 'a1' })).json.length, 0);
    assert.equal((await ctx.api('GET', '/api/public/track/' + pub.trackCode)).json.state, 'declined');

    assert.equal((await ctx.api('POST', `/api/tickets/${pub.id}/restore`, { user: 'a1' })).status, 403);
    const back = await ctx.api('POST', `/api/tickets/${pub.id}/restore`, { user: 'o1' });
    assert.equal(back.json.status, 'new');
    assert.ok((await ctx.api('GET', '/api/tickets?box=inbox', { user: 'o1' })).json.some((x) => x.id === pub.id));
  });

  it('«В работу»: ответственный и срок, карточка в «К выполнению», уведомление, статус для автора', async () => {
    assert.equal((await ctx.api('POST', `/api/tickets/${pub.id}/accept`, { user: 'o1', body: { assigneeId: 'u1' } })).status, 400, 'без сроков обсуждения принять нельзя');
    assert.equal((await ctx.api('POST', `/api/tickets/${pub.id}/accept`, { user: 'o1', body: { assigneeId: 'm7', due: '2001-01-01' } })).status, 400, 'срок в прошлом');
    const due = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const a = await ctx.api('POST', `/api/tickets/${pub.id}/accept`, { user: 'o1', body: { assigneeId: 'm7', categoryId: 'c07', priority: 'high', due, ...schedule() } });
    assert.equal(a.status, 200);
    assert.equal(a.json.status, 'review');
    assert.equal(a.json.board, 'todo');
    assert.equal(a.json.assigneeId, 'm7');
    assert.equal(a.json.priority, 'high');
    assert.equal(a.json.resolveDue.slice(0, 10), due);
    assert.equal(a.json.pending, false);
    assert.equal((await ctx.api('POST', `/api/tickets/${pub.id}/accept`, { user: 'o1', body: {} })).status, 400, 'повторно принять нельзя');

    const n = await ctx.api('GET', '/api/notifications', { user: 'm7' });
    assert.ok(n.json.some((x) => x.ticketId === pub.id && /назначено/i.test(x.text)));
    const seen = await ctx.api('GET', '/api/tickets/' + pub.id, { user: 'u1' });
    assert.equal(seen.status, 200, 'после приёма карточку видят сотрудники');
    assert.equal(seen.json.contact, undefined, 'контакт автора сотрудник не видит');
    assert.equal(seen.json.authorName, 'Внешний автор');
    assert.equal((await ctx.api('GET', '/api/tickets/' + pub.id, { user: 'm7' })).json.contact.name, 'Айдар', 'ответственный контакт видит');
    assert.equal((await ctx.api('GET', '/api/public/track/' + pub.trackCode)).json.state, 'accepted');
  });

  it('заместитель: назначает собственник, заместитель разбирает входящие', async () => {
    assert.equal((await ctx.api('PUT', '/api/admin/settings', { user: 'a1', body: { deputyId: 'm2' } })).status, 403);
    assert.equal((await ctx.api('PUT', '/api/admin/settings', { user: 'o1', body: { deputyId: 'u1' } })).status, 400);
    const s = await ctx.api('PUT', '/api/admin/settings', { user: 'o1', body: { deputyId: 'm2' } });
    assert.equal(s.json.deputyId, 'm2');
    assert.equal((await ctx.api('GET', '/api/bootstrap', { user: 'm2' })).json.canTriage, true);
    assert.ok((await ctx.api('GET', '/api/tickets?box=inbox', { user: 'm2' })).json.some((t) => t.id === ctx.internal));
    const a = await ctx.api('POST', `/api/tickets/${ctx.internal}/accept`, { user: 'm2', body: { assigneeId: 'm7', ...schedule() } });
    assert.equal(a.status, 200);
    assert.equal(a.json.status, 'review');
  });
});

describe('Доска: четыре колонки и правила переходов', () => {
  let ctx, id, track;
  before(async () => {
    ctx = await boot();
    const p = (await ctx.api('POST', '/api/public/tickets', { body: { code: 'object-demo', text: TEXT } })).json;
    id = p.id; track = p.trackCode;
    const accepted = await ctx.api('POST', `/api/tickets/${id}/accept`, { user: 'o1', body: { assigneeId: 'm7', ...schedule() } });
    assert.equal(accepted.status, 200);
    assert.equal((await ctx.api('POST', `/api/tickets/${id}/move`, { user: 'm7', body: { col: 'doing' } })).status, 400);
    completeTeam(ctx.app.store.state, ctx.app.store.state.tickets.find(t => t.id === id));
    ctx.app.store.save();
  });
  after(async () => { await ctx.app.close(); });

  it('на доске только принятые карточки, у каждой колонка, следующий шаг и исполнитель', async () => {
    const b = (await ctx.api('GET', '/api/tickets?box=board', { user: 'u1' })).json;
    assert.ok(b.length >= 10);
    assert.ok(b.every((t) => ['todo', 'doing', 'check', 'solved'].includes(t.board)));
    assert.ok(b.every((t) => t.status !== 'new' && t.status !== 'trash' && t.status !== 'rejected'));
    const mine = b.find((t) => t.id === id);
    assert.equal(mine.board, 'todo');
    assert.equal(mine.next.text, 'Взять в работу');
    assert.ok(mine.next.who.length > 0);
    const dict = (await ctx.api('GET', '/api/bootstrap', { user: 'u1' })).json;
    assert.deepEqual(dict.board.map((c) => c.label), ['К выполнению', 'В работе', 'На проверке', 'Решено']);
    assert.equal(dict.dict.STATUSES.done.label, 'На проверке');
    const filtered = (await ctx.api('GET', '/api/tickets?box=board&assigneeId=m7', { user: 'u1' })).json;
    assert.ok(filtered.length >= 1 && filtered.every((t) => t.assigneeId === 'm7'));
    const byEntry = (await ctx.api('GET', '/api/tickets?box=board&entryId=' + mine.entryId, { user: 'u1' })).json;
    assert.ok(byEntry.every((t) => t.entryId === mine.entryId));
  });

  it('перенос по колонкам: в работу → результат обязателен → подтверждает только собственник', async () => {
    assert.equal((await ctx.api('POST', `/api/tickets/${id}/move`, { user: 'u1', body: { col: 'doing' } })).status, 403, 'сотрудник не двигает чужую карточку');
    const w = await ctx.api('POST', `/api/tickets/${id}/move`, { user: 'm7', body: { col: 'doing' } });
    assert.equal(w.json.board, 'doing');
    assert.equal((await ctx.api('GET', '/api/public/track/' + track)).json.state, 'work');

    assert.equal((await ctx.api('POST', `/api/tickets/${id}/move`, { user: 'm7', body: { col: 'solved' } })).status, 400, 'мимо проверки нельзя');
    assert.equal((await ctx.api('POST', `/api/tickets/${id}/move`, { user: 'm7', body: { col: 'check' } })).status, 400, 'без результата нельзя');
    const c = await ctx.api('POST', `/api/tickets/${id}/move`, { user: 'm7', body: { col: 'check', result: 'Откатили прошивку, турникет работает штатно' } });
    assert.equal(c.json.board, 'check');
    assert.equal(c.json.next.text, 'Подтвердить результат');
    assert.ok((await ctx.api('GET', '/api/notifications', { user: 'o1' })).json.some((n) => n.ticketId === id && /ждёт вашей проверки/.test(n.text)));

    assert.equal((await ctx.api('POST', `/api/tickets/${id}/move`, { user: 'm7', body: { col: 'solved' } })).status, 403, 'ответственный сам не подтверждает');
    assert.equal((await ctx.api('POST', `/api/tickets/${id}/transition`, { user: 'a1', body: { to: 'closed', result: 'ок, закрываю' } })).status, 403);
  });

  it('результат не подтверждён → карточка возвращается в «В работе»; подтверждён → «Решено»', async () => {
    assert.equal((await ctx.api('POST', `/api/tickets/${id}/move`, { user: 'o1', body: { col: 'doing' } })).status, 400, 'нужно объяснить, что не так');
    const back = await ctx.api('POST', `/api/tickets/${id}/move`, { user: 'o1', body: { col: 'doing', comment: 'Турникет снова завис вечером' } });
    assert.equal(back.json.board, 'doing');
    assert.ok((await ctx.api('GET', '/api/notifications', { user: 'm7' })).json.some((n) => n.ticketId === id && /не подтвердился/.test(n.text)));

    await ctx.api('POST', `/api/tickets/${id}/move`, { user: 'm7', body: { col: 'check', result: 'Заменили контроллер, сутки без сбоев' } });
    const ok = await ctx.api('POST', `/api/tickets/${id}/move`, { user: 'o1', body: { col: 'solved' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'closed');
    assert.equal(ok.json.board, 'solved');
    assert.equal(ok.json.stage, 'solved');
    const s = (await ctx.api('GET', '/api/public/track/' + track)).json;
    assert.equal(s.state, 'solved');
    assert.match(s.result, /контроллер/);
  });
});

describe('Планировщик: напоминание собственнику и очистка корзины', () => {
  it('обращение без решения дольше суток — напоминание; корзина старше 30 дней очищается', () => {
    const now = Date.now(), DAY = 86400000;
    const s = core.createSeedState(now);
    const p = core.createPublicTicket(s, 'site', { text: TEXT }, now - 2 * DAY);
    const n0 = s.notifications.filter((n) => n.userId === 'o1' && n.ticketId === p.id).length;
    core.tick(s, now);
    const rem = s.notifications.filter((n) => n.userId === 'o1' && n.ticketId === p.id);
    assert.equal(rem.length, n0 + 1);
    assert.match(rem.at(-1).text, /ждёт вашего решения/);
    assert.equal(rem.at(-1).kind, 'triage');
    core.tick(s, now + 3600000);
    assert.equal(s.notifications.filter((n) => n.userId === 'o1' && n.ticketId === p.id).length, n0 + 1, 'не чаще раза в сутки');

    core.toTrash(s, 'o1', p.id, 'Спам', now);
    core.tick(s, now + 29 * DAY);
    assert.ok(s.tickets.some((t) => t.id === p.id), 'через 29 дней ещё в корзине');
    core.tick(s, now + 31 * DAY);
    assert.ok(!s.tickets.some((t) => t.id === p.id), 'через 31 день удалено');
    assert.ok(!s.events.some((e) => e.ticketId === p.id));
  });

  it('старая база получает точки входа и настройки фильтра', () => {
    const s = core.createSeedState(Date.now(), { triage: false });
    delete s.entries; delete s.settings.ownerTriage; delete s.settings.trashDays;
    core.ensureDefaults(s);
    assert.equal(s.entries.length, 4);
    assert.equal(s.settings.ownerTriage, true);
    assert.equal(s.settings.trashDays, 30);
  });

  it('QR-код: матрица нужного размера с тремя метками, SVG с подписью', () => {
    const m = core.qrMatrix('https://signal.modus-trade.ru/#/f/object-demo');
    assert.equal(m.length, m[0].length);
    assert.equal((m.length - 17) % 4, 0);
    const finder = (x, y) => [0, 1, 2, 3, 4, 5, 6].every((i) => m[y][x + i] && m[y + 6][x + i] && m[y + i][x] && m[y + i][x + 6]) && m[y + 3][x + 3] && !m[y + 1][x + 1];
    const n = m.length;
    assert.ok(finder(0, 0) && finder(n - 7, 0) && finder(0, n - 7));
    const svg = core.qrSvg('https://signal.modus-trade.ru/#/f/office', 'Офис, вход <1>');
    assert.match(svg, /^<svg /);
    assert.match(svg, /Офис, вход &lt;1&gt;/);
    assert.throws(() => core.qrMatrix('x'.repeat(400)), /слишком длинная/);
  });
});

describe('Telegram: кнопки собственника под новым обращением', () => {
  it('кнопки открывают выбор параметров без изменения статуса и проверяют права и актуальность', async () => {
    const fake = await fakeServer(async (p) => {
      if (p.endsWith('/getUpdates')) { await new Promise((r) => setTimeout(r, 100)); return { ok: true, result: [] }; }
      return { ok: true, result: p.endsWith('/sendMessage') ? { message_id: 7 } : true };
    });
    const ctx = await boot({ botToken: '1:TEST', botPolling: true, tgApiBase: fake.url, publicUrl: 'https://signal.example.ru', dispatchMs: 3600000 });
    const bot = ctx.app.bot;
    const sent = () => fake.calls.filter((c) => c.path.endsWith('/sendMessage')).map((c) => c.body);
    const chat = { id: 9001, type: 'private' }, from = { id: 9001, first_name: 'Собственник' };
    const cb = (data, f = from, ch = chat) => bot.handleUpdate({ update_id: 5, callback_query: { id: 'q', from: f, data, message: { message_id: 7, chat: ch } } });
    try {
      await new Promise((r) => setTimeout(r, 150));
      await cb('link:o1');
      const a = (await ctx.api('POST', '/api/public/tickets', { body: { code: 'office', text: TEXT, contactName: 'Айдар' } })).json;
      const b = (await ctx.api('POST', '/api/public/tickets', { body: { code: 'site', text: 'Купите у нас рекламу со скидкой, только сегодня!' } })).json;
      await bot.dispatchOnce();
      const mine = sent().filter((m) => String(m.chat_id) === '9001');
      const withA = mine.find((m) => m.text.includes(a.id) && m.reply_markup);
      assert.ok(withA, 'сообщение о новом обращении');
      assert.match(withA.text, /турникет/);
      assert.match(withA.text, /Айдар/);
      assert.deepEqual(withA.reply_markup.inline_keyboard[0].map((x) => x.callback_data), ['tri:ok:' + a.id, 'tri:no:' + a.id]);

      // посторонний не может нажать кнопку
      const ech = { id: 9002, type: 'private' }, efrom = { id: 9002, first_name: 'Сотрудник' };
      await cb('link:u2', efrom, ech);
      await cb('tri:ok:' + a.id, efrom, ech);
      assert.match(sent().at(-1).text, /только собственник/);
      assert.equal(sent().at(-1).reply_markup, undefined);
      await cb('tri:no:' + a.id, efrom, ech);
      assert.match(sent().at(-1).text, /только собственник/);
      const stranger = { id: 9003, first_name: 'Гость' };
      await cb('tri:ok:' + a.id, stranger, { id: 9003, type: 'private' });
      assert.match(sent().at(-1).text, /только собственник/);
      assert.equal((await ctx.api('GET', '/api/tickets/' + a.id, { user: 'o1' })).json.status, 'new');

      await cb('tri:ok:' + a.id);
      assert.match(sent().at(-1).text, /Назначьте ответственного и срок/);
      assert.equal(sent().at(-1).reply_markup.inline_keyboard[0][0].web_app.url, 'https://signal.example.ru/#/t/' + a.id + '?triage=accept');
      assert.equal((await ctx.api('GET', '/api/tickets/' + a.id, { user: 'o1' })).json.status, 'new');
      await cb('tri:no:' + b.id);
      assert.match(sent().at(-1).text, /Укажите причину/);
      assert.equal(sent().at(-1).reply_markup.inline_keyboard[0][0].web_app.url, 'https://signal.example.ru/#/t/' + b.id + '?triage=trash');
      assert.equal((await ctx.api('GET', '/api/tickets/' + b.id, { user: 'o1' })).json.status, 'new');
      assert.equal(fake.calls.filter((c) => c.path.endsWith('/editMessageReplyMarkup')).length, 0, 'старые кнопки сохраняются');

      await ctx.api('POST', '/api/tickets/' + b.id + '/trash', { user: 'o1', body: { reason: 'Спам' } });
      await cb('tri:ok:' + b.id);
      assert.match(sent().at(-1).text, /уже разобрано/);
      assert.equal((await ctx.api('GET', '/api/tickets/' + b.id, { user: 'o1' })).json.status, 'trash');
      assert.equal(sent().at(-1).reply_markup.inline_keyboard[0][0].web_app.url, 'https://signal.example.ru/#/t/' + b.id);
      await cb('tri:no:A-DOES-NOT-EXIST');
      assert.match(sent().at(-1).text, /не найдено/);
      assert.equal(sent().at(-1).reply_markup, undefined);
    } finally {
      await ctx.app.close();
      fake.srv.close();
    }
  });
});
