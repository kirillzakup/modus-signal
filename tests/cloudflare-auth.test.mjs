import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createAuth } from '../cloudflare/auth.mjs';
import telegram from '../server/auth.js';

const SETUP_TOKEN = 'a'.repeat(64);
const PASSWORD = 'Owner-correct-password-2026';
const req = (path, method = 'GET', cookie, extra = {}) => new Request('https://signal.test' + path, {
  method, headers: { ...(cookie ? { cookie } : {}), ...extra }
});
const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
const registerWith = async (auth, body) => auth.handle(req('/api/auth/telegram/register', 'POST'), body, null, await auth.prepareRegistration(body));
function fixture(env = {}) {
  const db = new DatabaseSync(':memory:');
  const store = {
    state: { seq: {}, departments: ["Управление", "IT", "Закупки"], users: [
      { id: 'o1', role: 'owner', name: 'Собственник', dept: 'Управление' },
      { id: 'a1', role: 'admin', name: 'Администратор', jobTitle: 'Engineer' },
      { id: 'a2', role: 'admin', name: 'Администратор 2', jobTitle: 'Engineer' },
      { id: 'm1', role: 'manager', name: 'Руководитель', dept: 'Закупки' },
      { id: 'u1', role: 'employee', name: 'Сотрудник', dept: 'Закупки' }
    ] },
    sql: { exec(query, ...params) {
      const st = db.prepare(query);
      const rows = /^SELECT|RETURNING/i.test(query) ? st.all(...params) : (st.run(...params), []);
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    storage: { transactionSync(fn) {
      db.exec('BEGIN');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } }
  };
  const auth = createAuth(store, { SETUP_TOKEN, ...env });
  const setup = body => auth.handle(req('/api/auth/setup', 'POST'), { token: SETUP_TOKEN, login: 'owner', password: PASSWORD, name: 'Кирилл', ...body });
  return { db, store, auth, setup };
}

describe('Cloudflare production authentication', () => {
  it('requires a setup secret, initializes once, stores salted hashes and secure session', async () => {
    const { auth, store, db, setup } = fixture();
    assert.equal((await (await auth.handle(req('/api/auth/status'))).json()).setupRequired, true);
    await assert.rejects(setup({ token: 'wrong' }), { status: 403 });
    await assert.rejects(setup({ password: 'short' }), { status: 400 });
    const result = await setup();
    assert.equal(result.status, 201);
    assert.match(result.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
    assert.match(result.headers.get('set-cookie'), /Max-Age=604800/);
    const identity = db.prepare('SELECT * FROM auth_identity').get();
    assert.equal(identity.salt.length, 32);
    assert.equal(identity.password_hash.length, 64);
    assert.ok(!JSON.stringify(identity).includes(PASSWORD));
    assert.equal((await auth.authenticate(req('/api/bootstrap', 'GET', cookieOf(result)))).id, 'o1');
    assert.equal(store.state.users[0].name, 'Кирилл');
    await assert.rejects(setup(), { status: 409 });
    const reloaded = createAuth(store, { SETUP_TOKEN });
    assert.equal((await (await reloaded.handle(req('/api/auth/status'))).json()).setupRequired, false);
    db.close();
  });

  it('login errors do not enumerate accounts and demo headers never authenticate', async () => {
    const { auth, setup, db } = fixture();
    await setup();
    for (const login of ['owner', 'unknown']) {
      await assert.rejects(auth.handle(req('/api/auth/login', 'POST'), { login, password: 'wrong-password' }), { status: 401, code: 'bad_credentials' });
    }
    assert.equal(await auth.authenticate(req('/api/bootstrap', 'GET', null, { 'X-Demo-User': 'o1' })), null);
    const success = await auth.handle(req('/api/auth/login', 'POST'), { login: ' OWNER ', password: PASSWORD });
    assert.equal((await auth.authenticate(req('/api/bootstrap', 'GET', cookieOf(success)))).id, 'o1');
    db.close();
  });

  it('logout revokes tokens and expired/disabled users cannot authenticate', async () => {
    const { auth, setup, store, db } = fixture();
    const first = cookieOf(await setup());
    await auth.handle(req('/api/auth/logout', 'POST', first));
    assert.equal(await auth.authenticate(req('/api/bootstrap', 'GET', first)), null);
    const second = cookieOf(await auth.handle(req('/api/auth/login', 'POST'), { login: 'owner', password: PASSWORD }));
    store.state.users[0].disabled = true;
    assert.equal(await auth.authenticate(req('/api/bootstrap', 'GET', second)), null);
    await assert.rejects(auth.handle(req('/api/auth/login', 'POST'), { login: 'owner', password: PASSWORD }), { status: 401 });
    store.state.users[0].disabled = false;
    db.prepare('UPDATE auth_sessions SET expires=0').run();
    assert.equal(await auth.authenticate(req('/api/bootstrap', 'GET', second)), null);
    db.close();
  });

  it('credentials provisioning enforces role boundaries and unique logins', async () => {
    const { auth, setup, store, db } = fixture();
    await setup();
    const [owner, admin, peerAdmin, manager, employee] = store.state.users;
    const endpoint = user => req('/api/admin/users/' + user.id + '/credentials', 'POST');
    const body = { login: 'employee', password: PASSWORD };
    await assert.rejects(auth.handle(endpoint(employee), body, employee), { status: 403 });
    await assert.rejects(auth.handle(endpoint(owner), body, admin), { status: 403 });
    await assert.rejects(auth.handle(endpoint(peerAdmin), body, admin), { status: 403 });
    await assert.rejects(auth.handle(endpoint(employee), body, admin), { status: 403 });
    await assert.rejects(auth.handle(endpoint(employee), body, owner), { status: 403 });
    await assert.rejects(auth.handle(endpoint(manager), body, owner), { status: 403 });
    assert.equal((await auth.handle(endpoint(admin), body, owner)).status, 200);
    await assert.rejects(auth.handle(endpoint(peerAdmin), body, owner), { status: 409 });
    assert.equal(db.prepare('SELECT user_id FROM auth_identity WHERE login=?').get('employee').user_id, admin.id);
    assert.equal(await auth.handle(req('/api/auth/signup', 'POST'), { role: 'owner' }), null);
    db.close();
  });

  it('password resets revoke every previous session and own change verifies current password', async () => {
    const { auth, setup, store, db } = fixture();
    const old = cookieOf(await setup());
    const owner = store.state.users[0];
    await assert.rejects(auth.handle(req('/api/auth/password', 'POST'), { currentPassword: 'wrong', password: 'new-long-password' }, owner), { status: 403 });
    const change = await auth.handle(req('/api/auth/password', 'POST'), { currentPassword: PASSWORD, password: 'new-long-password' }, owner);
    assert.equal(await auth.authenticate(req('/api/bootstrap', 'GET', old)), null);
    assert.equal((await auth.authenticate(req('/api/bootstrap', 'GET', cookieOf(change)))).id, 'o1');
    await auth.handle(req('/api/admin/users/o1/credentials', 'POST'), { login: 'owner', password: PASSWORD }, owner);
    assert.equal(await auth.authenticate(req('/api/bootstrap', 'GET', cookieOf(change))), null);
    db.close();
  });

  it('Telegram validates signature, current time, binding and enabled users', async () => {
    const token = 'test-bot-token', { auth, store, db } = fixture({ BOT_TOKEN: token });
    store.state.users[0].tgId = '123';
    const signed = when => telegram.signInitData({ auth_date: when, user: { id: 123 } }, token);
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await auth.authenticate(req('/api/bootstrap', 'GET', null, { authorization: 'tma ' + signed(now) }))).id, 'o1');
    await assert.rejects(auth.authenticate(req('/api/bootstrap', 'GET', null, { authorization: 'tma ' + signed(now + 3600) })), { status: 401 });
    await assert.rejects(auth.authenticate(req('/api/bootstrap', 'GET', null, { authorization: 'tma ' + signed(now - 100000) })), { status: 401 });
    store.state.users[0].disabled = true;
    await assert.rejects(auth.authenticate(req('/api/bootstrap', 'GET', null, { authorization: 'tma ' + signed(now) })), { status: 401 });
    db.close();
  });

  it('initial owner setup links a verified Mini App account without exposing auth data', async () => {
    const token = 'test-bot-token', { auth, setup, store, db } = fixture({ BOT_TOKEN: token });
    const initData = telegram.signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id: 456 } }, token);
    await assert.rejects(setup({ token: 'wrong', initData }), { status: 403 });
    assert.equal(store.state.users[0].tgId, undefined);
    const response = await setup({ initData });
    assert.equal(response.status, 201);
    assert.equal(store.state.users[0].tgId, '456');
    const result = await response.json();
    assert.deepEqual(Object.keys(result.me).sort(), ['id', 'jobTitle', 'name', 'role']);
    assert.ok(!JSON.stringify(result).includes(initData));
    assert.ok(!JSON.stringify(result).includes(PASSWORD));
    assert.ok(!JSON.stringify(result).includes(SETUP_TOKEN));
    assert.equal((await auth.authenticate(req('/api/bootstrap', 'GET', null, { authorization: 'tma ' + initData }))).id, 'o1');
    const again = await auth.handle(req('/api/auth/login', 'POST'), { login: 'owner', password: PASSWORD, initData });
    assert.equal(again.status, 200);
    assert.equal(store.state.users[0].tgId, '456');
    db.close();
  });

  it('only a correct administrator password can bind their verified Telegram account', async () => {
    const token = 'test-bot-token', { auth, setup, store, db } = fixture({ BOT_TOKEN: token });
    await setup();
    const owner = store.state.users[0], employee = store.state.users[1];
    await auth.handle(req('/api/admin/users/a1/credentials', 'POST'), { login: 'employee', password: PASSWORD }, owner);
    const initData = telegram.signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id: 789 } }, token);
    await assert.rejects(auth.handle(req('/api/auth/login', 'POST'), { login: 'employee', password: 'incorrect-password', initData }), { status: 401, code: 'bad_credentials' });
    assert.equal(employee.tgId, undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id=?').get(employee.id).n, 0);
    const result = await auth.handle(req('/api/auth/login', 'POST'), { login: 'employee', password: PASSWORD, initData });
    assert.equal(employee.tgId, '789');
    assert.equal((await auth.authenticate(req('/api/bootstrap', 'GET', cookieOf(result)))).id, 'a1');
    assert.equal((await auth.authenticate(req('/api/bootstrap', 'GET', null, { authorization: 'tma ' + initData }))).id, 'a1');
    db.close();
  });

  it('binding refuses occupied Telegram identities and changes to an existing user binding', async () => {
    const token = 'test-bot-token', { auth, setup, store, db } = fixture({ BOT_TOKEN: token });
    await setup();
    const owner = store.state.users[0], employee = store.state.users[4];
    employee.tgId = '456';
    const signed = id => telegram.signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id } }, token);
    const sessions = db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n;
    await assert.rejects(auth.handle(req('/api/auth/login', 'POST'), { login: 'owner', password: PASSWORD, initData: signed(456) }), { status: 409, code: 'telegram_already_linked' });
    assert.equal(employee.tgId, '456');
    assert.equal(owner.tgId, undefined);
    owner.tgId = '123';
    await assert.rejects(auth.handle(req('/api/auth/login', 'POST'), { login: 'owner', password: PASSWORD, initData: signed(789) }), { status: 409 });
    assert.equal(owner.tgId, '123');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, sessions);
    db.close();
  });

  it('forged, stale and future Mini App data never binds or creates another session', async () => {
    const token = 'test-bot-token', { auth, setup, store, db } = fixture({ BOT_TOKEN: token });
    const now = Math.floor(Date.now() / 1000);
    const signed = (when, secret = token) => telegram.signInitData({ auth_date: when, user: { id: 789 } }, secret);
    await assert.rejects(setup({ initData: signed(now, 'forged-token') }), { status: 401 });
    assert.equal((await (await auth.handle(req('/api/auth/status'))).json()).setupRequired, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_identity').get().n, 0);
    await setup();
    const sessions = db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n;
    for (const initData of [signed(now, 'forged-token'), signed(now - 3700), signed(now + 3600), 'x'.repeat(16385), { user: { id: 789 } }]) {
      await assert.rejects(auth.handle(req('/api/auth/login', 'POST'), { login: 'owner', password: PASSWORD, initData }), { status: 401 });
      assert.equal(store.state.users[0].tgId, undefined);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, sessions);
    }
    db.close();
  });

  it('employees and managers cannot use previously provisioned passwords', async () => {
    const { auth, setup, store, db } = fixture();
    await setup();
    const owner = store.state.users[0], target = store.state.users[1];
    await auth.handle(req('/api/admin/users/a1/credentials', 'POST'), { login: 'former-admin', password: PASSWORD }, owner);
    for (const role of ['employee', 'manager']) {
      target.role = role;
      await assert.rejects(auth.handle(req('/api/auth/login', 'POST'), { login: 'former-admin', password: PASSWORD }), { status: 401, code: 'bad_credentials' });
      await assert.rejects(auth.handle(req('/api/auth/password', 'POST'), { currentPassword: PASSWORD, password: 'another-secure-password' }, target), { status: 403 });
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id=?').get(target.id).n, 0);
    db.close();
  });

  it('registration requires initialized owner, fresh signed data and verified group membership', async t => {
    const token = 'test-bot-token', { auth, setup, store, db } = fixture({ BOT_TOKEN: token, TELEGRAM_GROUP_ID: '-100123' });
    let calls = 0, status = 'member', failure = false;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls++;
      assert.deepEqual(JSON.parse(options.body), { chat_id: '-100123', user_id: '789' });
      if (failure) throw new Error('simulated network failure');
      return { ok: true, json: async () => ({ ok: true, result: { user: { id: 789 }, status, is_member: false } }) };
    });
    const signed = (offset = 0, secret = token) => telegram.signInitData({ auth_date: Math.floor(Date.now() / 1000) + offset, user: { id: 789 } }, secret);
    const register = initData => registerWith(auth, { initData, name: 'Иван Иванов', jobTitle: 'Engineer' });
    await assert.rejects(register(signed()), { status: 409, code: 'setup_required' });
    assert.equal(calls, 0);
    await setup();
    for (const initData of [signed(0, 'forged'), signed(-3700), signed(3600), 'invalid']) {
      await assert.rejects(register(initData), { status: 401 });
    }
    assert.equal(calls, 0);
    for (status of ['left', 'kicked', 'restricted', 'unknown']) {
      await assert.rejects(register(signed()), { status: 403, code: 'membership_required' });
    }
    failure = true;
    await assert.rejects(register(signed()), { status: 503, code: 'telegram_unavailable' });
    assert.equal(store.state.users.length, 5);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 1);
    db.close();
  });

  it('registration creates only an employee, prevents duplicates, preserves roles and rejects disabled accounts', async t => {
    const token = 'test-bot-token', { auth, setup, store, db } = fixture({ BOT_TOKEN: token, TELEGRAM_GROUP_ID: '-100123', BOT_USERNAME: 'Modus_agent_bot' });
    t.mock.method(globalThis, 'fetch', async (_url, options) => ({ ok: true, json: async () => ({ ok: true, result: { user: { id: JSON.parse(options.body).user_id }, status: 'member' } }) }));
    await setup();
    const signed = id => telegram.signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id } }, token);
    const register = body => registerWith(auth, body);
    const result = await register({ initData: signed(789), name: 'Иван Иванов', jobTitle: 'Engineer', role: 'owner', id: 'o1', tgId: '123' });
    const me = (await result.json()).me;
    assert.equal(me.role, 'employee');
    assert.equal(me.jobTitle, 'Engineer');
    assert.notEqual(me.id, 'o1');
    assert.equal((await auth.authenticate(req('/api/bootstrap', 'GET', cookieOf(result)))).id, me.id);
    assert.equal(store.state.users.find(user => user.id === me.id).tgId, '789');
    assert.equal(store.state.users.length, 6);
    assert.equal((await (await register({ initData: signed(789), name: 'Подмена', jobTitle: 'Engineer', role: 'owner' })).json()).me.id, me.id);
    assert.equal(store.state.users.length, 6);
    assert.equal(store.state.users.find(user => user.id === me.id).name, 'Иван Иванов');
    store.state.users[0].tgId = '123';
    assert.equal((await (await register({ initData: signed(123) })).json()).me.role, 'owner');
    store.state.users.find(user => user.id === me.id).disabled = true;
    await assert.rejects(register({ initData: signed(789) }), { status: 403, code: 'account_disabled' });
    assert.equal(store.state.users.length, 6);
    const status = await (await auth.handle(req('/api/auth/status'))).json();
    assert.equal(status.botUsername, 'Modus_agent_bot');
    assert.equal(status.departments, undefined);
    assert.ok(!JSON.stringify(status).includes(token));
    db.close();
  });

  it('Telegram membership API errors and missing configuration fail closed', async t => {
    const token = 'test-bot-token', { auth, setup, store, db } = fixture({ BOT_TOKEN: token, TELEGRAM_GROUP_ID: '-100123' });
    await setup();
    const initData = telegram.signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id: 789 } }, token);
    let payload = { ok: false };
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => payload }));
    const body = { initData, name: 'Иван Иванов', jobTitle: 'Engineer' };
    await assert.rejects(registerWith(auth, body), { status: 503 });
    payload = { ok: true, result: { status: 'member', user: { id: 999 } } };
    await assert.rejects(registerWith(auth, body), { status: 503 });
    const unconfigured = createAuth(store, { BOT_TOKEN: token });
    await assert.rejects(registerWith(unconfigured, body), { status: 503 });
    assert.equal(store.state.users.length, 5);
    db.close();
  });

  it('registration consumes an opaque proof once and handle never makes network calls', async t => {
    const token = 'test-bot-token', env = { BOT_TOKEN: token, TELEGRAM_GROUP_ID: '-100123' };
    const { auth, setup, store, db } = fixture(env);
    await setup();
    let networkAllowed = true, calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls++;
      assert.ok(networkAllowed, 'network must run only in prepareRegistration');
      return { ok: true, json: async () => ({ ok: true, result: { user: { id: JSON.parse(options.body).user_id }, status: 'member' } }) };
    });
    const signed = id => telegram.signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id } }, token);
    const body = { initData: signed(789), name: 'Иван Иванов', jobTitle: 'Engineer' };
    const handle = proof => auth.handle(req('/api/auth/telegram/register', 'POST'), body, null, proof);
    for (const proof of [undefined, {}, { id: '789', initData: body.initData }]) {
      await assert.rejects(handle(proof), { status: 401, code: 'registration_not_verified' });
    }
    assert.equal(calls, 0);
    const proof = await auth.prepareRegistration(body);
    assert.equal(JSON.stringify(proof), '{}');
    networkAllowed = false;
    assert.equal((await handle(proof)).status, 200);
    await assert.rejects(handle(proof), { status: 401, code: 'registration_not_verified' });
    assert.equal(calls, 1);
    networkAllowed = true;
    const changed = await auth.prepareRegistration(body);
    const original = body.initData;
    body.initData = signed(999);
    await assert.rejects(handle(changed), { status: 401, code: 'registration_not_verified' });
    body.initData = original;
    await assert.rejects(handle(changed), { status: 401, code: 'registration_not_verified' });
    const another = await auth.prepareRegistration(body);
    const otherAuth = createAuth(store, env);
    await assert.rejects(otherAuth.handle(req('/api/auth/telegram/register', 'POST'), body, null, another), { status: 401, code: 'registration_not_verified' });
    const expired = await auth.prepareRegistration(body), current = Date.now();
    t.mock.method(Date, 'now', () => current + 31000);
    await assert.rejects(handle(expired), { status: 401, code: 'registration_not_verified' });
    assert.equal(store.state.users.length, 6);
    db.close();
  });

  it('default web entry offers Telegram and Mini App registration sends no role or password', async () => {
    const source = readFileSync(new URL('../public/auth-ui.js', import.meta.url), 'utf8');
    for (const initData of ['', 'signed-miniapp-test-fixture']) {
      let submit, sentBody, sentPath, done;
      const completed = new Promise(resolve => { done = resolve; });
      const fields = {
        '#registrationName': { value: '  Иван Иванов  ' }, '#registrationJobTitle': { value: 'Engineer' },
        '[type="submit"]': { disabled: false, isConnected: true }, '[role="alert"]': { textContent: '' }
      };
      const form = { addEventListener(event, callback) { if (event === 'submit') submit = callback; }, reportValidity: () => true, querySelector: key => fields[key], reset() {} };
      const root = { innerHTML: '', querySelector: () => form };
      const context = {
        location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
        document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
        window: { Telegram: { WebApp: { initData } } },
        fetch: async (path, options) => {
          if (path === '/api/auth/status') return { ok: true, json: async () => ({ setupRequired: false, botUsername: 'Modus_agent_bot', departments: ['IT', '<unsafe>'] }) };
          sentBody = JSON.parse(options.body); sentPath = path;
          return { ok: true, json: async () => ({ ok: true }) };
        }
      };
      runInNewContext(source, context);
      await context.window.ModusAuth.show(root, { onSuccess: done });
      assert.ok(!root.innerHTML.includes('type="password"'));
      assert.ok(root.innerHTML.includes('Вход администратора и собственника'));
      if (!initData) { assert.ok(root.innerHTML.includes('https://t.me/Modus_agent_bot?start=app')); continue; }
      assert.ok(!root.innerHTML.includes(initData));
      assert.ok(root.innerHTML.includes('registrationJobTitle'));
      assert.ok(!root.innerHTML.includes('registrationDept'));
      submit({ preventDefault() {} });
      await completed;
      assert.equal(sentPath, '/api/auth/telegram/register');
      assert.deepEqual(sentBody, { initData, name: 'Иван Иванов', jobTitle: 'Engineer' });
    }
  });

  it('Mini App login explicitly announces binding and sends initData only in the request body', async () => {
    const source = readFileSync(new URL('../public/auth-ui.js', import.meta.url), 'utf8');
    for (const initData of ['', 'signed-miniapp-test-fixture']) {
      let submit, sentBody, done;
      const completed = new Promise(resolve => { done = resolve; });
      const fields = {
        '#authLogin': { value: 'employee' }, '#authPassword': { value: PASSWORD },
        '[type="submit"]': { disabled: false, isConnected: true }, '[role="alert"]': { textContent: '' },
        input: { focus() {} }
      };
      const form = { addEventListener(event, callback) { if (event === 'submit') submit = callback; }, reportValidity: () => true, querySelector: key => fields[key], reset() {} };
      const root = { innerHTML: '', querySelector: () => form };
      const context = {
        location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
        document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
        window: { Telegram: { WebApp: { initData } } },
        fetch: async (path, options) => {
          if (path === '/api/auth/status') return { ok: true, json: async () => ({ setupRequired: false }) };
          sentBody = JSON.parse(options.body);
          return { ok: true, json: async () => ({ ok: true }) };
        }
      };
      runInNewContext(source, context);
      await context.window.ModusAuth.show(root, { onSuccess: done, admin: true });
      assert.equal(root.innerHTML.includes('Войти и привязать Telegram'), !!initData);
      if (initData) assert.ok(!root.innerHTML.includes(initData));
      submit({ preventDefault() {} });
      await completed;
      assert.equal(sentBody.initData, initData || undefined);
      assert.equal(sentBody.login, 'employee');
    }
  });
});
