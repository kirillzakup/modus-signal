'use strict';
/**
 * ИИ-агент собственника: данные системы → core.ownerDigest → core.agentPrompt → LLM.
 * Без LLM (или при ошибке LLM) — отчёт по правилам (core.digestText).
 * Плюс ежедневный отчёт по расписанию (REPORT_HOUR, локальное время сервера по TZ).
 */
const core = require('../public/core.js');

const NO_LLM_NOTE = 'ИИ не подключён: задайте LLM_API_KEY — сейчас показан отчёт по правилам';

function localDay(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Уведомление в формате ядра (seq 'notif', префикс 'n'). */
function pushNotification(state, userId, text, at) {
  state.seq.notif = (state.seq.notif || 0) + 1;
  state.notifications.push({ id: 'n' + state.seq.notif, userId, ticketId: null, text, at, read: false, delivered: false });
}

function createAgent({ store, llm, log = console, reportHour = 9 }) {
  let dailyRunning = false;
  const listeners = { daily: null };

  /** Сформировать и сохранить отчёт сейчас. actorId = null — системный (без проверки прав). */
  async function generateReport(actorId, now = Date.now()) {
    if (actorId) {
      const u = store.state.users.find((x) => x.id === actorId);
      if (!core.isAdmin(u)) { const e = new Error('Отчёты доступны собственнику'); e.status = 403; e.code = 'forbidden'; throw e; }
    }
    const digest = core.ownerDigest(store.state, now);
    let rep, error = null;
    if (llm.configured) {
      try {
        const r = await llm.complete(core.agentPrompt(digest));
        rep = { text: r.text, source: 'ai', model: r.model, digest };
      } catch (e) {
        error = e.message;
        log.warn('[agent] LLM недоступен, отчёт по правилам:', e.message);
      }
    }
    if (!rep) rep = { source: 'rules', digest };
    const saved = core.saveReport(store.state, actorId || null, rep, now);
    store.save();
    return error ? Object.assign({}, saved, { error }) : saved;
  }

  /** Ответ агента на вопрос собственника. */
  async function ask(question, history, now = Date.now()) {
    const q = String(question || '').trim();
    if (q.length < 2) { const e = new Error('Сформулируйте вопрос'); e.status = 400; e.code = 'validation'; throw e; }
    if (q.length > 2000) { const e = new Error('Слишком длинный вопрос (до 2000 символов)'); e.status = 400; e.code = 'validation'; throw e; }
    const digest = core.ownerDigest(store.state, now);
    const rules = () => core.digestText(digest) + '\n\n' + NO_LLM_NOTE;
    if (!llm.configured) return { text: rules(), source: 'rules', model: null };
    try {
      const r = await llm.complete(core.agentPrompt(digest, q), { history });
      return { text: r.text, source: 'ai', model: r.model };
    } catch (e) {
      log.warn('[agent] LLM недоступен:', e.message);
      return { text: core.digestText(digest), source: 'rules', model: null, error: e.message };
    }
  }

  function todaysReport(now = Date.now()) {
    const day = localDay(now);
    const list = store.state.reports || [];
    for (let i = list.length - 1; i >= 0; i--) if (localDay(list[i].at) === day) return list[i];
    return null;
  }

  /**
   * Проверка расписания (вызывается раз в минуту). Создаёт не более одного отчёта за локальные сутки,
   * не раньше REPORT_HOUR. Возвращает созданный отчёт или null.
   */
  async function runDaily(now = Date.now()) {
    if (dailyRunning) return null;
    if (new Date(now).getHours() < reportHour) return null;
    if (todaysReport(now)) return null;
    dailyRunning = true;
    try {
      const r = await generateReport(null, now);
      const state = store.state;
      state.users.filter((u) => u.role === 'owner').forEach((o) =>
        pushNotification(state, o.id, '📋 Ежедневный отчёт агента готов: пульс ' + r.health.score + '/100 — ' + r.health.label, r.at));
      store.save();
      log.info(`[agent] ежедневный отчёт ${r.id} (${r.source})`);
      if (listeners.daily) Promise.resolve().then(() => listeners.daily(r)).catch((e) => log.warn('[agent] доставка отчёта:', e.message));
      return r;
    } catch (e) {
      log.error('[agent] ошибка ежедневного отчёта', e);
      return null;
    } finally { dailyRunning = false; }
  }

  return {
    generateReport, ask, runDaily, todaysReport,
    onDaily(fn) { listeners.daily = fn; },
    get info() { return llm.info; }
  };
}

module.exports = { createAgent, localDay, pushNotification, NO_LLM_NOTE };
