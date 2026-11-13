import core from '../public/core.js';

const routes = [];
function add(method, path, handler, publicRoute = false) {
  const keys = [];
  const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, key) => { keys.push(key); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, keys, handler, publicRoute });
}
export function apiError(status, code, message) { return Object.assign(new Error(message), { status, code }); }
const denied = () => apiError(403, 'forbidden', 'Недостаточно прав для этого действия');
const admin = me => { if (!core.isAdmin(me)) throw denied(); };
const staff = me => { if (!core.isStaff(me)) throw denied(); };
const owner = ({ state, me }) => { if (!core.isTriager(state, me)) throw denied(); };
const ticket = ({ state, me }, id) => core.getTicket(state, me.id, id);
const created = body => Response.json(body, { status: 201 });

function filters(query) {
  const out = {};
  for (const key of ['scope', 'status', 'type', 'categoryId', 'dept', 'priority', 'q', 'sort', 'from', 'to', 'paei', 'zone', 'quadrant', 'stage', 'box', 'entryId', 'assigneeId']) {
    if (query.get(key)) out[key] = query.get(key);
  }
  if (['1', 'true'].includes(query.get('overdue'))) out.overdue = true;
  if (['1', 'true'].includes(query.get('my'))) out.my = true;
  return out;
}
function visibleState({ state, me }) {
  if (core.isTriager(state, me)) return state;
  const ids = new Set(core.listTickets(state, me.id, {}).map(item => item.id));
  return { ...state, tickets: state.tickets.filter(item => ids.has(item.id)), events: state.events.filter(item => !item.ticketId || ids.has(item.ticketId)) };
}
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[;"\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
function profile(c, id) {
  const result = core.profile(visibleState(c), id, c.me.id);
  if (id !== c.me.id) {
    const u = result.user;
    result.user = { id: u.id, name: u.name, dept: u.dept, role: u.role, absent: !!u.absent };
  }
  return result;
}

add('GET', '/api/bootstrap', c => ({ ...core.bootstrap(c.state, c.me.id), auth: c.via, demo: false }));
add('GET', '/api/tickets', c => core.listTickets(c.state, c.me.id, filters(c.query)));
add('POST', '/api/tickets', c => {
  const result = core.createTicket(c.state, c.me.id, { ...c.body, _external: false, source: c.via === 'tma' ? 'tma' : 'web' });
  return created(ticket(c, result.id));
});
add('GET', '/api/tickets/:id', c => ticket(c, c.params.id));
add('POST', '/api/tickets/:id/transition', c => {
  const { comment, result, rejectReason, impact } = c.body;
  core.transition(c.state, c.me.id, c.params.id, c.body.to, { comment, result, rejectReason, impact });
  return ticket(c, c.params.id);
});
for (const [action, method, args] of [
  ['accept', 'accept', c => [c.body]], ['trash', 'toTrash', c => [c.body.reason]],
  ['restore', 'restore', () => []], ['move', 'moveCard', c => [c.body.col, c.body]],
  ['comments', 'addComment', c => [c.body.text, { internal: !!c.body.internal, clarify: !!c.body.clarify }]],
  ['assign', 'assign', c => [c.body.userId]], ['priority', 'setPriority', c => [c.body.priority]],
  ['vote', 'vote', () => []], ['claim', 'claim', () => []], ['nudge', 'nudge', () => []],
  ['verify', 'verifyEffect', c => [c.body]], ['classify', 'classify', c => [c.body]]
]) add('POST', '/api/tickets/:id/' + action, c => {
  core[method](c.state, c.me.id, c.params.id, ...args(c));
  return ticket(c, c.params.id);
});
add('POST', '/api/tickets/:id/options', c => { core.proposeOption(c.state, c.me.id, c.params.id, c.body); return created(ticket(c, c.params.id)); });
add('POST', '/api/tickets/:id/options/:oid/vote', c => { core.voteOption(c.state, c.me.id, c.params.id, c.params.oid); return ticket(c, c.params.id); });
add('POST', '/api/tickets/:id/options/:oid/choose', c => { core.chooseOption(c.state, c.me.id, c.params.id, c.params.oid, c.body.reason); return ticket(c, c.params.id); });
add('POST', '/api/tickets/:id/team/pass', c => { core.teamPass(c.state, c.me.id, c.params.id, c.body.note); return ticket(c, c.params.id); });
add('POST', '/api/tickets/:id/team/advance', c => { core.advanceTeam(c.state, c.me.id, c.params.id); return ticket(c, c.params.id); });
add('POST', '/api/tickets/:id/team/deadlines', c => { core.setTeamDeadlines(c.state, c.me.id, c.params.id, c.body); return ticket(c, c.params.id); });
add('POST', '/api/tickets/:id/steps', c => { core.addStep(c.state, c.me.id, c.params.id, c.body); return created(ticket(c, c.params.id)); });
add('PATCH', '/api/tickets/:id/steps/:sid', c => { core.setStep(c.state, c.me.id, c.params.id, c.params.sid, c.body); return ticket(c, c.params.id); });
add('GET', '/api/tasks', c => core.myTasks(c.state, c.me.id));
add('GET', '/api/solutions', c => core.solutionStats(visibleState(c)));

add('GET', '/api/admin/entries', c => core.listEntries(c.state, c.me.id));
add('POST', '/api/admin/entries', c => created(core.saveEntry(c.state, c.me.id, null, c.body)));
add('PUT', '/api/admin/entries/:id', c => core.saveEntry(c.state, c.me.id, c.params.id, c.body));
add('GET', '/api/public/entry/:code', c => core.publicEntry(c.state, c.params.code), true);
add('GET', '/api/public/track/:code', c => core.trackTicket(c.state, c.params.code), true);
add('POST', '/api/public/tickets', c => {
  if (String(c.body.website || '').trim()) return created({ id: 'A-000', trackCode: '', entryName: '' });
  return created(core.createPublicTicket(c.state, String(c.body.code || ''), {
    text: c.body.text, attachments: c.body.attachments,
    contactName: c.body.contactName, contactPhone: c.body.contactPhone
  }));
}, true);

add('GET', '/api/game', c => core.gameState(visibleState(c), c.me.id));
add('GET', '/api/game/season', c => core.seasonBoard(visibleState(c)));
add('POST', '/api/game/quests/:id/claim', c => core.claimQuest(c.state, c.me.id, c.params.id));
add('POST', '/api/game/chest', c => core.openChest(c.state, c.me.id));
add('POST', '/api/game/streak', c => core.claimStreak(c.state, c.me.id));
add('PUT', '/api/game/privacy', c => core.setHideRating(c.state, c.me.id, !!c.body.hide));
add('PUT', '/api/admin/team-goal', c => core.setTeamGoal(c.state, c.me.id, c.body.target, c.body.prize));
add('GET', '/api/method', c => core.methodStats(visibleState(c)));
add('POST', '/api/kudos', c => created(core.kudos(c.state, c.me.id, c.body.toUserId, c.body.text)));
add('POST', '/api/tone/check', c => core.carnegieCheck(String(c.body.text || ''), String(c.body.kind || '')));

add('GET', '/api/chat', c => core.listChat(c.state, c.me.id, { after: c.query.get('after') || undefined, limit: Math.max(1, Math.min(Number(c.query.get('limit')) || 200, 500)) }));
add('POST', '/api/chat', c => {
  const message = core.postChat(c.state, c.me.id, { text: c.body.text, files: c.body.files, replyTo: c.body.replyTo || null });
  return created(core.listChat(c.state, c.me.id, { limit: 50 }).find(item => item.id === message.id));
});

add('GET', '/api/owner/digest', c => { owner(c); return core.ownerDigest(c.state); });
add('GET', '/api/owner/people', c => { owner(c); return core.peopleStats(c.state); });
add('POST', '/api/owner/bonus', c => {
  owner(c);
  const record = core.bonus(c.state, c.me.id, c.body.userId, c.body.amount, c.body.reason);
  return created({ ...record, balance: core.balance(c.state, record.userId) });
});
add('GET', '/api/owner/reports', c => { if(c.me.role!=='owner')throw denied(); return c.state.reports.slice().reverse(); });
add('POST', '/api/owner/report', c => { owner(c); return created(core.saveReport(c.state, null, { source: 'rules' })); });
add('POST', '/api/agent/ask', c => {
  owner(c);
  const question = String(c.body.question || '').trim();
  if (question.length < 2 || question.length > 2000) throw apiError(400, 'validation', 'Вопрос должен содержать от 2 до 2000 символов');
  return { text: core.digestText(core.ownerDigest(c.state)), source: 'rules', model: null };
});
add('POST', '/api/agent/solutions', c => {
  ticket(c, String(c.body.ticketId || ''));
  const original = c.state.tickets.find(item => item.id === String(c.body.ticketId));
  return { options: [], source: 'rules', similar: core.similarSolved(visibleState(c), original) };
});
add('POST', '/api/agent/rewrite', c => {
  staff(c.me);
  const text = String(c.body.text || '').slice(0, 2000), kind = String(c.body.kind || '');
  if (text.trim().length < 3) throw apiError(400, 'validation', 'Пустой текст');
  return { text: null, source: 'rules', check: core.carnegieCheck(text, kind) };
});
add('GET', '/api/owner/redemptions', c => core.listRedemptions(c.state, c.me.id));
add('POST', '/api/owner/redemptions/:id', c => {
  if (typeof c.body.approve !== 'boolean') throw apiError(400, 'validation', 'Укажите решение: approve = true или false');
  return core.decideRedemption(c.state, c.me.id, c.params.id, c.body.approve, c.body.note);
});
add('GET', '/api/rewards', c => core.rewardsView(c.state, c.me.id));
add('POST', '/api/admin/rewards', c => created(core.updateReward(c.state, c.me.id, null, c.body)));
add('PUT', '/api/admin/rewards/:id', c => {
  if (!c.state.rewards.some(item => item.id === c.params.id)) throw apiError(404, 'not_found', 'Награда не найдена');
  return core.updateReward(c.state, c.me.id, c.params.id, c.body);
});
add('GET', '/api/similar', c => core.findSimilar(c.state, c.query.get('text') || '', c.query.get('exclude') || undefined, c.me.id));
add('GET', '/api/analytics', c => { staff(c.me); return core.analytics(visibleState(c)); });
add('GET', '/api/leaderboard', c => core.leaderboard(visibleState(c)));
add('GET', '/api/profile', c => profile(c, c.me.id));
add('GET', '/api/profile/:userId', c => profile(c, c.params.userId));
add('GET', '/api/notifications', c => core.notificationsOf(c.state, c.me.id));
add('POST', '/api/notifications/read', c => {
  core.markRead(c.state, c.me.id, Array.isArray(c.body.ids) ? c.body.ids.map(String) : undefined);
  return { ok: true, unread: c.state.notifications.filter(item => item.userId === c.me.id && !item.read).length };
});
add('POST', '/api/rewards/:id/redeem', c => created({ redemption: core.redeem(c.state, c.me.id, c.params.id), balance: core.balance(c.state, c.me.id) }));

add('POST', '/api/admin/categories', c => {
  admin(c.me);
  if (!String(c.body.name || '').trim()) throw apiError(400, 'validation', 'Укажите название категории');
  return created(core.updateCategory(c.state, c.me.id, null, c.body));
});
add('PUT', '/api/admin/categories/:id', c => core.updateCategory(c.state, c.me.id, c.params.id, c.body));
add('POST', '/api/admin/users', c => {
  if (c.body.role === 'admin' && c.me.role !== 'owner') throw denied();
  return created(core.createUser(c.state, c.me.id, c.body));
});
add('PUT', '/api/admin/users/:id', c => {
  const patch = { ...c.body }, target = c.state.users.find(item => item.id === c.params.id);
  if (patch.role != null && (c.me.role !== 'owner' || patch.role === 'owner' || target?.role === 'owner')) throw denied();
  if (c.me.role !== 'owner' && ['owner', 'admin'].includes(target?.role)) {
    const selfAbsenceOnly = target.id === c.me.id && Object.keys(patch).every(key => ['absent', 'absentNote'].includes(key));
    if (!selfAbsenceOnly) throw denied();
  }
  // Credentials remain in the auth store, never in the public user object.
  return core.updateUser(c.state, c.me.id, c.params.id, patch);
});
add('PUT', '/api/admin/settings', c => core.updateSettings(c.state, c.me.id, c.body));
add('POST', '/api/admin/reset', () => { throw apiError(403, 'forbidden', 'Сброс демонстрационных данных недоступен в рабочей версии'); });
add('GET', '/api/export.csv', c => {
  staff(c.me);
  const header = ['Номер', 'Тип', 'Категория', 'Автор', 'Подразделение', 'Приоритет', 'Статус', 'Ответственный', 'Создано', 'Первый ответ', 'Закрыто', 'Просрочено', 'Результат', 'Поддержали'];
  const rows = core.listTickets(c.state, c.me.id, { sort: 'created', ...filters(c.query) }).map(t => [t.id, core.TYPES[t.type]?.label, t.categoryName, t.authorName, t.authorDept, core.PRIORITIES[t.priority]?.label, core.STATUSES[t.status]?.label, t.assigneeName, t.createdAt, t.firstResponseAt, t.closedAt, t.overdue ? 'Да' : 'Нет', t.result || t.rejectReason, t.votesCount]);
  const csv = '\ufeff' + [header, ...rows].map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="modus-signal.csv"' } });
});

/** Parent owns the transaction, persistence, CSRF, rate limits and error serialization. */
export async function routeApi({ request, url = new URL(request.url), body = {}, me, store, env = {}, via = 'session' }) {
  for (const route of routes) {
    if (request.method !== route.method) continue;
    const match = url.pathname.match(route.pattern);
    if (!match) continue;
    const currentUser = me && store.state.users.find(item => item.id === me.id);
    if (!route.publicRoute && !currentUser) throw apiError(401, 'unauthorized', 'Войдите в систему');
    let params;
    try { params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])); }
    catch { throw apiError(400, 'validation', 'Некорректный адрес запроса'); }
    const result = await route.handler({ request, url, query: url.searchParams, body, me: currentUser, state: store.state, store, env, via, params });
    return result instanceof Response ? result : Response.json(result);
  }
  return null;
}
