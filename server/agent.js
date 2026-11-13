'use strict';
/**
 * ИИ-агент собственника: данные системы → core.ownerDigest → core.agentPrompt → LLM.
 * Без LLM (или при ошибке LLM) — отчёт по правилам (core.digestText).
 * Ежедневный отчёт за предыдущий день: REPORT_HOUR, Asia/Tashkent.
 */
const core = require('../public/core.js');
const { buildOwnerReport, periodFor } = require('./owner-reports');
const { enrichOwnerReport } = require('./owner-report-ai');

const NO_LLM_NOTE = 'ИИ не подключён: задайте LLM_API_KEY — сейчас показан отчёт по правилам';

function localDay(t) {
  const value = typeof t === 'number' ? t : Date.parse(t);
  return new Date(value + 5 * 3600000).toISOString().slice(0, 10);
}

/** Уведомление в формате ядра (seq 'notif', префикс 'n'). */
function pushNotification(state, userId, text, at) {
  state.seq.notif = (state.seq.notif || 0) + 1;
  state.notifications.push({ id: 'n' + state.seq.notif, userId, ticketId: null, text, at, read: false, delivered: false });
}

function createAgent({ store, llm, log = console, reportHour = 9, env = process.env, fetchImpl = globalThis.fetch }) {
  let dailyRunning = false;
  const listeners = { daily: null };

  /** Сформировать и сохранить отчёт сейчас. actorId = null — системный (без проверки прав). */
  async function generateReport(actorId, now = Date.now()) {
    if (actorId) {
      const u = store.state.users.find((x) => x.id === actorId);
      if (!u || u.role !== 'owner' || u.disabled === true || u.active === false) { const e = new Error('Отчёты доступны собственнику'); e.status = 403; e.code = 'forbidden'; throw e; }
    }
    if (!llm.configured || env.DEEPSEEK_API_KEY) {
      const report = await enrichOwnerReport(buildOwnerReport(store.state, { now }), { env, fetchImpl });
      if (actorId && !store.state.users.some(u => u.id === actorId && u.role === 'owner' && u.disabled !== true && u.active !== false)) {
        const e = new Error('Доступ изменён'); e.status = 403; e.code = 'forbidden'; throw e;
      }
      store.state.reports = (store.state.reports || []).filter(r => r.id !== report.id).slice(-119);
      store.state.reports.push(report); store.save(); return report;
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
    if (!llm.configured || env.DEEPSEEK_API_KEY) return list.find(r => r.id === 'daily-' + periodFor(now).day) || null;
    for (let i = list.length - 1; i >= 0; i--) if (localDay(list[i].at) === day) return list[i];
    return null;
  }

  /**
   * Проверка расписания (вызывается раз в минуту). Создаёт не более одного отчёта за сутки Asia/Tashkent,
   * не раньше REPORT_HOUR. Возвращает созданный отчёт или null.
   */
  async function runDaily(now = Date.now()) {
    if (dailyRunning) return null;
    if (new Date(now + 5 * 3600000).getUTCHours() < reportHour) return null;
    if (todaysReport(now)) return null;
    dailyRunning = true;
    try {
      const r = await generateReport(null, now);
      const state = store.state;
      state.users.filter((u) => u.role === 'owner').forEach((o) =>
        pushNotification(state, o.id, '📋 Ежедневный отчёт агента готов. Решённые вопросы и участие команды — в кабинете собственника.', r.at));
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
