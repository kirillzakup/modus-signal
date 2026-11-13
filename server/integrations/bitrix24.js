'use strict';
/**
 * Необязательная интеграция с Битрикс24 через входящий вебхук.
 *   B24_WEBHOOK   — базовый URL вебхука, например https://portal.bitrix24.ru/rest/1/abc123def456/
 *   B24_USER_MAP  — JSON { "<id сотрудника в Сигнале>": <ID пользователя Б24>, "default": <ID> }
 * Ticket → «В работе»: создаётся задача tasks.task.add, её ID сохраняется в ticket.b24TaskId.
 * Ticket → «Реализовано» / «Отклонено» (или возврат в работу): комментарий task.commentitem.add.
 * Работает «по возможности»: ошибки логируются и никогда не блокируют API.
 */

function parseMap(raw, log) {
  if (!raw) return {};
  try { const m = JSON.parse(raw); return m && typeof m === 'object' ? m : {}; } catch (e) {
    log.warn('[b24] B24_USER_MAP — некорректный JSON, игнорирую');
    return {};
  }
}

function createBitrix24({ webhook, userMap, log = console, fetchImpl = globalThis.fetch } = {}) {
  if (!webhook) return { enabled: false, onTransition() { return Promise.resolve(); }, pending: () => Promise.resolve() };
  const base = webhook.endsWith('/') ? webhook : webhook + '/';
  const map = parseMap(userMap, log);
  const inflight = new Set();

  async function call(method, params) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetchImpl(base + method + '.json', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: ctrl.signal
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(`${method}: ${j.error_description || j.error || 'HTTP ' + r.status}`);
      return j.result;
    } finally { clearTimeout(timer); }
  }

  function track(p) { inflight.add(p); p.finally(() => inflight.delete(p)); return p; }

  /**
   * Вызывается после успешного перехода статуса.
   * store — объект хранилища (store.state, store.save()).
   */
  function onTransition(store, ticketId, from, to) {
    const t = store.state.tickets.find((x) => x.id === ticketId);
    if (!t || from === to) return Promise.resolve();
    const statusLabel = { done: 'Реализовано', rejected: 'Отклонено', work: 'В работе' }[to];
    let job = null;
    if (to === 'work' && !t.b24TaskId) {
      const fields = {
        TITLE: `[Сигнал] ${t.id} ${t.title}`,
        DESCRIPTION: [t.text, t.solution ? 'Предложенное решение: ' + t.solution : ''].filter(Boolean).join('\n\n')
      };
      const resp = map[t.assigneeId] != null ? map[t.assigneeId] : map.default;
      if (resp != null) fields.RESPONSIBLE_ID = resp;
      if (t.resolveDue) fields.DEADLINE = t.resolveDue;
      job = call('tasks.task.add', { fields }).then((res) => {
        const taskId = res && (res.task ? res.task.id : res.id || res);
        // Состояние могло смениться (сброс демо) — ищем обращение заново
        const cur = store.state.tickets.find((x) => x.id === ticketId);
        if (cur && taskId) { cur.b24TaskId = String(taskId); store.save(); }
        log.info(`[b24] ${ticketId}: создана задача ${taskId}`);
      });
    } else if (t.b24TaskId && statusLabel) {
      const text = to === 'done' ? `Обращение ${t.id} — ${statusLabel}. Итог: ${t.result}`
        : to === 'rejected' ? `Обращение ${t.id} — ${statusLabel}. Причина: ${t.rejectReason}`
          : `Обращение ${t.id} возвращено в работу`;
      job = call('task.commentitem.add', { TASKID: t.b24TaskId, FIELDS: { POST_MESSAGE: text } })
        .then(() => log.info(`[b24] ${ticketId}: комментарий в задачу ${t.b24TaskId}`));
    }
    if (!job) return Promise.resolve();
    return track(job.catch((e) => log.warn('[b24] ошибка интеграции:', e.message)));
  }

  return { enabled: true, onTransition, pending: () => Promise.all([...inflight]) };
}

module.exports = { createBitrix24 };
