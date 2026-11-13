'use strict';
/**
 * Telegram-бот МОДУС · СИГНАЛ: long polling, быстрая подача обращения в чате,
 * списки «мои обращения» / «входящие», доставка уведомлений.
 * Запускается только при заданном BOT_TOKEN. Без внешних зависимостей (global fetch).
 */
const core = require('../public/core.js');
const { userByTgId, linkTelegram, safeEqual } = require('./auth.js');

const COMMANDS = [
  { command: 'start', description: 'Открыть МОДУС · СИГНАЛ' },
  { command: 'new', description: 'Быстро сообщить о проблеме или идее' },
  { command: 'my', description: 'Мои обращения' },
  { command: 'inbox', description: 'Входящие обращения (для ответственных)' },
  { command: 'report', description: 'Отчёт ИИ-агента (для собственника)' },
  { command: 'ask', description: 'Вопрос ИИ-агенту (для собственника)' },
  { command: 'help', description: 'Справка' }
];

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Простая конвертация Markdown → безопасный HTML Telegram (заголовки и **жирный**), по строкам. */
function mdLineToHtml(line) {
  const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
  if (h) return '<b>' + esc(h[1].replace(/\*\*/g, '')) + '</b>';
  let x = esc(line.replace(/^(\s*)[-*]\s+/, '$1• '));
  x = x.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>').replace(/__([^_]+?)__/g, '<b>$1</b>');
  return x.replace(/`([^`]+?)`/g, '<code>$1</code>');
}

/** Разбить текст на части ≤ limit символов HTML (теги не разрываются: теги только внутри строк). */
function toTelegramChunks(md, limit = 3900) {
  const lines = [];
  for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
    // слишком длинные строки режем заранее (с запасом на экранирование)
    for (let i = 0; i < Math.max(raw.length, 1); i += 900) lines.push(mdLineToHtml(raw.slice(i, i + 900)));
  }
  const chunks = [];
  let cur = '';
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > limit) { chunks.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + l : l;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.length ? chunks : ['—'];
}

function createBot({ store, cfg, agent = null, log = console, fetchImpl = globalThis.fetch }) {
  const api = `${(cfg.tgApiBase || 'https://api.telegram.org').replace(/\/$/, '')}/bot${cfg.botToken}/`;
  const publicUrl = cfg.publicUrl ? cfg.publicUrl.replace(/\/$/, '') : '';
  const webAppOk = /^https:\/\//i.test(publicUrl);
  const chats = new Map(); // chatId → { step, type, categoryId, text }
  let offset = 0, running = false, pollAbort = null, dispatchTimer = null, dispatching = false;

  async function call(method, params, signal) {
    const r = await fetchImpl(api + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}), signal
    });
    const j = await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
    if (!j.ok) { const e = new Error(`${method}: ${j.description || 'ошибка Telegram API'}`); e.tgCode = j.error_code || r.status; throw e; }
    return j.result;
  }

  const appButton = (text, hash) => webAppOk
    ? [{ text, web_app: { url: publicUrl + '/' + (hash ? '#' + hash : '') } }]
    : null;
  const kb = (rows) => ({ inline_keyboard: rows.filter(Boolean) });
  const send = (chatId, text, rows, extra) => call('sendMessage', Object.assign({
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: rows && rows.filter(Boolean).length ? kb(rows) : undefined
  }, extra || {}));

  const me = (from) => (from ? userByTgId(store.state, from.id) : null);
  const statusLabel = (s) => (core.STATUSES[s] ? core.STATUSES[s].label : s);

  /* ───────── Команды ───────── */

  async function cmdStart(chatId, from) {
    const u = me(from);
    const head = '<b>МОДУС · СИГНАЛ</b>\nВаш голос в улучшениях компании.\n\n' +
      'Сообщите о проблеме, предложите улучшение или поблагодарите коллег — обращение сразу попадёт к ответственному, а вы увидите результат.';
    if (u) {
      return send(chatId, head + `\n\nВы вошли как: <b>${esc(u.name)}</b> (${esc(core.ROLES[u.role] || u.role)}).\n/new — быстрое обращение в чате, /my — мои обращения.`,
        [appButton('Открыть МОДУС · СИГНАЛ'), [{ text: '✦ Новое обращение', callback_data: 'cmd:new' }]]);
    }
    if (cfg.demo) {
      const users = store.state.users;
      const rows = [];
      for (let i = 0; i < users.length; i += 2) {
        rows.push(users.slice(i, i + 2).map((x) => ({ text: x.name.slice(0, 30), callback_data: 'link:' + x.id })));
      }
      return send(chatId, head + '\n\n<i>Демо-режим:</i> выберите роль, под которой хотите войти.', rows);
    }
    return send(chatId, head + '\n\nВаш аккаунт Telegram ещё не привязан к сотруднику. Получите у администратора код и отправьте:\n<code>/link ИД_СОТРУДНИКА КОД</code>',
      [appButton('Открыть МОДУС · СИГНАЛ')]);
  }

  async function cmdLink(chatId, from, args) {
    const [userId, code] = (args || '').trim().split(/\s+/);
    const expected = userId ? process.env['LINK_CODE_' + userId] : '';
    if (!userId || (!cfg.demo && (!expected || !code || !safeEqual(expected, code)))) {
      return send(chatId, 'Неверный идентификатор или код привязки. Формат: <code>/link ИД_СОТРУДНИКА КОД</code>');
    }
    try {
      const u = linkTelegram(core, store.state, userId, from.id);
      store.save();
      return send(chatId, `Готово! Аккаунт привязан: <b>${esc(u.name)}</b>.`, [appButton('Открыть МОДУС · СИГНАЛ')]);
    } catch (e) { return send(chatId, esc(e.message)); }
  }

  async function cmdNew(chatId, from) {
    if (!me(from)) return send(chatId, 'Сначала войдите: /start');
    if (core.triageOn(store.state)) {
      // Упрощённая подача: одно сообщение, категорию и приоритет ставит собственник
      chats.set(chatId, { step: 'text', type: 'problem', quick: true });
      return send(chatId, '<b>Новое обращение</b>\nНапишите одним сообщением, что случилось или что вы предлагаете.', [[{ text: 'Отмена', callback_data: 'new:cancel' }]]);
    }
    chats.set(chatId, { step: 'type' });
    return send(chatId, '<b>Новое обращение</b>\nЧто вы хотите сообщить?', [[
      { text: '⚠ Проблема', callback_data: 'new:type:problem' },
      { text: '✦ Предложение', callback_data: 'new:type:idea' },
      { text: '♥ Отзыв', callback_data: 'new:type:praise' }
    ], [{ text: 'Отмена', callback_data: 'new:cancel' }]]);
  }

  function ticketLine(t) {
    const od = t.overdue ? ' ⏰ <i>' + esc(t.overdue.label) + '</i>' : '';
    return `<b>${esc(t.id)}</b> · ${esc(statusLabel(t.status))}${od}\n${esc(t.title)}`;
  }

  async function cmdMy(chatId, from) {
    const u = me(from);
    if (!u) return send(chatId, 'Сначала войдите: /start');
    const list = core.listTickets(store.state, u.id, { scope: 'mine', sort: 'created' }).slice(0, 10);
    if (!list.length) return send(chatId, 'У вас пока нет обращений. /new — сообщить о проблеме или идее.');
    return send(chatId, '<b>Мои обращения</b>\n\n' + list.map(ticketLine).join('\n\n'), [appButton('Открыть все обращения', '/tickets')]);
  }

  async function cmdInbox(chatId, from) {
    const u = me(from);
    if (!u) return send(chatId, 'Сначала войдите: /start');
    if (!core.isStaff(u)) return send(chatId, 'Раздел «Входящие» доступен ответственным и руководителям.');
    const list = core.listTickets(store.state, u.id, { scope: 'manage', status: 'open', sort: 'due' });
    list.sort((a, b) => (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0));
    if (!list.length) return send(chatId, 'Открытых обращений в вашей зоне ответственности нет. 👍');
    const top = list.slice(0, 15);
    const overdue = list.filter((t) => t.overdue).length;
    return send(chatId, `<b>Входящие</b>: открытых ${list.length}, просрочено ${overdue}\n\n` + top.map(ticketLine).join('\n\n') +
      (list.length > top.length ? `\n\n…и ещё ${list.length - top.length}` : ''), [appButton('Открыть в приложении', '/inbox')]);
  }

  async function sendLong(chatId, md, lastRows) {
    const parts = toTelegramChunks(md);
    for (let i = 0; i < parts.length; i++) await send(chatId, parts[i], i === parts.length - 1 ? lastRows : null);
  }
  const ownerButton = () => [appButton('Открыть панель собственника', '/owner')];
  /** Строка о заявках на награды, ждущих решения (digestText их не включает). */
  function pendingRewardsText() {
    const p = core.ownerDigest(store.state).pendingRewards || [];
    if (!p.length) return '';
    return '\n\n🎁 Ждут подтверждения заявки на награды (' + p.length + '): ' +
      p.map((r) => `${r.user} — «${r.reward}» (${r.cost} монет)`).join('; ') + '.';
  }

  async function cmdReport(chatId, from) {
    const u = me(from);
    if (!u) return send(chatId, 'Сначала войдите: /start');
    if (u.role !== 'owner') return send(chatId, 'Отчёт доступен собственнику.');
    if (!agent) return send(chatId, 'Агент не настроен на сервере.');
    let r = agent.todaysReport();
    if (!r) { await send(chatId, 'Готовлю отчёт…'); r = await agent.generateReport(u.id); }
    const head = `📋 <b>Отчёт ${esc(r.id)}</b> · ${r.health ? 'пульс ' : ''}${esc(r.health ? r.health.score : r.summary.solved)}${r.health ? '/100 — '+esc(r.health.label) : ' решено'}` + (r.source === 'ai' ? ` · ИИ (${esc(r.model)})` : ' · факты из приложения');
    await send(chatId, head);
    return sendLong(chatId, r.text + pendingRewardsText(), ownerButton());
  }

  async function cmdAsk(chatId, from, question) {
    const u = me(from);
    if (!u) return send(chatId, 'Сначала войдите: /start');
    if (!core.isAdmin(u)) return send(chatId, 'Вопросы агенту доступны собственнику и администратору.');
    if (!agent) return send(chatId, 'Агент не настроен на сервере.');
    if (!question || question.trim().length < 2) return send(chatId, 'Напишите вопрос после команды, например:\n<code>/ask Кто тормозит обращения на этой неделе?</code>');
    await send(chatId, 'Думаю…');
    try {
      const a = await agent.ask(question.trim());
      return sendLong(chatId, a.text, ownerButton());
    } catch (e) { return send(chatId, '⚠ ' + esc(e.message)); }
  }

  /** Полный текст ежедневного отчёта — собственникам с привязанным Telegram. */
  async function sendReportToOwners(r) {
    const owners = store.state.users.filter((x) => x.role === 'owner' && x.tgId);
    for (const o of owners) {
      try {
        await send(o.tgId, `📋 <b>Ежедневный отчёт агента</b> · ${r.health ? 'пульс ' : ''}${esc(r.health ? r.health.score : r.summary.solved)}${r.health ? '/100 — '+esc(r.health.label) : ' решено'}`);
        await sendLong(o.tgId, r.text + pendingRewardsText(), ownerButton());
      } catch (e) { log.warn('[bot] отчёт собственнику не доставлен:', e.message); }
    }
    return owners.length;
  }

  function cmdHelp(chatId) {
    return send(chatId, '<b>МОДУС · СИГНАЛ</b> — ваш голос в улучшениях компании.\n\n' +
      '/new — быстро сообщить о проблеме, предложить улучшение или оставить отзыв\n' +
      '/my — последние 10 моих обращений и их статусы\n' +
      '/inbox — входящие обращения (для ответственных)\n' +
      '/report — отчёт ИИ-агента, /ask вопрос — спросить агента (для собственника)\n' +
      '/start — главное меню и вход\n\n' +
      'Полная версия — кнопка «Сигнал» слева от поля ввода.', [appButton('Открыть МОДУС · СИГНАЛ')]);
  }

  /* ───────── Пошаговая подача ───────── */

  async function askCategory(chatId) {
    const cats = store.state.categories;
    const rows = [];
    for (let i = 0; i < cats.length; i += 2) rows.push(cats.slice(i, i + 2).map((c) => ({ text: c.name.slice(0, 32), callback_data: 'new:cat:' + c.id })));
    rows.push([{ text: 'Отмена', callback_data: 'new:cancel' }]);
    return send(chatId, 'Выберите категорию:', rows);
  }

  async function finish(chatId, from, conv) {
    const u = me(from);
    chats.delete(chatId);
    if (!u) return send(chatId, 'Сначала войдите: /start');
    try {
      const t = core.createTicket(store.state, u.id, {
        type: conv.type, categoryId: conv.categoryId, text: conv.text, solution: conv.solution || '', source: 'bot'
      });
      store.save();
      const view = core.getTicket(store.state, u.id, t.id);
      if (core.triageOn(store.state)) return send(chatId, `✅ Обращение <b>${esc(t.id)}</b> получено.\nСобственник решит, брать ли его в работу — вы получите уведомление.`, [appButton('Открыть обращение', '/t/' + t.id)]);
      return send(chatId, `✅ Обращение <b>${esc(t.id)}</b> зарегистрировано.\n` +
        `Ответственный: <b>${esc(view.assigneeName)}</b>\n` +
        `Первый ответ — до <b>${esc(core.fmtDate(t.respondDue))}</b>`, [appButton('Открыть обращение', '/t/' + t.id)]);
    } catch (e) {
      return send(chatId, '⚠ ' + esc(e.message) + '\nПопробуйте ещё раз: /new');
    }
  }

  async function onText(chatId, from, text) {
    const conv = chats.get(chatId);
    if (!conv) return send(chatId, 'Чтобы отправить обращение, нажмите /new. Справка — /help.');
    if (conv.step === 'text') {
      if (text.trim().length < (conv.quick ? 10 : 15)) return send(chatId, 'Опишите ситуацию подробнее — не менее ' + (conv.quick ? 10 : 15) + ' символов.');
      conv.text = text.trim();
      if (conv.quick) return finish(chatId, from, conv);
      if (conv.type === 'praise') return finish(chatId, from, conv);
      conv.step = 'solution';
      if (conv.type === 'idea') return send(chatId, 'Предложите вариант решения: что и как стоит изменить?');
      return send(chatId, 'Есть вариант решения? Напишите его или нажмите «Пропустить».', [[{ text: 'Пропустить', callback_data: 'new:skip' }]]);
    }
    if (conv.step === 'solution') {
      if (conv.type === 'idea' && store.state.settings.solutionRequiredForIdeas && text.trim().length < 10) {
        return send(chatId, 'Для предложения опишите решение чуть подробнее (не менее 10 символов).');
      }
      conv.solution = text.trim();
      return finish(chatId, from, conv);
    }
    return send(chatId, 'Выберите вариант кнопкой выше или начните заново: /new');
  }

  async function onCallback(q) {
    const chatId = q.message && q.message.chat.id;
    const data = q.data || '';
    call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (!chatId) return;
    if (data.startsWith('link:')) {
      if (!cfg.demo) return send(chatId, 'Выбор роли доступен только в демо-режиме.');
      try {
        const u = linkTelegram(core, store.state, data.slice(5), q.from.id);
        store.save();
        return send(chatId, `Вы вошли как <b>${esc(u.name)}</b> (${esc(core.ROLES[u.role] || u.role)}).\n/new — новое обращение, /my — мои обращения` +
          (core.isStaff(u) ? ', /inbox — входящие' + (core.isAdmin(u) ? ', /report — отчёт агента.' : '.') : '.'), [appButton('Открыть МОДУС · СИГНАЛ')]);
      } catch (e) { return send(chatId, esc(e.message)); }
    }
    if (data.startsWith('tri:')) return onTriage(chatId, q, data);
    if (data === 'cmd:new') return cmdNew(chatId, q.from);
    if (data === 'new:cancel') { chats.delete(chatId); return send(chatId, 'Отменено. /new — начать заново.'); }
    const conv = chats.get(chatId);
    if (!conv) return send(chatId, 'Сессия устарела. Начните заново: /new');
    if (data.startsWith('new:type:') && conv.step === 'type') {
      const type = data.slice(9);
      if (!core.TYPES[type]) return;
      conv.type = type; conv.step = 'category';
      return askCategory(chatId);
    }
    if (data.startsWith('new:cat:') && conv.step === 'category') {
      const id = data.slice(8);
      const c = store.state.categories.find((x) => x.id === id);
      if (!c) return askCategory(chatId);
      conv.categoryId = id; conv.step = 'text';
      return send(chatId, `Категория: <b>${esc(c.name)}</b>\nОпишите ситуацию: что происходит, где и как часто (не менее 15 символов).`);
    }
    if (data === 'new:skip' && conv.step === 'solution' && conv.type !== 'idea') return finish(chatId, q.from, conv);
  }

  /** Кнопки собственника под новым обращением: «В работу» / «В корзину». */
  const triageRows = (id) => [[{ text: '✅ В работу', callback_data: 'tri:ok:' + id }, { text: '🗑 В корзину', callback_data: 'tri:no:' + id }], appButton('Открыть ' + id, '/t/' + id)];
  async function onTriage(chatId, q, data) {
    const u = me(q.from);
    if (!u || !core.isTriager(store.state, u)) return send(chatId, 'Разбирать входящие может только собственник или его заместитель.');
    const parts = data.split(':'), act = parts[1], id = parts.slice(2).join(':');
    try {
      if (act !== 'ok' && act !== 'no') return send(chatId, 'Неизвестное действие. Откройте обращение в приложении.');
      const ticket = core.getTicket(store.state, u.id, id);
      if (!core.triageOn(store.state) || ticket.status !== 'new' || !ticket.pending) return send(chatId, 'Обращение уже разобрано. Откройте карточку, чтобы увидеть текущий статус.', [appButton('Открыть ' + id, '/t/' + encodeURIComponent(id))]);
      if (!webAppOk) return send(chatId, 'Для выбора параметров нужна HTTPS-ссылка приложения. Администратор должен настроить PUBLIC_URL. Обращение остаётся во входящих.');
      const accept = act === 'ok';
      const label = accept ? 'Выбрать ответственного и срок' : 'Выбрать причину';
      const action = accept ? 'accept' : 'trash';
      return send(chatId, `<b>${esc(id)}</b> · ${accept ? 'Назначьте ответственного и срок, затем подтвердите приём в работу.' : 'Укажите причину отправки в корзину.'}\nОбращение остаётся во входящих до подтверждения.`, [appButton(label, '/t/' + encodeURIComponent(id) + '?triage=' + action)]);
    } catch (e) {
      return send(chatId, '⚠ ' + esc(e.message));
    }
  }

  async function handleUpdate(upd) {
    try {
      if (upd.callback_query) return await onCallback(upd.callback_query);
      const m = upd.message;
      if (!m || !m.chat || m.chat.type !== 'private' || !m.text) return;
      const chatId = m.chat.id;
      const cmd = m.text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
      if (cmd) {
        const name = cmd[1].toLowerCase();
        if (name !== 'new') chats.delete(chatId);
        if (name === 'start') return await cmdStart(chatId, m.from);
        if (name === 'new') return await cmdNew(chatId, m.from);
        if (name === 'my') return await cmdMy(chatId, m.from);
        if (name === 'inbox') return await cmdInbox(chatId, m.from);
        if (name === 'link') return await cmdLink(chatId, m.from, cmd[2]);
        if (name === 'report') return await cmdReport(chatId, m.from);
        if (name === 'ask') return await cmdAsk(chatId, m.from, cmd[2]);
        return await cmdHelp(chatId);
      }
      return await onText(chatId, m.from, m.text);
    } catch (e) {
      log.warn('[bot] ошибка обработки update:', e.message);
    }
  }

  /* ───────── Доставка уведомлений ───────── */

  async function dispatchOnce() {
    if (dispatching) return 0;
    dispatching = true;
    let changed = 0;
    try {
      const state = store.state;
      const pending = state.notifications.filter((n) => n.delivered === false).slice(0, 25);
      for (const n of pending) {
        const u = state.users.find((x) => x.id === n.userId);
        if (!u || !u.tgId) { n.delivered = true; changed++; continue; }
        try {
          const tk = n.kind === 'triage' && n.ticketId ? state.tickets.find((x) => x.id === n.ticketId) : null;
          if (tk && tk.status === 'new' && core.isTriager(state, u)) {
            const who = tk.external ? (tk.contact && (tk.contact.name || tk.contact.phone) ? [tk.contact.name, tk.contact.phone].filter(Boolean).join(', ') : 'без контакта') : '';
            await send(u.tgId, '🔔 ' + esc(n.text) + '\n\n' + esc(tk.text.slice(0, 700)) + (who ? '\n\n<i>Автор: ' + esc(who) + '</i>' : '') + (tk.attachments && tk.attachments.length ? '\n📎 Вложений: ' + tk.attachments.length : ''), triageRows(tk.id));
          } else
          await send(u.tgId, '🔔 ' + esc(n.text), n.ticketId ? [appButton('Открыть ' + n.ticketId, '/t/' + n.ticketId)] : [appButton('Открыть МОДУС · СИГНАЛ')]);
          n.delivered = true; changed++;
        } catch (e) {
          // 400/403 — чат недоступен или бот заблокирован: повторять бессмысленно
          if (e.tgCode === 400 || e.tgCode === 403) { n.delivered = true; changed++; }
          log.warn('[bot] не удалось доставить уведомление', n.id, e.message);
          if (e.tgCode === 429) break;
        }
      }
      if (changed && store.state === state) store.save();
    } catch (e) {
      log.warn('[bot] ошибка рассылки:', e.message);
    } finally { dispatching = false; }
    return changed;
  }

  /* ───────── Жизненный цикл ───────── */

  async function setup() {
    try {
      await call('setMyCommands', { commands: COMMANDS });
      if (webAppOk) await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Сигнал', web_app: { url: publicUrl + '/' } } });
      else log.warn('[bot] PUBLIC_URL не задан или не https — кнопка Mini App не будет установлена');
    } catch (e) { log.warn('[bot] настройка бота:', e.message); }
  }

  async function pollLoop() {
    let backoff = 1000;
    while (running) {
      try {
        pollAbort = new AbortController();
        const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, pollAbort.signal);
        backoff = 1000;
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          await handleUpdate(u);
        }
      } catch (e) {
        if (!running) break;
        log.warn(`[bot] getUpdates: ${e.message}; повтор через ${backoff / 1000} с`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  return {
    get running() { return running; },
    async start() {
      if (running) return;
      running = true;
      await setup();
      pollLoop();
      dispatchTimer = setInterval(dispatchOnce, cfg.dispatchMs || 15000);
      dispatchOnce();
      log.info('[bot] Telegram-бот запущен (long polling)');
    },
    stop() {
      running = false;
      if (pollAbort) pollAbort.abort();
      if (dispatchTimer) clearInterval(dispatchTimer);
    },
    dispatchOnce, handleUpdate, sendReportToOwners,
    _chats: chats
  };
}

module.exports = { createBot, esc, COMMANDS, toTelegramChunks, mdLineToHtml };
