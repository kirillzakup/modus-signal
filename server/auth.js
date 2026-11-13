'use strict';
/**
 * Аутентификация: демо-режим (X-Demo-User) и Telegram Mini App (Authorization: tma <initData>).
 * Проверка initData — по документации Telegram:
 *   secret_key = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)
 *   hash       = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
 * data_check_string — все поля, кроме hash, отсортированные по ключу, в формате key=value через \n.
 */
const crypto = require('node:crypto');

const MAX_AGE_SEC = 24 * 3600;

function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status; e.code = code;
  return e;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

/** Подписать initData (используется в тестах и для локальной отладки). */
function signInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

/**
 * Проверить initData. Возвращает { user, authDate, raw } или бросает ошибку 401.
 */
function validateInitData(initData, botToken, opts = {}) {
  if (!botToken) throw httpError(401, 'tg_not_configured', 'Вход через Telegram не настроен на сервере');
  if (!initData || typeof initData !== 'string') throw httpError(401, 'bad_init_data', 'Нет данных авторизации Telegram');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) throw httpError(401, 'bad_init_data', 'Некорректная подпись Telegram');
  const pairs = [];
  for (const [k, v] of params.entries()) if (k !== 'hash') pairs.push([k, v]);
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dcs = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (!safeEqual(expected, hash.toLowerCase())) throw httpError(401, 'bad_init_data', 'Подпись Telegram не прошла проверку');
  const authDate = Number(params.get('auth_date'));
  const now = Math.floor((opts.now || Date.now()) / 1000);
  const maxAge = opts.maxAgeSec || MAX_AGE_SEC;
  if (!authDate || now - authDate > maxAge) throw httpError(401, 'init_data_expired', 'Сессия Telegram устарела — откройте приложение заново');
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (_) { user = null; }
  if (!user || user.id == null) throw httpError(401, 'bad_init_data', 'В данных Telegram нет пользователя');
  return { user, authDate, raw: initData };
}

/** Найти пользователя ядра по Telegram ID. */
function userByTgId(state, tgId) {
  const id = String(tgId);
  return state.users.find((u) => u.tgId != null && String(u.tgId) === id) || null;
}

/**
 * Определить действующего пользователя по заголовкам запроса.
 * Возвращает { me, via: 'demo'|'tma', tg? }.
 */
function authenticate(req, state, cfg) {
  const h = req.headers['authorization'] || '';
  if (/^tma\s+/i.test(h)) {
    const tg = validateInitData(h.replace(/^tma\s+/i, '').trim(), cfg.botToken);
    const me = userByTgId(state, tg.user.id);
    if (!me) throw httpError(401, 'link_required', 'Аккаунт Telegram не привязан к сотруднику');
    return { me, via: 'tma', tg };
  }
  const demo = req.headers['x-demo-user'];
  if (demo && cfg.demo) {
    const me = state.users.find((u) => u.id === String(demo));
    if (!me) throw httpError(401, 'unknown_user', 'Пользователь не найден');
    return { me, via: 'demo' };
  }
  throw httpError(401, 'unauthorized', 'Требуется авторизация');
}

/** Только проверка initData (для привязки аккаунта, когда пользователь ещё не связан). */
function authenticateTelegram(req, cfg) {
  const h = req.headers['authorization'] || '';
  if (!/^tma\s+/i.test(h)) throw httpError(401, 'unauthorized', 'Откройте приложение из Telegram');
  return validateInitData(h.replace(/^tma\s+/i, '').trim(), cfg.botToken);
}

/** Привязать Telegram ID к сотруднику (одна учётная запись Telegram — один сотрудник). */
function linkTelegram(core, state, userId, tgId) {
  const target = state.users.find((u) => u.id === userId);
  if (!target) throw httpError(404, 'not_found', 'Сотрудник не найден');
  const admin = state.users.find((u) => u.role === 'admin') || { id: 'a1' };
  return core.updateUser(state, admin.id, userId, { tgId: String(tgId) });
}

module.exports = { validateInitData, signInitData, authenticate, authenticateTelegram, userByTgId, linkTelegram, safeEqual, httpError, MAX_AGE_SEC };
