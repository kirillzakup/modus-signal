const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
function declaration(name) {
  const start = script.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' exists');
  const end = script.indexOf('\nfunction ', start + 1);
  return script.slice(start, end === -1 ? script.length : end);
}
function harness(role = 'admin') {
  const events = { closed: 0, rendered: 0, errors: [], calls: [] };
  const context = {
    App: { me: { role }, ui: {}, api: {}, boot: { rewards: [] } },
    esc: value => String(value == null ? '' : value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]),
    ava: () => '', fmt: () => 'сегодня', emptyBox: (_icon, text) => text,
    closeModal: () => events.closed++, toast: () => {}, rerender: () => events.rendered++,
    fail: error => events.errors.push(error), isStaff: () => true,
    lsGet: () => null, solutionsCard: () => '', engagementCard: () => ''
  };
  vm.createContext(context);
  for (const name of ['isOwnerish', 'redemptionCard', 'viewOwner', 'tile', 'askBubble', 'viewMore', 'navItemsOld']) vm.runInContext(declaration(name), context);
  const actsStart = script.indexOf('var acts={');
  const actsEnd = script.indexOf('\nfor(var _k in actsV2)', actsStart);
  assert.ok(actsEnd > actsStart);
  vm.runInContext(script.slice(actsStart, actsEnd), context);
  return { context, events };
}
function button(dialog) { return { dataset: { v: 'merch' }, disabled: false, isConnected: true, closest: () => dialog }; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('all inline application JavaScript parses', () => { new vm.Script(script); });

test('admin reward screen requests only redemptions and exposes approval actions', async () => {
  const { context, events } = harness();
  context.App.api.digest = context.App.api.reports = () => { throw new Error('Forbidden private owner report'); };
  context.App.api.redemptions = async () => {
    events.calls.push('redemptions');
    return [{ id: 'r1', state: 'pending', userName: '<Иван>', name: '<Мерч>', cost: 100 }, { id: 'r2', state: 'approved', name: 'Уже выдано' }];
  };
  const result = await context.viewOwner();
  assert.deepEqual(events.calls, ['redemptions']);
  assert.match(result, /Заявки на награды/);
  assert.match(result, /data-act="redOk"/);
  assert.match(result, /data-act="redNo"/);
  assert.match(result, /&lt;Иван&gt;/);
  assert.match(result, /&lt;Мерч&gt;/);
  assert.doesNotMatch(result, /Уже выдано|genReport|ПУЛЬС КОМПАНИИ|Зона риска/);
  assert.match(await context.viewMore(), /Заявки на награды/);
  assert.doesNotMatch(await context.viewMore(), /Отчёт ИИ-агента/);
  assert.equal(context.navItemsOld().find(item => item[0] === '#/owner')[2], 'Заявки на награды');
});

test('admin redemption errors remain visible to the route instead of an empty queue', async () => {
  const { context } = harness();
  context.App.api.redemptions = async () => { throw new Error('Connection failed'); };
  await assert.rejects(context.viewOwner(), /Connection failed/);
});

test('owner retains private dashboard and employees cannot request approvals', async () => {
  const { context, events } = harness('owner');
  context.App.api.digest = async () => {
    events.calls.push('digest');
    return { health: { tone: 'green', score: 100, label: 'Хорошо' }, kpi: {}, hanging: [], active: [], attention: [], reward: [], risk: [], corrections: [], nextSteps: [] };
  };
  context.App.api.reports = async () => { events.calls.push('reports'); return []; };
  context.App.api.redemptions = async () => { events.calls.push('redemptions'); return []; };
  const result = await context.viewOwner();
  assert.deepEqual(events.calls, ['digest', 'reports', 'redemptions']);
  assert.match(result, /ПУЛЬС КОМПАНИИ/);
  assert.match(result, /Доклад ИИ-агента/);
  context.App.me.role = 'employee';
  events.calls.length = 0;
  assert.match(await context.viewOwner(), /доступен собственнику/);
  assert.deepEqual(events.calls, []);
});

test('double confirmation sends a single redemption per modal and disables synchronously', async () => {
  const { context, events } = harness('employee'), pending = deferred(), dialog = {};
  context.App.api.redeem = id => { events.calls.push(id); return pending.promise; };
  const first = button(dialog), second = button(dialog);
  const completion = context.acts.redeemOk(first);
  assert.equal(first.disabled, true);
  context.acts.redeemOk(first);
  context.acts.redeemOk(second);
  await Promise.resolve();
  assert.deepEqual(events.calls, ['merch']);
  pending.resolve();
  await completion;
  assert.equal(events.closed, 1);
  assert.equal(events.rendered, 1);
  assert.deepEqual(events.errors, []);
});

test('failed redemption keeps modal open and enables exactly one retry', async () => {
  const { context, events } = harness('employee'), dialog = {}, el = button(dialog);
  let attempt = 0;
  context.App.api.redeem = () => { attempt++; return attempt === 1 ? Promise.reject(new Error('Недостаточно монет')) : Promise.resolve(); };
  await context.acts.redeemOk(el);
  assert.equal(el.disabled, false);
  assert.equal(dialog.redeemPending, false);
  assert.equal(events.closed, 0);
  assert.equal(events.errors[0].message, 'Недостаточно монет');
  const retry = context.acts.redeemOk(el);
  context.acts.redeemOk(el);
  await retry;
  assert.equal(attempt, 2);
  assert.equal(events.closed, 1);
});

test('synchronous API failure permits retry but successful redemption stays locked if rendering fails', async () => {
  const { context, events } = harness('employee'), dialog = {}, el = button(dialog);
  context.App.api.redeem = () => { throw new Error('Client failure'); };
  await context.acts.redeemOk(el);
  assert.equal(el.disabled, false);
  assert.equal(events.closed, 0);
  context.App.api.redeem = async () => {};
  context.rerender = () => { throw new Error('Render failure'); };
  await assert.rejects(context.acts.redeemOk(el), /Render failure/);
  assert.equal(el.disabled, true);
  assert.equal(dialog.redeemPending, true);
});
