'use strict';
/**
 * МОДУС · СИГНАЛ — HTTP-сервер: статика из public/, REST API под /api,
 * SQLite-хранилище, планировщик SLA, Telegram-бот и интеграция с Битрикс24.
 * Только встроенные модули Node.js ≥ 22.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/core.js');
const { openStore } = require('./db.js');
const auth = require('./auth.js');
const { createBot } = require('./bot.js');
const { createBitrix24 } = require('./integrations/bitrix24.js');
const { createLLM, readLlmConfig } = require('./llm.js');
const { createAgent } = require('./agent.js');
const files = require('./files.js');
const { createPersonalAssistant } = require('./personal-assistant.js');

const ownerReports = require('./owner-reports.js');
const ownerAi = require('./owner-report-ai.js');
const VERSION = '5.0.0';
const BODY_LIMIT = 1024 * 1024;
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json; charset=utf-8'
};

function readConfig(over = {}) {
  const env = process.env;
  const c = {
    port: env.PORT != null && env.PORT !== '' ? Number(env.PORT) : 8080,
    host: env.HOST || '0.0.0.0',
    dataDir: env.DATA_DIR || './data',
    demo: (env.DEMO == null ? '1' : env.DEMO) === '1',
    botToken: env.BOT_TOKEN || '',
    botPolling: env.BOT_POLLING !== '0',
    publicUrl: env.PUBLIC_URL || '',
    tgApiBase: env.TG_API_BASE || 'https://api.telegram.org',
    corsOrigin: env.CORS_ORIGIN || '*',
    b24Webhook: env.B24_WEBHOOK || '',
    b24UserMap: env.B24_USER_MAP || '',
    tickMs: Number(env.TICK_MS) || 10 * 60 * 1000,
    reportHour: env.REPORT_HOUR != null && env.REPORT_HOUR !== '' ? Number(env.REPORT_HOUR) : 9,
    dailyCheckMs: Number(env.DAILY_CHECK_MS) || 60 * 1000,
    llm: null, // переопределение настроек LLM (для тестов); по умолчанию — из окружения
    dispatchMs: Number(env.DISPATCH_MS) || 15000,
    quiet: env.QUIET === '1',
    triage: env.OWNER_TRIAGE !== '0',          // 0 — прежняя схема: обращение сразу уходит ответственному по категории
    publicPerHour: Number(env.PUBLIC_PER_HOUR) || 5, // обращений по ссылке с одного адреса в час
    trustProxy: env.TRUST_PROXY === '1'
  };
  return Object.assign(c, over);
}

/* ───────── Вспомогательное ───────── */

function apiError(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const isStaff = (u) => core.isStaff(u);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > BODY_LIMIT) { reject(apiError(413, 'payload_too_large', 'Слишком большой запрос (максимум 1 МБ)')); req.resume(); return; }
    const chunks = []; let size = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > BODY_LIMIT) { done = true; reject(apiError(413, 'payload_too_large', 'Слишком большой запрос (максимум 1 МБ)')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const v = JSON.parse(raw);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(apiError(400, 'bad_json', 'Ожидается JSON-объект'));
        resolve(v);
      } catch (_) { reject(apiError(400, 'bad_json', 'Некорректный JSON в теле запроса')); }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function fmtCsvDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // защита от CSV-инъекций в Excel
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function ticketFilters(q) {
  const f = {};
  for (const k of ['scope', 'status', 'type', 'categoryId', 'dept', 'priority', 'q', 'sort', 'from', 'to', 'paei', 'zone', 'quadrant', 'stage', 'box', 'entryId', 'assigneeId']) {
    if (q.get(k)) f[k] = q.get(k);
  }
  if (q.get('overdue') === '1' || q.get('overdue') === 'true') f.overdue = true;
  if (q.get('my') === '1') f.my = true;
  return f;
}

/* ───────── Сервер ───────── */

function start(overrides = {}) {
  const cfg = readConfig(overrides);
  const log = cfg.quiet ? { info() {}, warn() {}, error: console.error } : console;
  const store = openStore(path.resolve(cfg.dataDir), log, { triage: cfg.triage });
  const b24 = createBitrix24({ webhook: cfg.b24Webhook, userMap: cfg.b24UserMap, log });
  const llm = createLLM(cfg.llm || readLlmConfig());
  const assistant = createPersonalAssistant({ core, env: cfg.assistantEnv || process.env, fetchImpl: cfg.assistantFetchImpl || globalThis.fetch });
  const assistantPending = new Set(), assistantRates = new Map();
  const agent = createAgent({ store, llm, log, reportHour: cfg.reportHour });
  const bot = cfg.botToken && cfg.botPolling ? createBot({ store, cfg, agent, log }) : null;
  if (bot) agent.onDaily((r) => bot.sendReportToOwners(r));

  /* Маршруты: [метод, шаблон, обработчик, опции { auth=true, mutate=false }] */
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false, mutate: !!opts.mutate, raw: !!opts.raw });
  };
  const S = () => store.state;
  const staffOnly = (me) => { if (!isStaff(me)) throw apiError(403, 'forbidden', 'Раздел доступен руководителям и администраторам'); };
  const adminOnly = (me) => { if (!core.isAdmin(me)) throw apiError(403, 'forbidden', 'Только собственник или администратор'); };

  route('GET', '/api/health', () => ({ ok: true, mode: 'server', demo: cfg.demo, version: VERSION, bot: !!(bot && bot.running), llm: llm.info, assistant: assistant.info }), { auth: false });

  route('GET', '/api/assistant/info', ({ me }) => {
    assistant.revalidate(S(), me.id, {});
    return assistant.info;
  });
  route('POST', '/api/assistant/ask', async ({ req, me, body }) => {
    // No mutable route flag: the provider wait must never roll back company state.
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw apiError(415, 'content_type', 'Ожидается JSON');
    if (assistantPending.has(me.id)) throw apiError(429, 'ai_in_progress', 'Дождитесь ответа на предыдущий вопрос');
    const prepared = assistant.prepare(S(), me.id, body), now = Date.now();
    for (const [id, value] of assistantRates) if (value.until <= now) assistantRates.delete(id);
    const rate = assistantRates.get(me.id) || { count: 0, until: now + 60000 };
    if (rate.count >= 10) throw apiError(429, 'rate_limited', 'Слишком много вопросов. Подождите минуту');
    rate.count++; assistantRates.set(me.id, rate); assistantPending.add(me.id);
    try {
      const result = await assistant.complete(prepared);
      const current = auth.authenticate(req, S(), cfg).me;
      if (current.id !== me.id) throw apiError(401, 'unauthorized', 'Войдите в систему');
      assistant.revalidate(S(), current.id, body);
      return result;
    } finally { assistantPending.delete(me.id); }
  });

  route('GET', '/api/bootstrap', ({ me, via }) => Object.assign(core.bootstrap(S(), me.id), { auth: via, demo: cfg.demo }));

  route('GET', '/api/tickets', ({ me, query }) => core.listTickets(S(), me.id, ticketFilters(query)));

  route('POST', '/api/tickets', ({ me, body, via }) => {
    const data = Object.assign({}, body, { source: via === 'tma' ? 'tma' : 'web' });
    const t = core.createTicket(S(), me.id, data);
    return { status: 201, body: core.getTicket(S(), me.id, t.id) };
  }, { mutate: true });

  route('GET', '/api/tickets/:id', ({ me, params }) => core.getTicket(S(), me.id, params.id));

  route('POST', '/api/tickets/:id/transition', ({ me, params, body }) => {
    const t = S().tickets.find((x) => x.id === params.id);
    const from = t ? t.status : null;
    core.transition(S(), me.id, params.id, body.to, {
      comment: body.comment, result: body.result, rejectReason: body.rejectReason, impact: body.impact
    });
    return { body: core.getTicket(S(), me.id, params.id), after: () => b24.onTransition(store, params.id, from, body.to) };
  }, { mutate: true });

  /* ───────── Фильтр собственника и доска ───────── */
  route('POST', '/api/tickets/:id/accept', ({ me, params, body }) => {
    core.accept(S(), me.id, params.id, { assigneeId: body.assigneeId, categoryId: body.categoryId, priority: body.priority, due: body.due, collectUntil: body.collectUntil, voteUntil: body.voteUntil, dueDays: body.dueDays });
    return core.getTicket(S(), me.id, params.id);
  }, { mutate: true });
  route('POST', '/api/tickets/:id/trash', ({ me, params, body }) => { core.toTrash(S(), me.id, params.id, body.reason); return core.getTicket(S(), me.id, params.id); }, { mutate: true });
  route('POST', '/api/tickets/:id/restore', ({ me, params }) => { core.restore(S(), me.id, params.id); return core.getTicket(S(), me.id, params.id); }, { mutate: true });
  route('POST', '/api/tickets/:id/move', ({ me, params, body }) => {
    const t = S().tickets.find((x) => x.id === params.id);
    const from = t ? t.status : null;
    core.moveCard(S(), me.id, params.id, body.col, { comment: body.comment, result: body.result, impact: body.impact, after: body.after });
    const to = (S().tickets.find((x) => x.id === params.id) || {}).status;
    return { body: core.getTicket(S(), me.id, params.id), after: () => { if (to && to !== from) b24.onTransition(store, params.id, from, to); } };
  }, { mutate: true });

  /* ───────── Точки входа: ссылки и QR-коды ───────── */
  route('GET', '/api/admin/entries', ({ me }) => core.listEntries(S(), me.id));
  route('POST', '/api/admin/entries', ({ me, body }) => ({ status: 201, body: core.saveEntry(S(), me.id, null, body) }), { mutate: true });
  route('PUT', '/api/admin/entries/:id', ({ me, params, body }) => core.saveEntry(S(), me.id, params.id, body), { mutate: true });

  /* ───────── Публичная часть: форма по ссылке без входа ───────── */
  const hits = new Map();
  const clientIp = (req) => {
    const fwd = cfg.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
  };
  /** Не больше max действий вида kind с одного адреса за час. */
  function rateLimit(req, kind, max) {
    const key = kind + '|' + clientIp(req), now = Date.now();
    const list = (hits.get(key) || []).filter((x) => now - x < 3600 * 1000);
    if (list.length >= max) throw apiError(429, 'too_many', 'Слишком много запросов с вашего устройства. Попробуйте через час');
    list.push(now); hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => now - x < 3600 * 1000)) hits.delete(k);
  }
  route('GET', '/api/public/entry/:code', ({ req, params }) => { rateLimit(req, 'entry', 120); return core.publicEntry(S(), params.code); }, { auth: false });
  route('POST', '/api/public/tickets', ({ req, body }) => {
    // Скрытое поле-ловушка: человек его не видит и не заполняет, бот — заполняет
    if (String(body.website || '').trim()) return { status: 201, body: { id: 'A-000', trackCode: '', entryName: '' } };
    rateLimit(req, 'ticket', cfg.publicPerHour);
    const out = core.createPublicTicket(S(), String(body.code || ''), { text: body.text, attachments: body.attachments, contactName: body.contactName, contactPhone: body.contactPhone });
    return { status: 201, body: out };
  }, { auth: false, mutate: true });
  route('POST', '/api/public/files', ({ req, query }) => {
    try { const e = core.publicEntry(S(), query.get('code') || ''); if (!e.active) throw apiError(403, 'forbidden', 'Ссылка отключена'); rateLimit(req, 'file', cfg.publicPerHour * 10); }
    catch (e) { req.resume(); throw e; }
    return files.upload(req, store, null);
  }, { auth: false, raw: true });
  route('GET', '/api/public/track/:code', ({ req, params }) => { rateLimit(req, 'track', 120); return core.trackTicket(S(), params.code); }, { auth: false });

  route('POST', '/api/tickets/:id/comments', ({ me, params, body }) => {
    const before = (S().tickets.find((x) => x.id === params.id) || {}).status;
    core.addComment(S(), me.id, params.id, body.text, { internal: !!body.internal, clarify: !!body.clarify });
    const after = (S().tickets.find((x) => x.id === params.id) || {}).status;
    return { body: core.getTicket(S(), me.id, params.id), after: before !== after ? () => b24.onTransition(store, params.id, before, after) : null };
  }, { mutate: true });

  route('POST', '/api/tickets/:id/assign', ({ me, params, body }) => {
    core.assign(S(), me.id, params.id, body.userId);
    return core.getTicket(S(), me.id, params.id);
  }, { mutate: true });

  route('POST', '/api/tickets/:id/priority', ({ me, params, body }) => {
    core.setPriority(S(), me.id, params.id, body.priority);
    return core.getTicket(S(), me.id, params.id);
  }, { mutate: true });

  route('POST', '/api/tickets/:id/vote', ({ me, params }) => {
    core.vote(S(), me.id, params.id);
    return core.getTicket(S(), me.id, params.id);
  }, { mutate: true });

  route('POST', '/api/tickets/:id/claim', ({ me, params }) => {
    const before = (S().tickets.find((x) => x.id === params.id) || {}).status;
    core.claim(S(), me.id, params.id);
    const after = (S().tickets.find((x) => x.id === params.id) || {}).status;
    return { body: core.getTicket(S(), me.id, params.id), after: before !== after ? () => b24.onTransition(store, params.id, before, after) : null };
  }, { mutate: true });

  route('POST', '/api/tickets/:id/nudge', ({ me, params }) => {
    core.nudge(S(), me.id, params.id);
    return core.getTicket(S(), me.id, params.id);
  }, { mutate: true });

  /* Решение: варианты → выбор → план → проверка эффекта */
  const T = (me, id) => core.getTicket(S(), me.id, id);
  route('POST', '/api/tickets/:id/options', ({ me, params, body }) => { core.proposeOption(S(), me.id, params.id, body); return { status: 201, body: T(me, params.id) }; }, { mutate: true });
  route('POST', '/api/tickets/:id/options/:oid/vote', ({ me, params }) => { core.voteOption(S(), me.id, params.id, params.oid); return T(me, params.id); }, { mutate: true });
  route('POST', '/api/tickets/:id/team/pass', ({ me, params, body }) => { core.teamPass(S(), me.id, params.id, body.note); return T(me, params.id); }, { mutate: true });
  route('POST', '/api/tickets/:id/team/advance', ({ me, params }) => { core.advanceTeam(S(), me.id, params.id); return T(me, params.id); }, { mutate: true });
  route('POST', '/api/tickets/:id/team/deadlines', ({ me, params, body }) => { core.setTeamDeadlines(S(), me.id, params.id, body); return T(me, params.id); }, { mutate: true });
  route('POST', '/api/tickets/:id/options/:oid/choose', ({ me, params, body }) => {
    const before = (S().tickets.find((x) => x.id === params.id) || {}).status;
    core.chooseOption(S(), me.id, params.id, params.oid, body.reason);
    const after = (S().tickets.find((x) => x.id === params.id) || {}).status;
    return { body: T(me, params.id), after: before !== after ? () => b24.onTransition(store, params.id, before, after) : null };
  }, { mutate: true });
  route('POST', '/api/tickets/:id/steps', ({ me, params, body }) => { core.addStep(S(), me.id, params.id, body); return { status: 201, body: T(me, params.id) }; }, { mutate: true });
  route('PATCH', '/api/tickets/:id/steps/:sid', ({ me, params, body }) => { core.setStep(S(), me.id, params.id, params.sid, body); return T(me, params.id); }, { mutate: true });
  route('POST', '/api/tickets/:id/verify', ({ me, params, body }) => { core.verifyEffect(S(), me.id, params.id, body); return T(me, params.id); }, { mutate: true });
  route('GET', '/api/tasks', ({ me }) => core.myTasks(S(), me.id));
  route('GET', '/api/solutions', () => core.solutionStats(S()));
  route('POST', '/api/agent/solutions', async ({ me, params, body }) => {
    const t = S().tickets.find((x) => x.id === String(body.ticketId || ''));
    if (!t) throw apiError(404, 'not_found', 'Обращение не найдено');
    if (!llm.configured) return { options: [], source: 'rules', similar: core.similarSolved(S(), t) };
    try {
      const r = await llm.complete(core.solutionPrompt(t, core.similarSolved(S(), t)));
      const m = r.text.match(/\[[\s\S]*\]/);
      const arr = m ? JSON.parse(m[0]) : [];
      const options = (Array.isArray(arr) ? arr : []).slice(0, 3).map((o) => ({ text: String(o.text || '').slice(0, 800), effect: String(o.effect || '').slice(0, 200), cost: String(o.cost || '').slice(0, 100) })).filter((o) => o.text.length >= 10);
      return { options, source: 'ai', model: r.model };
    } catch (e) { return { options: [], source: 'rules', error: e.message }; }
  });

  /* Игра: задания недели, сундуки, серии, сезоны и лиги, командная цель */
  route('GET', '/api/game', ({ me }) => core.gameState(S(), me.id));
  route('GET', '/api/game/season', () => core.seasonBoard(S()));
  route('POST', '/api/game/quests/:id/claim', ({ me, params }) => core.claimQuest(S(), me.id, params.id), { mutate: true });
  route('POST', '/api/game/chest', ({ me }) => core.openChest(S(), me.id), { mutate: true });
  route('POST', '/api/game/streak', ({ me }) => core.claimStreak(S(), me.id), { mutate: true });
  route('PUT', '/api/game/privacy', ({ me, body }) => core.setHideRating(S(), me.id, !!body.hide), { mutate: true });
  route('PUT', '/api/admin/team-goal', ({ me, body }) => core.setTeamGoal(S(), me.id, body.target, body.prize), { mutate: true });

  /* Методики: Адизес (PAEI, CAPI), Кови (круг влияния, матрица), Карнеги (тон, благодарности) */
  route('POST', '/api/tickets/:id/classify', ({ me, params, body }) => {
    core.classify(S(), me.id, params.id, { paei: body.paei, zone: body.zone, important: body.important });
    return core.getTicket(S(), me.id, params.id);
  }, { mutate: true });
  route('GET', '/api/method', () => core.methodStats(S()));
  route('POST', '/api/kudos', ({ me, body }) => ({ status: 201, body: core.kudos(S(), me.id, body.toUserId, body.text) }), { mutate: true });
  route('POST', '/api/tone/check', ({ body }) => core.carnegieCheck(String(body.text || ''), String(body.kind || '')));
  route('POST', '/api/agent/rewrite', async ({ me, body }) => {
    staffOnly(me);
    const text = String(body.text || '').slice(0, 2000), kind = String(body.kind || '');
    if (text.trim().length < 3) throw apiError(400, 'validation', 'Пустой текст');
    if (!llm.configured) return { text: null, source: 'rules', check: core.carnegieCheck(text, kind) };
    const prompt = 'Перепиши ответ руководителя сотруднику по принципам Дейла Карнеги: начни с искренней благодарности, говори о ситуации, а не о человеке, дай сохранить лицо, ' +
      (kind === 'rejected' ? 'объясни причину отказа и предложи альтернативу или условие возврата к идее. ' : kind === 'clarify' ? 'сформулируй уточнение как вежливую просьбу с конкретным вопросом. ' : 'поблагодари и коротко зафиксируй итог. ') +
      'Сохрани смысл и факты, не выдумывай новых. 2–4 предложения, по-русски, без кавычек и пояснений — только текст ответа.\n\nИсходный текст: ' + text;
    try { const r = await llm.complete(prompt); return { text: r.text.trim(), source: 'ai', model: r.model }; }
    catch (e) { return { text: null, source: 'rules', error: e.message, check: core.carnegieCheck(text, kind) }; }
  });

  /* Файлы: загрузка «сырым» телом (до 25 МБ), выдача без авторизации по неугадываемому id */
  route('POST', '/api/files', ({ req, me }) => files.upload(req, store, me), { raw: true });
  route('GET', '/api/files/:id', ({ req, res, params }) => files.serve(req, res, store, params.id), { auth: false });

  /* Общий чат */
  route('GET', '/api/chat', ({ me, query }) => core.listChat(S(), me.id, { after: query.get('after') || undefined, limit: Math.min(Number(query.get('limit')) || 200, 500) }));
  route('POST', '/api/chat', ({ me, body }) => {
    const m = core.postChat(S(), me.id, { text: body.text, files: body.files, replyTo: body.replyTo || null });
    const item = core.listChat(S(), me.id, { limit: 50 }).find((x) => x.id === m.id);
    return { status: 201, body: item };
  }, { mutate: true });

  /* Собственник: дайджест, люди, поощрения, отчёты агента, заявки на награды */
  route('GET', '/api/owner/digest', ({ me }) => { adminOnly(me); return core.ownerDigest(S()); });
  route('GET', '/api/owner/people', ({ me }) => { adminOnly(me); return core.peopleStats(S()); });
  route('POST', '/api/owner/bonus', ({ me, body }) => {
    adminOnly(me);
    const rec = core.bonus(S(), me.id, body.userId, body.amount, body.reason);
    return { status: 201, body: Object.assign({}, rec, { balance: core.balance(S(), rec.userId) }) };
  }, { mutate: true });
  route('GET', '/api/owner/reports', ({ me }) => { if(me.role!=='owner')throw apiError(403,'forbidden','Отчёты доступны собственнику'); return S().reports.slice().reverse(); });
  route('POST', '/api/owner/report', async ({ me }) => { if(me.role!=='owner')throw apiError(403,'forbidden','Отчёты доступны собственнику');if(llm.configured&&!process.env.DEEPSEEK_API_KEY)return {status:201,body:await agent.generateReport(me.id)};const r=await ownerAi.enrichOwnerReport(ownerReports.buildOwnerReport(S(),{now:Date.now()}),{env:process.env});if(!S().users.some(u=>u.id===me.id&&u.role==='owner'&&!u.disabled))throw apiError(403,'forbidden','Доступ изменён');S().reports=S().reports.filter(x=>x.id!==r.id).slice(-119);S().reports.push(r);store.save();return {status:201,body:r}; });
  route('GET','/api/owner/reports/:id/pdf',async({me,params})=>{if(me.role!=='owner')throw apiError(403,'forbidden','Отчёты доступны собственнику');const r=S().reports.find(x=>x.id===params.id&&x.kind==='owner-daily');if(!r)throw apiError(404,'not_found','Отчёт не найден');const bytes=await ownerReports.renderOwnerReportPdf(r,{fontBytes:fs.readFileSync(path.join(PUBLIC_DIR,'vendor/NotoSans-Regular.ttf'))});return {raw:Buffer.from(bytes),headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename=modus-report.pdf'}};});
  route('POST', '/api/agent/ask', async ({ me, body }) => {
    adminOnly(me);
    return agent.ask(body.question, Array.isArray(body.history) ? body.history : []);
  });
  route('GET', '/api/owner/redemptions', ({ me }) => core.listRedemptions(S(), me.id));
  route('POST', '/api/owner/redemptions/:id', ({ me, params, body }) => {
    if (typeof body.approve !== 'boolean') throw apiError(400, 'validation', 'Укажите решение: approve = true или false');
    return core.decideRedemption(S(), me.id, params.id, body.approve, body.note);
  }, { mutate: true });

  /* Магазин мотивации */
  route('GET', '/api/rewards', ({ me }) => core.rewardsView(S(), me.id));
  route('POST', '/api/admin/rewards', ({ me, body }) => ({ status: 201, body: core.updateReward(S(), me.id, null, body) }), { mutate: true });
  route('PUT', '/api/admin/rewards/:id', ({ me, params, body }) => {
    if (!S().rewards.some((r) => r.id === params.id)) throw apiError(404, 'not_found', 'Награда не найдена');
    return core.updateReward(S(), me.id, params.id, body);
  }, { mutate: true });

  route('GET', '/api/similar', ({ me, query }) => core.findSimilar(S(), query.get('text') || '', query.get('exclude') || undefined, me.id));

  route('GET', '/api/analytics', ({ me }) => { staffOnly(me); return core.analytics(S()); });

  route('GET', '/api/leaderboard', () => core.leaderboard(S()));

  route('GET', '/api/profile', ({ me }) => core.profile(S(), me.id, me.id));
  route('GET', '/api/profile/:userId', ({ params, me }) => core.profile(S(), params.userId, me.id));

  route('GET', '/api/notifications', ({ me }) => core.notificationsOf(S(), me.id));
  route('POST', '/api/notifications/read', ({ me, body }) => {
    core.markRead(S(), me.id, Array.isArray(body.ids) ? body.ids.map(String) : undefined);
    return { ok: true, unread: S().notifications.filter((n) => n.userId === me.id && !n.read).length };
  }, { mutate: true });

  route('POST', '/api/rewards/:id/redeem', ({ me, params }) => {
    const rec = core.redeem(S(), me.id, params.id);
    return { status: 201, body: { redemption: rec, balance: core.balance(S(), me.id) } };
  }, { mutate: true });

  route('POST', '/api/admin/categories', ({ me, body }) => {
    adminOnly(me);
    if (!String(body.name || '').trim()) throw apiError(400, 'validation', 'Укажите название категории');
    return { status: 201, body: core.updateCategory(S(), me.id, null, { name: body.name, owner: body.owner, backup: body.backup }) };
  }, { mutate: true });
  route('PUT', '/api/admin/categories/:id', ({ me, params, body }) => core.updateCategory(S(), me.id, params.id, body), { mutate: true });

  route('POST', '/api/admin/users', ({ me, body }) => ({ status: 201, body: core.createUser(S(), me.id, body) }), { mutate: true });

  route('PUT', '/api/admin/users/:id', ({ me, params, body }) => {
    const patch = Object.assign({}, body);
    // Telegram ID привязывается только через /api/tg/link или администратором
    if (!core.isAdmin(me)) delete patch.tgId;
    return core.updateUser(S(), me.id, params.id, patch);
  }, { mutate: true });

  route('PUT', '/api/admin/settings', ({ me, body }) => core.updateSettings(S(), me.id, body), { mutate: true });

  route('POST', '/api/admin/reset', ({ me }) => {
    adminOnly(me);
    if (!cfg.demo) throw apiError(403, 'forbidden', 'Сброс данных доступен только в демо-режиме');
    store.reseed();
    return { ok: true, tickets: S().tickets.length };
  });

  route('POST', '/api/tg/link', ({ req, body }) => {
    const tg = auth.authenticateTelegram(req, cfg);
    const userId = String(body.userId || '');
    if (!userId) throw apiError(400, 'validation', 'Укажите сотрудника');
    if (!cfg.demo) {
      const expected = process.env['LINK_CODE_' + userId];
      if (!expected || !body.code || !auth.safeEqual(expected, String(body.code))) throw apiError(403, 'bad_link_code', 'Неверный код привязки');
    }
    const u = auth.linkTelegram(core, S(), userId, tg.user.id);
    return { ok: true, me: core.bootstrap(S(), u.id).me };
  }, { auth: false, mutate: true });

  route('GET', '/api/export.csv', ({ me, query }) => {
    staffOnly(me);
    const list = core.listTickets(S(), me.id, Object.assign({ sort: 'created' }, ticketFilters(query)));
    const head = ['Номер', 'Тип', 'Категория', 'Автор', 'Подразделение', 'Приоритет', 'Статус', 'Ответственный', 'Создано', 'Первый ответ', 'Закрыто', 'Просрочено', 'Результат/причина отказа', 'Поддержали'];
    const rows = list.map((t) => [
      t.id, (core.TYPES[t.type] || {}).label || t.type, t.categoryName, t.authorName, t.authorDept,
      (core.PRIORITIES[t.priority] || {}).label || t.priority, (core.STATUSES[t.status] || {}).label || t.status,
      t.assigneeName, fmtCsvDate(t.createdAt), fmtCsvDate(t.firstResponseAt), fmtCsvDate(t.closedAt),
      t.overdue ? 'Да: ' + t.overdue.label : 'Нет', t.result || t.rejectReason || '', t.votesCount
    ]);
    const csv = '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      raw: csv, headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="modus-signal-${stamp}.csv"`
      }
    };
  });

  /* ───────── Обработка запросов ───────── */

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', cfg.corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Demo-User, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    if (cfg.corsOrigin !== '*') res.setHeader('Vary', 'Origin');
  }

  function sendJson(res, status, obj, headers) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
    res.end(body);
  }

  async function handleApi(req, res, url) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const p = url.pathname.replace(/\/+$/, '') || '/';
    let r = null, m = null, methodMismatch = false;
    for (const x of routes) {
      const mm = x.re.exec(p);
      if (!mm) continue;
      if (x.method !== req.method) { methodMismatch = true; continue; }
      r = x; m = mm; break;
    }
    if (!r) return sendJson(res, methodMismatch ? 405 : 404, methodMismatch
      ? { error: 'Метод не поддерживается', code: 'method_not_allowed' }
      : { error: 'Метод API не найден', code: 'not_found' });
    let mutated = false;
    try {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const body = !r.raw && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') ? await readBody(req) : {};
      const ctx = { req, res, params, body, query: url.searchParams, me: null, via: null };
      if (r.auth) { const a = auth.authenticate(req, store.state, cfg); ctx.me = a.me; ctx.via = a.via; }
      mutated = r.mutate;
      let out = r.handler(ctx);
      if (out && typeof out.then === 'function') out = await out;
      if (r.mutate) store.save();
      mutated = false;
      if (out && out.handled) return; // ответ уже отправлен обработчиком (файлы)
      if (out && out.raw != null) { res.writeHead(200, out.headers); return res.end(out.raw); }
      let status = 200, payload = out;
      if (out && typeof out === 'object' && ('body' in out) && (('status' in out) || ('after' in out))) {
        status = out.status || 200; payload = out.body;
        if (typeof out.after === 'function') { try { out.after(); } catch (e) { log.warn('[api] after-hook:', e.message); } }
      }
      return sendJson(res, status, payload);
    } catch (e) {
      // Откат частично применённых изменений в памяти к последнему сохранённому состоянию
      if (mutated) { try { store.reload(); } catch (re) { log.error('[db] reload failed', re); } }
      const status = e.status || 500;
      if (status >= 500) log.error('[api]', req.method, p, e);
      if (res.headersSent) { res.destroy(); return; }
      return sendJson(res, status, { error: status >= 500 && !e.status ? 'Внутренняя ошибка сервера' : e.message, code: e.code || 'internal' });
    }
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch (_) { res.writeHead(400); return res.end('Некорректный путь'); }
    if (rel.includes('\0')) { res.writeHead(400); return res.end('Некорректный путь'); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || file.split(path.sep).some((s) => s.startsWith('.') && s.length > 1 && s !== '..')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено');
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': ext === '.html' || ext === '.js' ? 'no-cache' : 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin'
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { res.writeHead(400); return res.end(); }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((e) => { log.error('[api]', e); if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера', code: 'internal' }); });
    } else serveStatic(req, res, url);
  });

  /* ───────── Планировщик SLA ───────── */
  function runTick() {
    try {
      const n0 = store.state.notifications.length, t0 = store.state.tickets.length;
      const escalated = core.tick(store.state, Date.now());
      if (escalated.length || store.state.notifications.length !== n0 || store.state.tickets.length !== t0) store.save();
      if (escalated.length) { log.info('[sla] эскалированы:', escalated.join(', ')); }
      return escalated;
    } catch (e) { log.error('[sla] ошибка планировщика', e); return []; }
  }
  runTick();
  const tickTimer = setInterval(runTick, cfg.tickMs);
  tickTimer.unref();

  /* ───────── Ежедневный отчёт агента ───────── */
  const runDaily = (now) => agent.runDaily(now);
  const dailyTimer = setInterval(() => { runDaily(Date.now()); }, cfg.dailyCheckMs);
  dailyTimer.unref();

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      const addr = server.address();
      log.info(`[http] МОДУС · СИГНАЛ v${VERSION} — http://${cfg.host}:${addr.port} (демо-режим: ${cfg.demo ? 'да' : 'нет'}, бот: ${bot ? 'да' : 'нет'}, ИИ: ${llm.configured ? llm.info.provider + '/' + llm.info.model : 'нет'}, Б24: ${b24.enabled ? 'да' : 'нет'})`);
      if (bot) bot.start().catch((e) => log.warn('[bot] запуск:', e.message));
      resolve(addr.port);
    });
  });

  async function close() {
    clearInterval(tickTimer);
    clearInterval(dailyTimer);
    if (bot) bot.stop();
    await new Promise((r) => { server.close(() => r()); server.closeAllConnections && server.closeAllConnections(); });
    await b24.pending();
    store.close();
  }

  return { server, store, cfg, bot, b24, llm, agent, ready, close, runTick, runDaily };
}

module.exports = { start, readConfig, VERSION };

if (require.main === module) {
  const app = start();
  app.ready.catch((e) => { console.error('Не удалось запустить сервер:', e.message); process.exit(1); });
  const shutdown = () => { console.log('Остановка…'); app.close().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
