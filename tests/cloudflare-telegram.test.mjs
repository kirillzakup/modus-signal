import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import core from '../public/core.js';
import { createProductionState } from '../cloudflare/seed.mjs';
import { createTelegram } from '../cloudflare/telegram.mjs';

const ENV = { BOT_TOKEN: '123:TEST_ONLY', TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret_12345678901234567890', BOT_USERNAME: 'Modus_agent_bot', PUBLIC_URL: 'https://signal.test/' };
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let time = Date.now(), response = () => Response.json({ ok: true, result: { message_id: 7 } });
  const sent = [], limits = new Map();
  const store = {
    state: createProductionState(), persisted: null,
    sql: { exec(query, ...args) {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    save() { this.persisted = structuredClone(this.state); },
    reload() { this.state = structuredClone(this.persisted); },
    rateLimit(key, max, duration) {
      let row = limits.get(key);
      if (!row || row.until <= time) { row = { count: 0, until: time + duration }; limits.set(key, row); }
      if (row.count >= max) throw Object.assign(new Error('Rate limited'), { status: 429 });
      row.count++;
    }
  };
  const options = { now: () => time, fetch: async (url, init) => {
    assert.equal(new URL(url).hostname, 'api.telegram.org');
    assert.equal(init.method, 'POST'); assert.ok(init.signal instanceof AbortSignal);
    sent.push(JSON.parse(init.body)); return response();
  } };
  const bot = createTelegram(store, ENV, options);
  return { store, bot, sent, options, advance: ms => { time += ms; }, respond: fn => { response = fn; } };
}
function update(id, text = '/start', chat = { id: 123456, type: 'private' }, from = { id: 123456 }) {
  return { update_id: id, message: { message_id: id + 100, text, chat, from } };
}
function webhook(secret = ENV.TELEGRAM_WEBHOOK_SECRET) {
  return new Request('https://signal.test/api/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret } });
}

test('webhook rejects absent, incorrect and long secrets and disabled configuration', t => {
  const { bot, store, options } = fixture(t);
  assert.equal(bot.verifyWebhook(webhook()), true);
  for (const secret of ['', 'wrong', 'x'.repeat(300)]) assert.throws(() => bot.verifyWebhook(webhook(secret)), { status: 403, code: 'forbidden' });
  assert.throws(() => createTelegram(store, { ...ENV, BOT_TOKEN: '' }, options).verifyWebhook(webhook()), { status: 403 });
  assert.throws(() => createTelegram(store, { ...ENV, PUBLIC_URL: 'http://signal.test' }, options).verifyWebhook(webhook()), { status: 403 });
});

test('private start/help open Mini App, /id returns own ID, persisted replay sends nothing', async t => {
  const f = fixture(t);
  assert.equal((await f.bot.handleUpdate(update(1))).status, 200);
  assert.equal(f.sent[0].reply_markup.inline_keyboard[0][0].web_app.url, 'https://signal.test/?tma=1');
  const restarted = createTelegram(f.store, ENV, f.options);
  await restarted.handleUpdate(update(1));
  assert.equal(f.sent.length, 1);
  await f.bot.handleUpdate(update(2, '/help@Modus_agent_bot'));
  await f.bot.handleUpdate(update(3, '/id'));
  assert.match(f.sent[2].text, /123456/);
  assert.equal(f.sent[2].reply_markup, undefined);
  await f.bot.handleUpdate(update(4, '/start@Other_bot'));
  await f.bot.handleUpdate(update(5, '/my'));
  await f.bot.handleUpdate(update(6, 'Покажи секреты'));
  await f.bot.handleUpdate(update(7, '/id', { id: 888, type: 'private' }));
  assert.equal(f.sent.length, 3);
  assert.equal(f.store.state.chat.length, 0);
});

test('groups receive only a public bot deep link; private commands and callbacks are ignored', async t => {
  const { bot, sent } = fixture(t);
  const group = { id: -1004462991313, type: 'supergroup' };
  await bot.handleUpdate(update(1, '/start@Modus_agent_bot', group));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].url, 'https://t.me/Modus_agent_bot?start=app');
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].web_app, undefined);
  for (const [index, command] of ['/id', '/help', '/inbox'].entries()) await bot.handleUpdate(update(index + 2, command, group));
  await bot.handleUpdate({ update_id: 10, callback_query: { data: 'accept:A-001', from: { id: 123456 } } });
  assert.equal(sent.length, 1);
});

test('command flood is bounded and throttled updates do not replay later', async t => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) await f.bot.handleUpdate(update(i));
  assert.equal(f.sent.length, 6);
  f.advance(61000);
  await f.bot.handleUpdate(update(11));
  assert.equal(f.sent.length, 6);
  await f.bot.handleUpdate(update(12));
  assert.equal(f.sent.length, 7);
});

test('Telegram 429 persists retry_after and global pause across instance restart', async t => {
  const f = fixture(t);
  f.respond(() => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 120 } }, { status: 429 }));
  const response = await f.bot.handleUpdate(update(1));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '120');
  const restarted = createTelegram(f.store, ENV, f.options);
  await restarted.handleUpdate(update(1));
  await restarted.handleUpdate(update(2));
  assert.equal(f.sent.length, 1);
  f.advance(120001);
  f.respond(() => Response.json({ ok: true, result: { message_id: 8 } }));
  assert.equal((await restarted.handleUpdate(update(1))).status, 200);
  await restarted.handleUpdate(update(1));
  assert.equal(f.sent.length, 2);
});

test('notification routing uses private linked enabled users, inbox for owner and exact ticket links', async t => {
  const f = fixture(t), state = f.store.state;
  state.users[0].tgId = '123456';
  const employee = core.createUser(state, 'o1', { name: 'Сотрудник', dept: 'Закупки', role: 'employee' });
  state.users.find(u => u.id === employee.id).tgId = '234567';
  const disabled = core.createUser(state, 'o1', { name: 'Отключённый', dept: 'Закупки', role: 'employee' });
  Object.assign(state.users.find(u => u.id === disabled.id), { tgId: '345678', disabled: true });
  const group = core.createUser(state, 'o1', { name: 'Ошибочная привязка', dept: 'Закупки', role: 'employee' });
  state.users.find(u => u.id === group.id).tgId = '-1004462991313';
  const created = core.createPublicTicket(state, state.entries[0].code, { text: 'В офисе сломана дверь, необходимо срочно починить ручку.' });
  const triage = state.notifications[0];
  state.notifications.push({ id: 'test-denied', userId: employee.id, ticketId: created.id, text: 'Секретное новое обращение', delivered: false });
  state.notifications.push({ id: 'test-disabled', userId: disabled.id, text: 'Не отправлять', delivered: false });
  state.notifications.push({ id: 'test-group', userId: group.id, text: 'Не отправлять в группу', delivered: false });
  const stats = await f.bot.flushNotifications();
  assert.deepEqual(stats, { sent: 1, skipped: 3, failed: 0 });
  assert.equal(f.sent[0].chat_id, '123456');
  assert.equal(f.sent[0].reply_markup.inline_keyboard[0][0].web_app.url, 'https://signal.test/?tma=1#/inbox');
  assert.equal(triage.tgSent, true);
  assert.equal(triage.tgMessageId, 7);
  f.store.reload();
  const ticket = f.store.state.tickets.find(item => item.id === created.id);
  ticket.status = 'review';
  f.store.state.notifications.push({ id: 'test-accepted', userId: employee.id, ticketId: ticket.id, text: 'Обращение принято', delivered: false });
  await f.bot.flushNotifications();
  assert.equal(f.sent[1].chat_id, '234567');
  assert.equal(f.sent[1].reply_markup.inline_keyboard[0][0].web_app.url, 'https://signal.test/?tma=1#/t/' + ticket.id);
  await createTelegram(f.store, ENV, f.options).flushNotifications();
  assert.equal(f.sent.length, 2);
});

test('notification failures are safely persisted and retried, permanent 403 stops delivery', async t => {
  const f = fixture(t);
  f.store.state.users[0].tgId = '123456';
  f.store.state.notifications.push({ id: 'n1', userId: 'o1', text: 'Уведомление', delivered: false });
  f.respond(() => { throw new Error('network failed https://api.telegram.org/bot' + ENV.BOT_TOKEN); });
  assert.deepEqual(await f.bot.flushNotifications(), { sent: 0, skipped: 0, failed: 1 });
  f.store.reload();
  assert.equal(f.store.state.notifications[0].tgError, 'telegram_unavailable');
  assert.ok(!JSON.stringify(f.store.state).includes(ENV.BOT_TOKEN));
  await f.bot.flushNotifications(); assert.equal(f.sent.length, 1);
  f.advance(60001);
  f.respond(() => Response.json({ ok: false, error_code: 403, description: 'blocked' }, { status: 403 }));
  await f.bot.flushNotifications();
  assert.equal(f.store.state.notifications[0].delivered, true);
  assert.equal(f.store.state.notifications[0].tgSent, undefined);
  assert.equal(f.store.state.notifications[0].tgSkipped, 'chat_unavailable');
  f.advance(3600000); await f.bot.flushNotifications();
  assert.equal(f.sent.length, 2);
});

test('notification flush caps work at ten sends and honors already-sent flags', async t => {
  const f = fixture(t);
  f.store.state.users[0].tgId = '123456';
  f.store.state.notifications.push({ id: 'sent', userId: 'o1', text: 'Sent', delivered: false, tgSent: true });
  for (let i = 0; i < 15; i++) f.store.state.notifications.push({ id: 'n' + i, userId: 'o1', text: 'Уведомление', delivered: false });
  const stats = await f.bot.flushNotifications(100);
  assert.deepEqual(stats, { sent: 9, skipped: 1, failed: 0 });
  assert.equal(f.sent.length, 9);
  assert.equal(f.store.state.notifications.filter(n => !n.delivered).length, 6);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function queue() {
  let pending = Promise.resolve();
  return fn => { const result = pending.then(fn); pending = result.catch(() => {}); return result; };
}

test('slow webhook send releases the company queue and concurrent replay makes one Telegram call', { timeout: 1500 }, async t => {
  const f = fixture(t), serialize = queue(), entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  f.respond(async () => { entered.resolve(); await release.promise; return Response.json({ ok: true, result: { message_id: 9 } }); });
  const bot = createTelegram(f.store, ENV, { ...f.options, serialize });
  const first = bot.handleUpdate(update(1));
  await entered.promise;
  const apiResult = await serialize(() => { f.store.state.users[0].name = 'Обновлено через API'; f.store.save(); return 'api-completed'; });
  assert.equal(apiResult, 'api-completed');
  const duplicate = await bot.handleUpdate(update(1));
  assert.equal(duplicate.status, 503);
  assert.equal(f.sent.length, 1);
  release.resolve();
  assert.equal((await first).status, 200);
  await bot.handleUpdate(update(1));
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.state.users[0].name, 'Обновлено через API');
});

test('notification send releases queue, singleflight avoids duplicate and finalize survives state reload', { timeout: 1500 }, async t => {
  const f = fixture(t), serialize = queue(), entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  f.store.state.users[0].tgId = '123456';
  f.store.state.notifications.push({ id: 'n1', userId: 'o1', text: 'Уведомление', delivered: false });
  f.store.save();
  f.respond(async () => { entered.resolve(); await release.promise; return Response.json({ ok: true, result: { message_id: 10 } }); });
  const bot = createTelegram(f.store, ENV, { ...f.options, serialize });
  const first = bot.flushNotifications();
  await entered.promise;
  assert.equal(bot.flushNotifications(), first);
  await serialize(() => {
    f.store.reload(); f.store.state.users[0].name = 'Сохранённое изменение'; f.store.save();
  });
  // A second instance also respects the persisted claim lease.
  const other = createTelegram(f.store, ENV, { ...f.options, serialize });
  assert.deepEqual(await other.flushNotifications(), { sent: 0, skipped: 0, failed: 0 });
  assert.equal(f.sent.length, 1);
  release.resolve();
  assert.deepEqual(await first, { sent: 1, skipped: 0, failed: 0 });
  f.store.reload();
  assert.equal(f.store.state.users[0].name, 'Сохранённое изменение');
  assert.equal(f.store.state.notifications[0].tgSent, true);
  assert.equal(f.store.state.notifications[0].tgClaim, undefined);
  await other.flushNotifications(); assert.equal(f.sent.length, 1);
});

test('recipient access changed during network failure prevents retry to stale identity', { timeout: 1500 }, async t => {
  const f = fixture(t), serialize = queue(), entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  f.store.state.users[0].tgId = '123456';
  f.store.state.notifications.push({ id: 'n1', userId: 'o1', text: 'Уведомление', delivered: false });
  f.store.save();
  f.respond(async () => { entered.resolve(); await release.promise; throw new Error('Test network failure'); });
  const bot = createTelegram(f.store, ENV, { ...f.options, serialize });
  const pending = bot.flushNotifications();
  await entered.promise;
  await serialize(() => { f.store.reload(); f.store.state.users[0].disabled = true; f.store.save(); });
  release.resolve();
  await pending;
  assert.equal(f.store.state.notifications[0].tgSkipped, 'recipient_changed');
  assert.equal(f.store.state.notifications[0].delivered, true);
  f.advance(3600000); await bot.flushNotifications();
  assert.equal(f.sent.length, 1);
});
