import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import core from '../public/core.js';

const positiveId = value => /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value));
const hash = value => createHash('sha256').update(value).digest();
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

// Pass the company's queue as options.serialize. Network requests never hold it.
export function createTelegram(store, env, options = {}) {
  const fetcher = options.fetch || globalThis.fetch;
  const now = options.now || Date.now;
  const serialize = options.serialize || (fn => fn());
  const token = String(env.BOT_TOKEN || '');
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || '');
  const username = /^[a-z0-9_]{5,32}$/i.test(env.BOT_USERNAME || '') ? env.BOT_USERNAME : 'Modus_agent_bot';
  let publicUrl;
  try {
    publicUrl = new URL(env.PUBLIC_URL);
    if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password) publicUrl = null;
  } catch { publicUrl = null; }
  const enabled = Boolean(token && secret.length >= 32 && publicUrl);
  const sql = store.sql;
  const ready = Promise.resolve(serialize(() => {
    sql.exec('CREATE TABLE IF NOT EXISTS telegram_updates (id INTEGER PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, code TEXT NOT NULL, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS telegram_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  }));
  async function locked(fn) {
    await ready;
    return serialize(() => {
      try { return fn(); }
      catch (error) { try { store.reload?.(); } catch { /* Preserve the original failure. */ } throw error; }
    });
  }

  function verifyWebhook(request) {
    const supplied = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!enabled || supplied.length > 256 || !timingSafeEqual(hash(supplied), hash(secret))) {
      throw fail(403, 'forbidden', 'Недействительная подпись вебхука');
    }
    return true;
  }
  function appUrl(path = '') {
    const url = new URL(publicUrl);
    url.searchParams.set('tma', '1');
    url.hash = path ? '#' + path : '';
    return url.href;
  }
  const button = (label, path = '') => ({ inline_keyboard: [[{ text: label, web_app: { url: appUrl(path) } }]] });
  const pauseUntil = () => Number(sql.exec("SELECT value FROM telegram_meta WHERE key='pause_until'").toArray()[0]?.value || 0);
  function pause(seconds) {
    const until = now() + seconds * 1000;
    sql.exec("INSERT INTO telegram_meta(key,value) VALUES('pause_until',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)", until);
  }
  function backoff(attempts, retryAfter) {
    return retryAfter || Math.min(3600, 15 * 2 ** Math.min(attempts, 8));
  }
  async function send(payload, timeoutMs = 7500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.ok === true && Number.isSafeInteger(data.result?.message_id)) {
        return { ok: true, messageId: data.result.message_id };
      }
      const code = Number(data?.error_code || response.status) || 502;
      const retryAfter = code === 429 ? Math.min(86400, Math.max(1, Number(data?.parameters?.retry_after) || 60)) : 0;
      return { ok: false, code: 'telegram_' + code, permanent: code === 400 || code === 403, retryAfter };
    } catch {
      // Network errors may contain the token-bearing endpoint. Never persist or return them.
      return { ok: false, code: controller.signal.aborted ? 'telegram_timeout' : 'telegram_unavailable', permanent: false, retryAfter: 0 };
    } finally { clearTimeout(timer); }
  }
  function updateRecord(id, status, attempts, nextAt = 0, code = '') {
    sql.exec('INSERT INTO telegram_updates(id,status,attempts,next_at,code,at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,next_at=excluded.next_at,code=excluded.code,at=excluded.at', id, status, attempts, nextAt, code, now());
  }
  function retryResponse(nextAt) {
    return json({ ok: false, code: 'telegram_retry' }, 503, { 'retry-after': String(Math.max(1, Math.ceil((nextAt - now()) / 1000))) });
  }
  function commandPayload(update) {
    const message = update.message;
    if (!message || message.from?.is_bot || typeof message.text !== 'string') return null;
    const match = /^\/(start|help|id)(?:@([a-z0-9_]+))?(?:\s[^\n]*)?$/i.exec(message.text.trim());
    if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return null;
    const command = match[1].toLowerCase();
    const chat = message.chat;
    if (!chat || !positiveId(message.from?.id)) return null;
    if (chat.type === 'private' && positiveId(chat.id) && String(chat.id) === String(message.from.id)) {
      if (command === 'id') return { chat_id: String(chat.id), text: 'Ваш Telegram ID: ' + message.from.id + '\nПередайте его администратору для привязки к вашему профилю.' };
      return { chat_id: String(chat.id), text: 'МОДУС · СИГНАЛ\nОткройте приложение и зарегистрируйтесь через свой Telegram. Доступ для участников группы компании.', reply_markup: button('Открыть МОДУС · СИГНАЛ') };
    }
    if (['group', 'supergroup'].includes(chat.type) && Number.isSafeInteger(chat.id) && chat.id < 0 && command === 'start') {
      return { chat_id: String(chat.id), text: 'Откройте личный чат с ботом, чтобы запустить МОДУС · СИГНАЛ.', reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', url: 'https://t.me/' + username + '?start=app' }]] } };
    }
    return null;
  }

  // Only call after verifyWebhook(request); no app identity is trusted from a webhook body.
  async function handleUpdate(update) {
    if (!enabled) throw fail(503, 'telegram_disabled', 'Telegram не настроен');
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) throw fail(400, 'validation', 'Некорректное обновление Telegram');
    const id = update.update_id;
    const claim = await locked(() => claimUpdate(id, commandPayload(update)));
    if (claim instanceof Response) return claim;
    const result = await send(claim.payload);
    return locked(() => {
      if (result.retryAfter) pause(result.retryAfter);
      const current = sql.exec('SELECT status,attempts,next_at FROM telegram_updates WHERE id=?', id).toArray()[0];
      if (current?.status === 'done') return json({ ok: true });
      if (!current || current.attempts !== claim.attempts) return retryResponse(current?.next_at || now() + 60000);
      if (result.ok || result.permanent) {
        updateRecord(id, 'done', claim.attempts, 0, result.code || '');
        return json({ ok: true });
      }
      const nextAt = now() + backoff(claim.attempts, result.retryAfter) * 1000;
      updateRecord(id, 'pending', claim.attempts, nextAt, result.code);
      return retryResponse(nextAt);
    });
  }
  function claimUpdate(id, payload) {
    const row = sql.exec('SELECT status,attempts,next_at FROM telegram_updates WHERE id=?', id).toArray()[0];
    if (row?.status === 'done') return json({ ok: true });
    if (row?.next_at > now()) return retryResponse(row.next_at);
    if (!payload) { updateRecord(id, 'done', 0); return json({ ok: true }); }
    if (!row) {
      try { store.rateLimit('tg:chat:' + payload.chat_id, 6, 60000); store.rateLimit('tg:commands', 30, 60000); }
      catch (error) {
        if (error.status !== 429) throw error;
        updateRecord(id, 'done', 0, 0, 'rate_limited');
        return json({ ok: true });
      }
    }
    const pausedUntil = pauseUntil();
    if (pausedUntil > now()) {
      updateRecord(id, 'pending', row?.attempts || 0, pausedUntil, 'telegram_paused');
      return retryResponse(pausedUntil);
    }
    const attempts = (row?.attempts || 0) + 1;
    // Persist a short lease before sending: a restarted worker waits before retrying an ambiguous send.
    updateRecord(id, 'pending', attempts, now() + 60000);
    return { attempts, payload };
  }

  function recipient(notification) {
    const user = store.state.users.find(u => u.id === notification.userId);
    if (!user || user.disabled === true || user.active === false || !positiveId(user.tgId)) return { skip: 'unlinked_or_disabled' };
    let ticket;
    if (notification.ticketId) {
      try { ticket = core.getTicket(store.state, user.id, notification.ticketId); }
      catch { return { skip: 'ticket_unavailable' }; }
    }
    return { user, ticket };
  }
  function claimNotification() {
    if (pauseUntil() > now()) return null;
    const notification = store.state.notifications.find(n => n.delivered === false && (!n.tgNextAttemptAt || n.tgNextAttemptAt <= now()));
    if (!notification) return null;
    const { user, ticket, skip } = recipient(notification);
    if (skip || notification.tgSent === true) {
      notification.delivered = true; notification.tgSkipped = skip || 'already_sent';
      store.save(); return { skipped: true };
    }
    const path = ticket ? (ticket.pending && core.isTriager(store.state, user) ? '/inbox' : '/t/' + encodeURIComponent(ticket.id)) : '/';
    const lease = randomUUID();
    notification.tgAttempts = (notification.tgAttempts || 0) + 1;
    notification.tgNextAttemptAt = now() + 60000;
    notification.tgClaim = lease;
    store.save();
    return { id: notification.id, lease, userId: user.id, ticketId: notification.ticketId, text: notification.text,
      payload: { chat_id: String(user.tgId), text: ('🔔 ' + String(notification.text || 'Новое уведомление')).slice(0, 3900), reply_markup: button(ticket?.pending ? 'Открыть входящие' : 'Открыть в приложении', path) } };
  }
  function finishNotification(claim, result) {
    if (result.retryAfter) pause(result.retryAfter);
    const notification = store.state.notifications.find(n => n.id === claim.id);
    if (!notification || notification.tgClaim !== claim.lease) return;
    delete notification.tgClaim;
    // Re-find current objects: another API request can save or reload state during fetch.
    if (notification.userId !== claim.userId || notification.ticketId !== claim.ticketId || notification.text !== claim.text) {
      delete notification.tgNextAttemptAt; store.save(); return;
    }
    const current = recipient(notification);
    const changed = current.skip || String(current.user.tgId) !== claim.payload.chat_id;
    if (result.ok) {
      notification.delivered = true; notification.tgSent = true;
      notification.tgSentAt = new Date(now()).toISOString(); notification.tgMessageId = result.messageId;
      delete notification.tgError; delete notification.tgNextAttemptAt;
    } else {
      notification.tgError = result.code;
      notification.tgNextAttemptAt = now() + backoff(notification.tgAttempts, result.retryAfter) * 1000;
      if (result.permanent || changed) { notification.delivered = true; notification.tgSkipped = changed ? 'recipient_changed' : 'chat_unavailable'; }
    }
    store.save();
  }
  let flushing;
  function flushNotifications(limit = 10) {
    if (flushing) return flushing;
    flushing = runFlush(limit).finally(() => { flushing = null; });
    return flushing;
  }
  async function runFlush(limit) {
    const stats = { sent: 0, skipped: 0, failed: 0 };
    if (!enabled) return stats;
    const started = now();
    const count = Number.isFinite(limit) ? Math.max(1, Math.min(10, Math.floor(limit))) : 10;
    for (let i = 0; i < count && now() - started < 6000; i++) {
      const claim = await locked(claimNotification);
      if (!claim) break;
      if (claim.skipped) { stats.skipped++; continue; }
      const result = await send(claim.payload, Math.max(1, 7500 - (now() - started)));
      await locked(() => finishNotification(claim, result));
      if (result.ok) stats.sent++; else stats.failed++;
    }
    return stats;
  }
  return { enabled, verifyWebhook, handleUpdate, flushNotifications };
}
