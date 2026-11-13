'use strict';
/**
 * Тесты v2: файлы, общий чат, «взять в работу», напоминания, кабинет собственника,
 * ИИ-агент (заглушки Anthropic и OpenAI-совместимого API), ежедневный отчёт, магазин наград, миграция БД.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { start } = require('../server/index.js');
const { readLlmConfig } = require('../server/llm.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'modus-v2-')); }

async function boot(over = {}) {
  if (over.triage === undefined) over = Object.assign({ triage: false }, over); // прежние сценарии — без фильтра собственника
  const dir = over.dataDir || tmpDir();
  const app = start(Object.assign({ port: 0, host: '127.0.0.1', dataDir: dir, demo: true, quiet: true, botToken: '', botPolling: false, b24Webhook: '', llm: { configured: false }, dailyCheckMs: 3600000 }, over));
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

/** HTTP-заглушка: записывает метод, путь, заголовки и тело; handler → { status?, body }. */
function fakeServer(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(d || '{}'); } catch (_) { /* ignore */ }
      calls.push({ method: req.method, path: req.url, headers: req.headers, body });
      const out = await handler(req.url, body);
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

function upload(base, { user = 'u1', type, name, data }) {
  const headers = { 'Content-Type': type };
  if (user) headers['X-Demo-User'] = user;
  if (name) headers['X-File-Name'] = encodeURIComponent(name);
  return fetch(base + '/api/files', { method: 'POST', headers, body: data });
}

describe('v2: файлы, чат, работа с обращениями, собственник', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(async () => { await ctx.app.close(); });

  let png, pngBytes;
  it('файлы: загрузка, выдача без авторизации, Range, disposition', async () => {
    pngBytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const r = await upload(ctx.base, { type: 'image/png', name: 'Снимок экрана.png', data: pngBytes });
    assert.equal(r.status, 201);
    png = await r.json();
    assert.match(png.id, /^[0-9a-f]{48}$/);
    assert.deepEqual(png, { id: png.id, name: 'Снимок экрана.png', type: 'image/png', size: 1000, kind: 'image', url: '/api/files/' + png.id });
    assert.ok(fs.existsSync(path.join(ctx.dir, 'files', png.id)));

    let g = await fetch(ctx.base + png.url); // без авторизации
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type'), 'image/png');
    assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
    assert.match(g.headers.get('content-disposition'), /^inline; .*filename\*=UTF-8''%D0%A1%D0%BD%D0%B8%D0%BC%D0%BE%D0%BA/);
    assert.match(g.headers.get('cache-control'), /max-age=86400/);
    assert.equal(g.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), pngBytes);

    g = await fetch(ctx.base + png.url, { headers: { Range: 'bytes=10-19' } });
    assert.equal(g.status, 206);
    assert.equal(g.headers.get('content-range'), 'bytes 10-19/1000');
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), pngBytes.subarray(10, 20));
    g = await fetch(ctx.base + png.url, { headers: { Range: 'bytes=-5' } });
    assert.equal(g.status, 206);
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), pngBytes.subarray(995));
    g = await fetch(ctx.base + png.url, { headers: { Range: 'bytes=5000-' } });
    assert.equal(g.status, 416);
    await g.arrayBuffer();

    const v = await upload(ctx.base, { type: 'video/mp4', name: 'ролик.mp4', data: Buffer.alloc(2048, 7) });
    const vm = await v.json();
    assert.equal(vm.kind, 'video');
    const docx = await upload(ctx.base, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'Регламент.docx', data: Buffer.from('PK fake') });
    assert.equal(docx.status, 201);
    const dm = await docx.json();
    assert.equal(dm.kind, 'doc');
    g = await fetch(ctx.base + dm.url);
    assert.match(g.headers.get('content-disposition'), /^attachment;/);
    await g.arrayBuffer();
    const pdf = await upload(ctx.base, { type: 'application/pdf', name: 'a.pdf', data: Buffer.from('%PDF-1.4') });
    g = await fetch(ctx.base + (await pdf.json()).url);
    assert.match(g.headers.get('content-disposition'), /^inline;/);
    await g.arrayBuffer();
  });

  it('файлы: 413 больше 25 МБ, 415 запрещённый тип, 401 без авторизации, 404', async () => {
    let r = await upload(ctx.base, { type: 'video/mp4', name: 'big.mp4', data: Buffer.alloc(25 * 1024 * 1024 + 1) }).catch(() => ({ status: 'reset' }));
    assert.ok(r.status === 413 || r.status === 'reset', String(r.status));
    if (r.json) assert.equal((await r.json()).code, 'payload_too_large');
    for (const type of ['text/html', 'image/svg+xml', 'application/x-msdownload', 'application/javascript']) {
      r = await upload(ctx.base, { type, name: 'x', data: Buffer.from('<script>alert(1)</script>') });
      assert.equal(r.status, 415, type);
      assert.equal((await r.json()).code, 'unsupported_type');
    }
    r = await upload(ctx.base, { user: null, type: 'image/png', name: 'x.png', data: Buffer.from('x') });
    assert.equal(r.status, 401);
    await r.arrayBuffer();
    r = await fetch(ctx.base + '/api/files/' + 'a'.repeat(48));
    assert.equal(r.status, 404);
    await r.arrayBuffer();
    r = await fetch(ctx.base + '/api/files/..%2f..%2fmodus.db');
    assert.equal(r.status, 404);
    await r.arrayBuffer();
  });

  let chatMsg;
  it('чат: список, публикация со ссылкой на обращение и файлом, after, создание обращения из сообщения', async () => {
    let r = await ctx.api('GET', '/api/chat', { user: 'u1' });
    assert.equal(r.status, 200);
    assert.ok(r.json.length >= 9);
    const lastAt = r.json.at(-1).at;
    const seeded = r.json.find((m) => m.text.includes('A-011'));
    assert.equal(seeded.refs[0].id, 'A-011');
    r = await ctx.api('POST', '/api/chat', { user: 'u1', body: { text: 'Посмотрите A-007 — опять не работает синхронизация, висит уже два дня', files: [png], replyTo: seeded.id } });
    assert.equal(r.status, 201);
    chatMsg = r.json;
    assert.equal(chatMsg.refs[0].id, 'A-007');
    assert.equal(chatMsg.refs[0].status, 'new');
    assert.equal(chatMsg.mine, true);
    assert.equal(chatMsg.userName, 'Сотрудник закупок');
    assert.equal(chatMsg.files[0].url, png.url);
    assert.equal(chatMsg.replyTo, seeded.id);
    assert.equal(chatMsg.suggestTicket, true);
    r = await ctx.api('GET', '/api/chat?after=' + encodeURIComponent(lastAt), { user: 'm1' });
    assert.deepEqual(r.json.map((m) => m.id), [chatMsg.id]);
    assert.equal(r.json[0].mine, false);
    r = await ctx.api('POST', '/api/chat', { user: 'u1', body: { text: '  ' } });
    assert.equal(r.status, 400);
    r = await ctx.api('POST', '/api/tickets', { user: 'u1', body: { type: 'problem', categoryId: 'c07', text: 'Синхронизация остатков опять не работает два дня подряд.', chatId: chatMsg.id } });
    assert.equal(r.status, 201);
    assert.match(r.json.events[0].text, /из сообщения в общем чате/);
    const list = await ctx.api('GET', '/api/chat', { user: 'u1' });
    assert.equal(list.json.find((m) => m.id === chatMsg.id).ticketId, r.json.id);
  });

  it('«взять в работу»: сотрудник выполняет карточку только после назначения', async () => {
    let r = await ctx.api('POST', '/api/tickets/A-001/claim', { user: 'm2' });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'work');
    assert.equal(r.json.assigneeId, 'm2');
    assert.ok(r.json.firstResponseAt);
    r = await ctx.api('POST', '/api/tickets/A-002/claim', { user: 'u5' });
    assert.equal(r.status, 403);
    const assigned = await ctx.api('POST', '/api/tickets/A-002/assign', { user: 'o1', body: { userId: 'u5' } });
    assert.equal(assigned.status, 200);
    r = await ctx.api('POST', '/api/tickets/A-002/claim', { user: 'u5' });
    assert.equal(r.status, 200);
    assert.equal(r.json.assigneeId, 'u5');
    assert.equal(r.json.status, 'work');
    r = await ctx.api('POST', '/api/tickets/A-002/claim', { user: 'u6' });
    assert.equal(r.status, 403);
    r = await ctx.api('POST', '/api/tickets/A-018/claim', { user: 'm14' });
    assert.equal(r.status, 400, 'закрытое/отзыв не берётся');
  });

  it('напоминание (nudge): руководитель — да, сотрудник — 403', async () => {
    let r = await ctx.api('POST', '/api/tickets/A-007/nudge', { user: 'm2' });
    assert.equal(r.status, 200);
    assert.ok(r.json.events.some((e) => e.kind === 'nudge'));
    const n = await ctx.api('GET', '/api/notifications', { user: 'm7' });
    assert.ok(n.json.some((x) => x.ticketId === 'A-007' && /просит ускорить/.test(x.text)));
    r = await ctx.api('POST', '/api/tickets/A-007/nudge', { user: 'u1' });
    assert.equal(r.status, 403);
  });

  it('собственник: дайджест (health/hanging/risk с m2), люди; сотрудник и руководитель — 403', async () => {
    const r = await ctx.api('GET', '/api/owner/digest', { user: 'o1' });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.health.score, 'number');
    assert.ok(Array.isArray(r.json.hanging) && r.json.hanging.some((h) => h.id === 'A-007'));
    assert.ok(r.json.risk.some((x) => x.userId === 'm2'), JSON.stringify(r.json.risk));
    assert.ok(Array.isArray(r.json.pendingRewards));
    const p = await ctx.api('GET', '/api/owner/people', { user: 'o1' });
    assert.ok(p.json.some((x) => x.userId === 'u1'));
    assert.equal((await ctx.api('GET', '/api/owner/digest', { user: 'a1' })).status, 200, 'администратор тоже');
    for (const user of ['u1', 'm1']) {
      for (const [m, u, body] of [['GET', '/api/owner/digest'], ['GET', '/api/owner/people'], ['GET', '/api/owner/reports'], ['POST', '/api/owner/report', {}], ['POST', '/api/owner/bonus', { userId: 'u1', amount: 50 }], ['POST', '/api/agent/ask', { question: 'Как дела?' }]]) {
        const x = await ctx.api(m, u, { user, body });
        assert.equal(x.status, 403, `${user} ${m} ${u}`);
      }
    }
    const b = await ctx.api('GET', '/api/bootstrap', { user: 'o1' });
    assert.equal(b.json.me.role, 'owner');
    assert.ok('leaderId' in b.json);
  });

  it('поощрение собственником пополняет баланс', async () => {
    const before = (await ctx.api('GET', '/api/profile', { user: 'u5' })).json.balance;
    const r = await ctx.api('POST', '/api/owner/bonus', { user: 'o1', body: { userId: 'u5', amount: 300, reason: 'За демо-стенд для новичков' } });
    assert.equal(r.status, 201);
    assert.equal(r.json.kind, 'bonus');
    assert.equal(r.json.balance.coins, before.coins + 300);
    const after = (await ctx.api('GET', '/api/profile', { user: 'u5' })).json.balance;
    assert.equal(after.earned, before.earned + 300);
    const bad = await ctx.api('POST', '/api/owner/bonus', { user: 'o1', body: { userId: 'u5', amount: 1 } });
    assert.equal(bad.status, 400);
    const other = await ctx.api('GET', '/api/profile/u5', { user: 'u1' });
    assert.deepEqual(other.json.ledger, [], 'чужую историю баллов не видно');
  });

  it('магазин: лимит на сотрудника, возврат монет при отказе, права на решение', async () => {
    let r = await ctx.api('GET', '/api/rewards', { user: 'u5' });
    const lunch = r.json.find((x) => x.id === 'lunch');
    assert.equal(lunch.mineLeft, 1);
    const coins0 = (await ctx.api('GET', '/api/profile', { user: 'u5' })).json.balance.coins;
    r = await ctx.api('POST', '/api/rewards/lunch/redeem', { user: 'u5' });
    assert.equal(r.status, 201);
    const red = r.json.redemption;
    assert.equal(red.state, 'pending');
    assert.equal(r.json.balance.coins, coins0 - 120);
    r = await ctx.api('POST', '/api/rewards/lunch/redeem', { user: 'u5' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /лимит/);
    // обычный руководитель не решает и не видит заявки
    assert.equal((await ctx.api('POST', `/api/owner/redemptions/${red.id}`, { user: 'm1', body: { approve: true } })).status, 403);
    assert.equal((await ctx.api('GET', '/api/owner/redemptions', { user: 'm1' })).status, 403);
    // HR (m14) видит и решает; отказ без причины — 400
    const list = await ctx.api('GET', '/api/owner/redemptions', { user: 'm14' });
    assert.ok(list.json.some((x) => x.id === red.id && x.userName === 'Координатор проекта'));
    assert.equal((await ctx.api('POST', `/api/owner/redemptions/${red.id}`, { user: 'm14', body: { approve: false } })).status, 400);
    assert.equal((await ctx.api('POST', `/api/owner/redemptions/${red.id}`, { user: 'm14', body: {} })).status, 400);
    r = await ctx.api('POST', `/api/owner/redemptions/${red.id}`, { user: 'm14', body: { approve: false, note: 'Лимит обедов на квартал уже распределён' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.state, 'rejected');
    assert.equal((await ctx.api('GET', '/api/profile', { user: 'u5' })).json.balance.coins, coins0, 'монеты возвращены');
    const n = await ctx.api('GET', '/api/notifications', { user: 'u5' });
    assert.ok(n.json.some((x) => /отклонена/.test(x.text)));
    // после отказа лимит снова доступен; m14 одобряет сидовую заявку
    r = await ctx.api('GET', '/api/rewards', { user: 'u5' });
    assert.equal(r.json.find((x) => x.id === 'lunch').mineLeft, 1);
    const seeded = list.json.find((x) => x.state === 'pending' && x.userId === 'u1');
    r = await ctx.api('POST', `/api/owner/redemptions/${seeded.id}`, { user: 'm14', body: { approve: true, note: 'Заберите у HR' } });
    assert.equal(r.json.state, 'approved');
    r = await ctx.api('POST', `/api/owner/redemptions/${seeded.id}`, { user: 'o1', body: { approve: false, note: 'передумали совсем' } });
    assert.equal(r.status, 400, 'повторное решение запрещено');
  });

  it('магазин: собственник создаёт и меняет награды, сотрудник — 403', async () => {
    let r = await ctx.api('POST', '/api/admin/rewards', { user: 'o1', body: { name: 'Парковочное место на месяц', cost: 200, stock: 2, perUser: 1, icon: '🚗' } });
    assert.equal(r.status, 201);
    const id = r.json.id;
    r = await ctx.api('PUT', `/api/admin/rewards/${id}`, { user: 'o1', body: { cost: 180, active: false } });
    assert.equal(r.json.cost, 180);
    r = await ctx.api('GET', '/api/rewards', { user: 'u1' });
    assert.ok(!r.json.some((x) => x.id === id), 'неактивная скрыта');
    assert.equal((await ctx.api('PUT', `/api/admin/rewards/${id}`, { user: 'u1', body: { cost: 1 } })).status, 403);
    assert.equal((await ctx.api('PUT', '/api/admin/rewards/nope', { user: 'o1', body: { cost: 1 } })).status, 404);
    assert.equal((await ctx.api('POST', '/api/admin/rewards', { user: 'm1', body: { name: 'x' } })).status, 403);
  });

  it('отчёт без LLM содержит факты, вопрос агенту получает ответ по правилам', async () => {
    let r = await ctx.api('POST', '/api/owner/report', { user: 'o1' });
    assert.equal(r.status, 201);
    assert.equal(r.json.source, 'facts');
    assert.match(r.json.text, /^МОДУС/);
    assert.match(r.json.id, /^daily-\d{4}-\d{2}-\d{2}$/);
    r = await ctx.api('GET', '/api/owner/reports', { user: 'o1' });
    assert.equal(r.json[0].source, 'facts');
    r = await ctx.api('POST', '/api/agent/ask', { user: 'o1', body: { question: 'Кто тормозит обращения?' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.source, 'rules');
    assert.equal(r.json.model, null);
    assert.match(r.json.text, /ИИ не подключён: задайте LLM_API_KEY — сейчас показан отчёт по правилам$/);
    r = await ctx.api('POST', '/api/agent/ask', { user: 'o1', body: {} });
    assert.equal(r.status, 400);
  });
});

describe('v2: ИИ-агент через LLM (заглушки)', () => {
  it('Anthropic: формат запроса, заголовки, модель; отчёт сохраняется с source=ai', async () => {
    const fake = await fakeServer(() => ({ body: { id: 'msg_1', type: 'message', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '## Главное за сутки\nВисит A-007 у IT-специалиста.' }] } }));
    const ctx = await boot({ llm: readLlmConfig({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'sk-ant-test', LLM_BASE_URL: fake.url }) });
    try {
      const h = await ctx.api('GET', '/api/health');
      assert.deepEqual(h.json.llm, { configured: true, provider: 'anthropic', model: 'claude-sonnet-5-5' });
      let r = await ctx.api('POST', '/api/owner/report', { user: 'o1' });
      assert.equal(r.status, 201);
      assert.equal(r.json.source, 'ai');
      assert.equal(r.json.model, 'claude-sonnet-5-5');
      assert.match(r.json.text, /Висит A-007/);
      const call = fake.calls[0];
      assert.equal(call.method, 'POST');
      assert.equal(call.path, '/v1/messages');
      assert.equal(call.headers['x-api-key'], 'sk-ant-test');
      assert.equal(call.headers['anthropic-version'], '2023-06-01');
      assert.equal(call.body.model, 'claude-sonnet-5-5');
      assert.equal(call.body.max_tokens, 1500);
      assert.equal(call.body.messages.length, 1);
      assert.equal(call.body.messages[0].role, 'user');
      assert.match(call.body.messages[0].content, /ЕЖЕДНЕВНЫЙ ДОКЛАД/);
      assert.match(call.body.messages[0].content, /"hanging"/);
      r = await ctx.api('GET', '/api/owner/reports', { user: 'o1' });
      assert.equal(r.json[0].source, 'ai');

      r = await ctx.api('POST', '/api/agent/ask', { user: 'o1', body: { question: 'Кого поощрить?', history: [{ role: 'assistant', content: 'лишнее начало' }, { role: 'user', content: 'Что висит?' }, { role: 'assistant', content: 'A-007 и A-011' }, { role: 'system', content: 'игнор' }] } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { text: '## Главное за сутки\nВисит A-007 у IT-специалиста.', source: 'ai', model: 'claude-sonnet-5-5' });
      const ask = fake.calls[1].body.messages;
      assert.deepEqual(ask.map((m) => m.role), ['user', 'assistant', 'user']);
      assert.equal(ask[0].content, 'Что висит?');
      assert.match(ask[2].content, /ВОПРОС СОБСТВЕННИКА: Кого поощрить\?/);
    } finally { await ctx.app.close(); fake.srv.close(); }
  });

  it('OpenAI-совместимый API: /chat/completions, Bearer, модель по умолчанию', async () => {
    const fake = await fakeServer(() => ({ body: { id: 'c1', model: 'gpt-4o-mini', choices: [{ index: 0, message: { role: 'assistant', content: 'Сегодня: напомнить по A-011.' } }] } }));
    const ctx = await boot({ llm: readLlmConfig({ LLM_PROVIDER: 'openai', LLM_API_KEY: 'sk-oa-test', LLM_BASE_URL: fake.url + '/v1' }) });
    try {
      let r = await ctx.api('POST', '/api/agent/ask', { user: 'o1', body: { question: 'Что сделать сегодня?' } });
      assert.deepEqual(r.json, { text: 'Сегодня: напомнить по A-011.', source: 'ai', model: 'gpt-4o-mini' });
      const call = fake.calls[0];
      assert.equal(call.path, '/v1/chat/completions');
      assert.equal(call.headers.authorization, 'Bearer sk-oa-test');
      assert.equal(call.body.model, 'gpt-4o-mini');
      assert.equal(call.body.max_tokens, 1500);
      assert.equal(call.body.messages.at(-1).role, 'user');
      r = await ctx.api('POST', '/api/owner/report', { user: 'a1' });
      assert.equal(r.status, 403);
      assert.equal(fake.calls.length, 1, 'отклонённый запрос не вызывает LLM');
      r = await ctx.api('POST', '/api/owner/report', { user: 'o1' });
      assert.equal(r.status, 201);
      assert.equal(r.json.source, 'ai');
      assert.equal(r.json.text, 'Сегодня: напомнить по A-011.');
    } finally { await ctx.app.close(); fake.srv.close(); }
  });

  it('ошибка LLM → отчёт по правилам с полем error', async () => {
    const fake = await fakeServer(() => ({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }));
    const ctx = await boot({ llm: readLlmConfig({ LLM_API_KEY: 'k', LLM_BASE_URL: fake.url }) });
    try {
      let r = await ctx.api('POST', '/api/owner/report', { user: 'o1' });
      assert.equal(r.status, 201);
      assert.equal(r.json.source, 'rules');
      assert.match(r.json.error, /529/);
      assert.match(r.json.text, /^Пульс/);
      r = await ctx.api('POST', '/api/agent/ask', { user: 'o1', body: { question: 'Как дела?' } });
      assert.equal(r.json.source, 'rules');
      assert.ok(r.json.error);
    } finally { await ctx.app.close(); fake.srv.close(); }
  });
});

describe('v2: ежедневный отчёт по расписанию', () => {
  it('не раньше REPORT_HOUR и ровно один отчёт за сутки; собственник получает уведомление', async () => {
    const ctx = await boot({ reportHour: 9 });
    try {
      const at = (d, h, m = 0) => new Date(2030, 0, d, h, m).getTime();
      assert.equal(await ctx.app.runDaily(at(10, 8, 59)), null, 'до 9:00 не создаётся');
      const r1 = await ctx.app.runDaily(at(10, 9, 0));
      assert.ok(r1 && r1.source === 'rules');
      assert.equal(await ctx.app.runDaily(at(10, 9, 1)), null);
      assert.equal(await ctx.app.runDaily(at(10, 23, 59)), null);
      // параллельные вызовы не создают дублей
      const [a, b] = await Promise.all([ctx.app.runDaily(at(11, 10)), ctx.app.runDaily(at(11, 10))]);
      assert.ok((a && !b) || (!a && b));
      const reports = ctx.app.store.state.reports;
      assert.equal(reports.length, 2);
      const notes = ctx.app.store.state.notifications.filter((n) => n.userId === 'o1' && /Ежедневный отчёт агента готов/.test(n.text));
      assert.equal(notes.length, 2);
      assert.equal(notes[0].delivered, false);
      assert.match(notes[0].id, /^n\d+$/);
      assert.equal(new Set(ctx.app.store.state.notifications.map((n) => n.id)).size, ctx.app.store.state.notifications.length, 'id уведомлений уникальны');
    } finally { await ctx.app.close(); }
  });
});

describe('v2: миграция старой базы', () => {
  it('добавляет o1, коллекции chat/reports и новый каталог наград', async () => {
    const dir = tmpDir();
    let ctx = await boot({ dataDir: dir });
    await ctx.app.close();
    const db = new DatabaseSync(path.join(dir, 'modus.db'));
    db.exec("DELETE FROM users WHERE id = 'o1'");
    db.exec('DROP TABLE chat');
    db.exec('DROP TABLE reports');
    db.exec('DELETE FROM rewards');
    const ins = db.prepare('INSERT INTO rewards (id, data) VALUES (?, ?)');
    for (const [id, cost] of [['course', 120], ['dayoff', 200], ['merch', 40], ['cert', 60], ['lunch', 90]]) ins.run(id, JSON.stringify({ id, name: id, cost, desc: '' }));
    db.close();
    ctx = await boot({ dataDir: dir });
    try {
      assert.ok(ctx.app.store.state.users.some((u) => u.id === 'o1'));
      const chat = await ctx.api('GET', '/api/chat', { user: 'u1' });
      assert.deepEqual(chat.json, []);
      const rw = await ctx.api('GET', '/api/rewards', { user: 'u1' });
      assert.ok(rw.json.some((r) => r.id === 'gym' && r.icon));
      assert.equal((await ctx.api('GET', '/api/owner/digest', { user: 'o1' })).status, 200);
      const p = await ctx.api('POST', '/api/chat', { user: 'u1', body: { text: 'Проверка после миграции' } });
      assert.equal(p.status, 201);
    } finally { await ctx.app.close(); }
  });
});

describe('v2: Telegram-бот собственника', () => {
  it('/report с заявками на награды, /ask, /inbox для собственника, рассылка ежедневного отчёта', async () => {
    const fake = await fakeServer(async (p) => {
      if (p.endsWith('/getUpdates')) { await new Promise((r) => setTimeout(r, 100)); return { body: { ok: true, result: [] } }; }
      return { body: { ok: true, result: p.endsWith('/sendMessage') ? { message_id: 1 } : true } };
    });
    const ctx = await boot({ botToken: '1:TEST', botPolling: true, tgApiBase: fake.url, publicUrl: 'https://signal.example.ru', dispatchMs: 3600000, reportHour: 0 });
    const bot = ctx.app.bot;
    const sent = () => fake.calls.filter((c) => c.path.endsWith('/sendMessage')).map((c) => c.body);
    const chat = { id: 9001, type: 'private' }, from = { id: 9001, first_name: 'Собственник' };
    const msg = (text) => ({ update_id: 1, message: { message_id: 1, chat, from, text } });
    try {
      await new Promise((r) => setTimeout(r, 150));
      const cmds = fake.calls.find((c) => c.path.endsWith('/setMyCommands')).body.commands.map((c) => c.command);
      assert.ok(cmds.includes('report') && cmds.includes('ask'));
      await bot.handleUpdate({ update_id: 2, callback_query: { id: 'q', from, data: 'link:o1', message: { message_id: 2, chat } } });
      assert.match(sent().at(-1).text, /\/report/);

      await bot.handleUpdate(msg('/report'));
      const texts = sent().filter((m) => m.chat_id === 9001).map((m) => m.text).join('\n');
      assert.match(texts, /Отчёт R\d+/);
      assert.match(texts, /Пульс: \d+\/100/);
      assert.match(texts, /Ждут подтверждения заявки на награды \(2\)/);
      assert.equal(sent().at(-1).reply_markup.inline_keyboard[0][0].web_app.url, 'https://signal.example.ru/#/owner');
      assert.ok(sent().every((m) => m.text.length <= 4096));

      await bot.handleUpdate(msg('/ask Кто тормозит?'));
      assert.match(sent().at(-1).text, /ИИ не подключён/);
      await bot.handleUpdate(msg('/inbox'));
      assert.match(sent().at(-1).text, /Входящие/);

      // сотрудник не получает отчёт
      const ech = { id: 9002, type: 'private' }, efrom = { id: 9002, first_name: 'Сотрудник' };
      await bot.handleUpdate({ update_id: 3, callback_query: { id: 'q2', from: efrom, data: 'link:u2', message: { message_id: 3, chat: ech } } });
      await bot.handleUpdate({ update_id: 4, message: { message_id: 4, chat: ech, from: efrom, text: '/report' } });
      assert.match(sent().at(-1).text, /доступен собственнику/);

      // ежедневный отчёт: полный текст уходит собственнику в Telegram
      const before = sent().length;
      const r = await ctx.app.runDaily(new Date(2031, 5, 1, 10).getTime());
      assert.ok(r);
      await new Promise((res) => setTimeout(res, 100));
      const daily = sent().slice(before).filter((m) => m.chat_id === '9001');
      assert.ok(daily.length >= 2, 'заголовок + текст отчёта');
      assert.match(daily[0].text, /Ежедневный отчёт агента/);
    } finally {
      await ctx.app.close();
      fake.srv.close();
    }
  });
});

describe('v3: методики Адизеса, Кови, Карнеги', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(async () => { await ctx.app.close(); });

  it('круг влияния «решу сам» делает автора исполнителем, «руководство» — уведомляет собственника; PAEI по категории', async () => {
    let r = await ctx.api('POST', '/api/tickets', { user: 'u2', body: { type: 'problem', categoryId: 'c03', text: 'Разные обозначения в спецификациях путают при проверке', zone: 'self' } });
    assert.equal(r.status, 201); assert.equal(r.json.executorId, 'u2'); assert.equal(r.json.paei, 'A');
    r = await ctx.api('POST', '/api/tickets', { user: 'u4', body: { type: 'problem', categoryId: 'c11', text: 'Нужна политика приоритета срочных клиентских запросов', zone: 'mgmt' } });
    assert.equal(r.json.zone, 'mgmt');
    const n = await ctx.api('GET', '/api/notifications', { user: 'o1' });
    assert.ok(n.json.some((x) => x.ticketId === r.json.id && /руководства/.test(x.text)));
  });
  it('классификация: ответственный меняет PAEI/важность, сотрудник — 403; квадрант Кови в карточке', async () => {
    let r = await ctx.api('POST', '/api/tickets/A-012/classify', { user: 'u1', body: { paei: 'E' } });
    assert.equal(r.status, 403);
    r = await ctx.api('POST', '/api/tickets/A-012/classify', { user: 'm7', body: { paei: 'E', important: true } });
    assert.equal(r.status, 200); assert.equal(r.json.paei, 'E'); assert.ok(['Q1', 'Q2'].includes(r.json.quadrant));
    assert.ok(r.json.events.some((e) => e.kind === 'classified'));
    const q = await ctx.api('GET', '/api/tickets?quadrant=Q1', { user: 'm2' });
    assert.ok(q.json.every((t) => t.quadrant === 'Q1'));
  });
  it('благодарности: +2 монеты, нельзя себе, лимит 5 в неделю; методики в дайджесте', async () => {
    const before = (await ctx.api('GET', '/api/profile', { user: 'u8' })).json.balance.earned;
    let r = await ctx.api('POST', '/api/kudos', { user: 'u4', body: { toUserId: 'u8', text: 'Спасибо за быструю помощь на объекте' } });
    assert.equal(r.status, 201);
    assert.equal((await ctx.api('GET', '/api/profile', { user: 'u8' })).json.balance.earned, before + 2);
    assert.equal((await ctx.api('POST', '/api/kudos', { user: 'u4', body: { toUserId: 'u4', text: 'Себе спасибо' } })).status, 400);
    for (let i = 0; i < 4; i++) await ctx.api('POST', '/api/kudos', { user: 'u4', body: { toUserId: 'u1', text: 'Спасибо номер ' + i } });
    assert.equal((await ctx.api('POST', '/api/kudos', { user: 'u4', body: { toUserId: 'u1', text: 'Шестое спасибо' } })).status, 400);
    const d = await ctx.api('GET', '/api/owner/digest', { user: 'o1' });
    assert.ok(d.json.method && d.json.method.paei && typeof d.json.method.q2Share === 'number');
    assert.ok(d.json.method.kudos30 >= 4);
  });
  it('тон по Карнеги: грубый отказ получает подсказки; переписывание без LLM — правила', async () => {
    let r = await ctx.api('POST', '/api/tone/check', { user: 'm1', body: { text: 'Это бред, не нужно', kind: 'rejected' } });
    assert.ok(r.json.score < 50 && r.json.tips.length >= 2);
    r = await ctx.api('POST', '/api/agent/rewrite', { user: 'm1', body: { text: 'Не будем делать', kind: 'rejected' } });
    assert.equal(r.json.source, 'rules'); assert.equal(r.json.text, null);
    assert.equal((await ctx.api('POST', '/api/agent/rewrite', { user: 'u1', body: { text: 'x x x', kind: 'rejected' } })).status, 403);
  });
  it('внедрение публикует поздравление в общем чате (хвалим публично)', async () => {
    await ctx.api('POST', '/api/tickets/A-003/transition', { user: 'm1', body: { to: 'done', result: 'Внедрён единый справочник позиций' } });
    const chat = await ctx.api('GET', '/api/chat', { user: 'u2' });
    const c = chat.json.find((m) => m.kind === 'celebrate' && m.refTicket === 'A-003');
    assert.ok(c && /Спасибо, Сотрудник проектирования/.test(c.text));
  });
});

describe('v3: игра — задания, сундук, сезон, приватность', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(async () => { await ctx.app.close(); });
  it('задание недели: прогресс → награда один раз → после 3 заданий сундук', async () => {
    await ctx.api('POST', '/api/kudos', { user: 'u2', body: { toUserId: 'u1', text: 'Спасибо за заявку с параметрами' } });
    await ctx.api('POST', '/api/tickets/A-007/vote', { user: 'u2' }); await ctx.api('POST', '/api/tickets/A-014/vote', { user: 'u2' });
    await ctx.api('POST', '/api/chat', { user: 'u2', body: { text: 'Коллеги, всем привет!' } });
    let g = await ctx.api('GET', '/api/game', { user: 'u2' });
    assert.ok(g.json.quests.find((q) => q.id === 'q_kudos').ready);
    let r = await ctx.api('POST', '/api/game/quests/q_kudos/claim', { user: 'u2' }); assert.equal(r.status, 200); assert.equal(r.json.reward, 5);
    assert.equal((await ctx.api('POST', '/api/game/quests/q_kudos/claim', { user: 'u2' })).status, 400);
    assert.equal((await ctx.api('POST', '/api/game/quests/q_claim/claim', { user: 'u2' })).status, 400);
    await ctx.api('POST', '/api/game/quests/q_support/claim', { user: 'u2' });
    r = await ctx.api('POST', '/api/game/quests/q_chat/claim', { user: 'u2' });
    assert.equal(r.json.chestUnlocked, true);
    r = await ctx.api('POST', '/api/game/chest', { user: 'u2' }); assert.equal(r.status, 200); assert.ok(r.json.chest.coins >= 0);
    assert.equal((await ctx.api('POST', '/api/game/chest', { user: 'u2' })).status, 400);
  });
  it('сезон и приватность: скрытый пользователь пропадает из рейтингов; командная цель только у собственника', async () => {
    let s = await ctx.api('GET', '/api/game/season', { user: 'u1' }); assert.ok(s.json.some((x) => x.userId === 'u3'));
    await ctx.api('PUT', '/api/game/privacy', { user: 'u3', body: { hide: true } });
    s = await ctx.api('GET', '/api/game/season', { user: 'u1' }); assert.ok(!s.json.some((x) => x.userId === 'u3'));
    assert.ok(!(await ctx.api('GET', '/api/leaderboard', { user: 'u1' })).json.some((x) => x.userId === 'u3'));
    assert.equal((await ctx.api('PUT', '/api/admin/team-goal', { user: 'm1', body: { target: 5, prize: 'x' } })).status, 403);
    const r = await ctx.api('PUT', '/api/admin/team-goal', { user: 'o1', body: { target: 5, prize: 'Боулинг всем отделом' } });
    assert.equal(r.json.target, 5);
    assert.equal((await ctx.api('GET', '/api/game', { user: 'u1' })).json.team.prize, 'Боулинг всем отделом');
  });
});

describe('v4: решение — варианты, выбор, план, проверка эффекта', () => {
  let ctx;
  before(async () => { ctx = await boot(); });
  after(async () => { await ctx.app.close(); });
  it('полный цикл: вариант от коллеги → голос → выбор → план → шаги → внедрение → проверка эффекта', async () => {
    let r = await ctx.api('POST', '/api/tickets', { user: 'u1', body: { type: 'problem', categoryId: 'c01', text: 'В заявках на поставку теряются комментарии клиента', solution: 'Добавить поле «комментарий клиента» в заявку' } });
    const id = r.json.id; assert.equal(r.json.options.length, 1); assert.equal(r.json.stage, 'options');
    r = await ctx.api('POST', `/api/tickets/${id}/options`, { user: 'u4', body: { text: 'Прикреплять письмо клиента к заявке автоматически из почты', effect: 'Ноль потерянных комментариев' } });
    assert.equal(r.status, 201); assert.equal(r.json.options.length, 2);
    const opt = r.json.options[1].id;
    r = await ctx.api('POST', `/api/tickets/${id}/options/${opt}/vote`, { user: 'u2' }); assert.equal(r.json.options[1].votesCount, 1);
    assert.equal((await ctx.api('POST', `/api/tickets/${id}/options/${opt}/choose`, { user: 'u2', body: { reason: 'нравится' } })).status, 403);
    assert.equal((await ctx.api('POST', `/api/tickets/${id}/options/${opt}/choose`, { user: 'm1', body: { reason: '' } })).status, 400);
    r = await ctx.api('POST', `/api/tickets/${id}/options/${opt}/choose`, { user: 'm1', body: { reason: 'Автоматизация убирает человеческий фактор' } });
    assert.equal(r.json.status, 'work'); assert.equal(r.json.stage, 'plan'); assert.ok(r.json.options[1].chosen);
    const p4 = (await ctx.api('GET', '/api/profile', { user: 'u4' })).json.ledger;
    assert.ok(p4.some((l) => l.kind === 'optionChosen' && l.ticketId === id));
    r = await ctx.api('POST', `/api/tickets/${id}/steps`, { user: 'm1', body: { text: 'Настроить правило в почте', assigneeId: 'u4', due: new Date(Date.now() + 3 * 864e5).toISOString() } });
    assert.equal(r.status, 201); assert.equal(r.json.stage, 'doing');
    const sid = r.json.plan[0].id;
    assert.equal((await ctx.api('PATCH', `/api/tickets/${id}/steps/${sid}`, { user: 'u2', body: { state: 'done' } })).status, 403);
    const tasks = await ctx.api('GET', '/api/tasks', { user: 'u4' }); assert.ok(tasks.json.steps.some((x) => x.step.id === sid));
    r = await ctx.api('PATCH', `/api/tickets/${id}/steps/${sid}`, { user: 'u4', body: { state: 'done' } });
    assert.equal(r.json.planProgress.pct, 100);
    r = await ctx.api('POST', `/api/tickets/${id}/transition`, { user: 'm1', body: { to: 'done', result: 'Письма прикрепляются автоматически', impact: { metric: 'Потерянных комментариев в месяц', before: '6', after: '0' } } });
    assert.equal(r.json.stage, 'verify'); assert.ok(r.json.verify.dueAt);
    assert.equal((await ctx.api('POST', `/api/tickets/${id}/verify`, { user: 'm1', body: { ok: false } })).status, 400);
    r = await ctx.api('POST', `/api/tickets/${id}/verify`, { user: 'm1', body: { ok: true, after: '0 за месяц' } });
    assert.equal(r.json.stage, 'solved');
  });
  it('эффект не подтвердился → задача возвращается в работу; статистика решений и задачи', async () => {
    let r = await ctx.api('POST', '/api/tickets/A-008/verify', { user: 'm8', body: { ok: false, note: 'Новички всё равно путаются в контактах' } });
    assert.equal(r.status, 200); assert.equal(r.json.status, 'work');
    const s = await ctx.api('GET', '/api/solutions', { user: 'm2' });
    assert.ok(s.json.stages.find((x) => x.id === 'doing').ids.includes('A-003'));
    assert.ok(s.json.overdueSteps.some((x) => x.ticketId === 'A-003'));
    const t = await ctx.api('GET', '/api/tasks', { user: 'm1' }); assert.ok(t.json.steps.length >= 1);
    const d = await ctx.api('GET', '/api/owner/digest', { user: 'o1' }); assert.ok(d.json.solutions && Array.isArray(d.json.solutions.stuckDecisions));
    const ai = await ctx.api('POST', '/api/agent/solutions', { user: 'u1', body: { ticketId: 'A-001' } }); assert.equal(ai.json.source, 'rules');
  });
});
