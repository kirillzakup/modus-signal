import { timingSafeEqual } from 'node:crypto';
import telegramAuth from '../server/auth.js';
import core from '../public/core.js';

const COOKIE = '__Host-modus_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const ITERATIONS = 100000;
const encoder = new TextEncoder();

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}
function json(value, status = 200, cookie) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(JSON.stringify(value), { status, headers });
}
const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/.{2}/g) || [], n => parseInt(n, 16));
const random = count => hex(crypto.getRandomValues(new Uint8Array(count)));
const hash = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
async function equalSecret(a, b) {
  const left = unhex(await hash(a)), right = unhex(await hash(b));
  return timingSafeEqual(left, right);
}
function loginValue(raw) {
  if (typeof raw !== 'string') fail(400, 'validation', 'Укажите логин');
  const value = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@+-]{2,99}$/.test(value)) {
    fail(400, 'validation', 'Логин: 3–100 латинских букв, цифр или символов . _ @ + -');
  }
  return value;
}
function passwordValue(raw) {
  if (typeof raw !== 'string' || raw.length < 12 || raw.length > 256) {
    fail(400, 'validation', 'Пароль должен содержать от 12 до 256 символов');
  }
  return raw;
}
async function passwordHash(password, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations, salt: unhex(salt) }, key, 256));
}
function sessionCookie(token, seconds = SESSION_SECONDS) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}
function tokenOf(request) {
  const matches = (request.headers.get('cookie') || '').split(';').map(x => x.trim()).filter(x => x.startsWith(COOKIE + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
const enabled = user => user && user.disabled !== true && user.active !== false;
const publicUser = user => ({ id: user.id, name: user.name, role: user.role, jobTitle: user.jobTitle || '' });

/** Durable Object serializes calls; SQL transactions protect multi-statement auth writes. */
export function createAuth(store, env) {
  const sql = store.sql;
  const registrationProofs = new WeakMap();
  const one = (query, ...params) => sql.exec(query, ...params).toArray()[0] || null;
  sql.exec('CREATE TABLE IF NOT EXISTS auth_identity (user_id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, iterations INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id)');
  sql.exec('CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires)');
  sql.exec('CREATE TABLE IF NOT EXISTS auth_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

  const findUser = id => store.state.users.find(user => user.id === id);
  const initialized = () => !!one("SELECT value FROM auth_meta WHERE key = 'initialized'") || !!one('SELECT user_id FROM auth_identity LIMIT 1');
  const identityFor = id => one('SELECT * FROM auth_identity WHERE user_id = ?', id);

  async function issueSession(user) {
    const token = random(32);
    const digest = await hash(token);
    sql.exec('DELETE FROM auth_sessions WHERE expires <= ?', Date.now());
    sql.exec('INSERT INTO auth_sessions(token_hash,user_id,expires) VALUES(?,?,?)', digest, user.id, Date.now() + SESSION_SECONDS * 1000);
    return sessionCookie(token);
  }
  async function credentialData(body) {
    const login = loginValue(body.login), password = passwordValue(body.password), salt = random(16);
    return { login, salt, digest: await passwordHash(password, salt) };
  }
  function saveCredentials(user, data) {
    const occupied = one('SELECT user_id FROM auth_identity WHERE login = ?', data.login);
    if (occupied && occupied.user_id !== user.id) fail(409, 'login_taken', 'Этот логин уже используется');
    sql.exec('INSERT INTO auth_identity(user_id,login,salt,password_hash,iterations) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET login=excluded.login,salt=excluded.salt,password_hash=excluded.password_hash,iterations=excluded.iterations',
      user.id, data.login, data.salt, data.digest, ITERATIONS);
    sql.exec('DELETE FROM auth_sessions WHERE user_id = ?', user.id);
  }
  async function checkPassword(identity, password) {
    // A missing login performs the same expensive derivation as an existing login.
    const salt = identity ? identity.salt : '00000000000000000000000000000000';
    const digest = await passwordHash(password, salt, identity ? identity.iterations : ITERATIONS);
    return !!identity && timingSafeEqual(unhex(digest), unhex(identity.password_hash));
  }

  function verifiedTelegram(data, maxAgeSec) {
    if (typeof data !== 'string' || !data || data.length > 16384) fail(401, 'unauthorized', 'Некорректная сессия Telegram');
    const tg = telegramAuth.validateInitData(data, env.BOT_TOKEN || '', { maxAgeSec });
    if (tg.authDate > Math.floor(Date.now() / 1000) + 60) fail(401, 'unauthorized', 'Некорректная дата сессии Telegram');
    if (!/^[1-9]\d{0,15}$/.test(String(tg.user.id))) fail(401, 'unauthorized', 'Некорректный аккаунт Telegram');
    return tg;
  }
  function prepareTelegramBinding(user, data) {
    if (data == null || data === '') return null;
    const tg = verifiedTelegram(data, 3600), id = String(tg.user.id);
    const occupied = store.state.users.some(other => other.id !== user.id && other.tgId && String(other.tgId) === id);
    if (occupied || (user.tgId && String(user.tgId) !== id)) {
      fail(409, 'telegram_already_linked', 'Этот аккаунт уже имеет другую привязку Telegram. Обратитесь к администратору.');
    }
    return id;
  }
  async function requireGroupMember(id) {
    if (!env.BOT_TOKEN || !env.TELEGRAM_GROUP_ID) fail(503, 'telegram_unavailable', 'Регистрация через Telegram пока не настроена');
    let result;
    try {
      const response = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/getChatMember', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_GROUP_ID, user_id: id }), signal: AbortSignal.timeout(8000)
      });
      result = await response.json();
      if (!response.ok || !result.ok || !result.result || String(result.result.user?.id) !== id) throw new Error('membership_unavailable');
    } catch { fail(503, 'telegram_unavailable', 'Не удалось проверить участие в группе компании. Попробуйте позже'); }
    const member = result.result;
    if (!['member', 'administrator', 'creator'].includes(member.status) && !(member.status === 'restricted' && member.is_member === true)) {
      fail(403, 'membership_required', 'Для регистрации нужно состоять в Telegram-группе компании');
    }
  }

  // Network verification runs outside the shared application mutation queue.
  async function prepareRegistration(body = {}) {
    if (!initialized()) fail(409, 'setup_required', 'Собственник ещё не завершил настройку системы');
    const initData = body.initData;
    const tg = verifiedTelegram(initData, 3600), id = String(tg.user.id);
    await requireGroupMember(id);
    const proof = Object.freeze({});
    registrationProofs.set(proof, { id, initData, verifiedAt: Date.now() });
    return proof;
  }
  function consumeRegistrationProof(proof, initData, id) {
    const verified = proof && typeof proof === 'object' ? registrationProofs.get(proof) : null;
    if (verified) registrationProofs.delete(proof);
    if (!verified || verified.id !== id || verified.initData !== initData || Date.now() - verified.verifiedAt > 30000) {
      fail(401, 'registration_not_verified', 'Повторите проверку Telegram для регистрации');
    }
  }

  async function authenticate(request) {
    const authorization = request.headers.get('authorization') || '';
    if (/^tma\s+/i.test(authorization)) {
      const data = authorization.replace(/^tma\s+/i, '');
      const tg = verifiedTelegram(data, telegramAuth.MAX_AGE_SEC);
      const user = store.state.users.find(u => u.tgId && String(u.tgId) === String(tg.user.id));
      if (!enabled(user)) fail(401, 'link_required', 'Аккаунт Telegram не привязан к активному сотруднику');
      return user;
    }
    const token = tokenOf(request);
    if (!token) return null;
    const session = one('SELECT user_id,expires FROM auth_sessions WHERE token_hash = ?', await hash(token));
    if (!session || session.expires <= Date.now()) return null;
    const user = findUser(session.user_id);
    return enabled(user) ? user : null;
  }

  async function handle(request, body = {}, me = null, registrationProof = null) {
    const path = new URL(request.url).pathname, method = request.method;
    if (path === '/api/auth/status' && method === 'GET') {
      return json({ setupRequired: !initialized(), telegramConfigured: !!env.BOT_TOKEN, botUsername: /^[A-Za-z0-9_]{5,32}$/.test(env.BOT_USERNAME || '') ? env.BOT_USERNAME : '' });
    }
    if (path === '/api/auth/telegram/register' && method === 'POST') {
      if (!initialized()) fail(409, 'setup_required', 'Собственник ещё не завершил настройку системы');
      const tg = verifiedTelegram(body.initData, 3600), id = String(tg.user.id);
      consumeRegistrationProof(registrationProof, body.initData, id);
      let user = store.state.users.find(candidate => String(candidate.tgId || '') === id);
      if (user && !enabled(user)) fail(403, 'account_disabled', 'Учётная запись отключена. Обратитесь к администратору');
      if (!user) {
        const owner = store.state.users.find(candidate => candidate.role === 'owner' && enabled(candidate));
        if (!owner) fail(503, 'workspace_not_ready', 'Учётная запись собственника не подготовлена');
        if (typeof body.jobTitle !== 'string' || body.jobTitle.trim().length < 2 || body.jobTitle.trim().length > 100 || /[\x00-\x1f\x7f]/.test(body.jobTitle)) fail(400, 'validation', 'Укажите должность: от 2 до 100 символов');
        const created = core.createUser(store.state, owner.id, { name: body.name, jobTitle: body.jobTitle.trim(), role: 'employee' });
        user = findUser(created.id);
        user.tgId = id;
      }
      return json({ ok: true, me: publicUser(user) }, 200, await issueSession(user));
    }
    if (path === '/api/auth/setup' && method === 'POST') {
      if (initialized()) fail(409, 'already_initialized', 'Первоначальная настройка уже завершена');
      const expected = env.SETUP_TOKEN;
      if (typeof expected !== 'string' || expected.length < 32) fail(503, 'setup_unavailable', 'Первоначальная настройка не подготовлена');
      if (typeof body.token !== 'string' || body.token.length > 256 || !await equalSecret(expected, body.token)) {
        fail(403, 'bad_setup_token', 'Ссылка первоначальной настройки недействительна');
      }
      const owner = store.state.users.find(user => user.role === 'owner');
      if (!enabled(owner)) fail(503, 'setup_unavailable', 'Учётная запись собственника не подготовлена');
      if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 100) {
        fail(400, 'validation', 'Укажите имя собственника (2–100 символов)');
      }
      const telegramId = prepareTelegramBinding(owner, body.initData);
      const data = await credentialData(body);
      store.storage.transactionSync(() => {
        if (initialized()) fail(409, 'already_initialized', 'Первоначальная настройка уже завершена');
        saveCredentials(owner, data);
        sql.exec("INSERT INTO auth_meta(key,value) VALUES('initialized',?)", String(Date.now()));
      });
      const cookie = await issueSession(owner);
      owner.name = body.name.trim();
      if (telegramId) owner.tgId = telegramId;
      return json({ ok: true, me: publicUser(owner) }, 201, cookie);
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const rawLogin = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
      const rawPassword = typeof body.password === 'string' ? body.password : '';
      if (rawLogin.length > 100 || rawPassword.length > 256) fail(401, 'bad_credentials', 'Неверный логин или пароль');
      const identity = one('SELECT * FROM auth_identity WHERE login = ?', rawLogin);
      const valid = await checkPassword(identity, rawPassword);
      const user = identity && findUser(identity.user_id);
      if (!valid || !enabled(user) || !['owner', 'admin'].includes(user.role)) fail(401, 'bad_credentials', 'Неверный логин или пароль');
      const telegramId = prepareTelegramBinding(user, body.initData);
      const cookie = await issueSession(user);
      if (telegramId) user.tgId = telegramId;
      return json({ ok: true, me: publicUser(user) }, 200, cookie);
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = tokenOf(request);
      if (token) sql.exec('DELETE FROM auth_sessions WHERE token_hash = ?', await hash(token));
      return json({ ok: true }, 200, sessionCookie('', 0));
    }
    if (path === '/api/auth/password' && method === 'POST') {
      if (!enabled(me)) fail(401, 'unauthorized', 'Войдите в систему');
      if (!['owner', 'admin'].includes(me.role)) fail(403, 'forbidden', 'Сотрудники входят через Telegram');
      const identity = identityFor(me.id);
      const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      if (current.length > 256 || !await checkPassword(identity, current)) fail(403, 'bad_credentials', 'Текущий пароль неверен');
      const data = await credentialData({ login: identity.login, password: body.password });
      store.storage.transactionSync(() => saveCredentials(me, data));
      return json({ ok: true }, 200, await issueSession(me));
    }
    const credentials = path.match(/^\/api\/admin\/users\/([^/]+)\/credentials$/);
    if (credentials && method === 'POST') {
      if (!enabled(me)) fail(401, 'unauthorized', 'Войдите в систему');
      let id;
      try { id=decodeURIComponent(credentials[1]); } catch { fail(400,'validation','Некорректный адрес сотрудника'); }
      const target = findUser(id);
      if (!target) fail(404, 'not_found', 'Сотрудник не найден');
      if (me.role !== 'owner' || !['owner', 'admin'].includes(target.role)) {
        fail(403, 'forbidden', 'Недостаточно прав для изменения доступа этого сотрудника');
      }
      const data = await credentialData(body);
      store.storage.transactionSync(() => saveCredentials(target, data));
      return json({ ok: true, userId: target.id, login: data.login });
    }
    return null;
  }
  return { authenticate, handle, prepareRegistration };
}
