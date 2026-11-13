'use strict';
/**
 * Хранилище состояния МОДУС · СИГНАЛ на SQLite (node:sqlite, без внешних зависимостей).
 *
 * Каждая коллекция состояния ядра — отдельная таблица (id TEXT PRIMARY KEY, data TEXT JSON),
 * скаляры (seq, settings, departments, version) — в таблице meta.
 * Порядок элементов массивов сохраняется через rowid (вставка в исходном порядке).
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const core = require('../public/core.js');

const COLLECTIONS = ['users', 'categories', 'tickets', 'events', 'ledger', 'notifications', 'redemptions', 'rewards', 'chat', 'reports', 'chests', 'entries'];
const META_KEYS = ['seq', 'settings', 'departments', 'version'];

function openStore(dataDir, log = console, opts = {}) {
  const triage = opts.triage !== false; // фильтр собственника: все новые обращения сначала разбирает он
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  // Незавершённые загрузки после аварийной остановки
  for (const f of fs.readdirSync(path.join(dataDir, 'files'))) if (f.endsWith('.part')) fs.rmSync(path.join(dataDir, 'files', f), { force: true });
  const file = path.join(dataDir, 'modus.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');
  for (const c of COLLECTIONS) db.exec(`CREATE TABLE IF NOT EXISTS ${c} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  // Метаданные загруженных файлов (сами байты — в ${DATA_DIR}/files/<id>); не входят в состояние ядра
  db.exec('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, userId TEXT, at TEXT NOT NULL)');
  const insFile = db.prepare('INSERT INTO files (id, name, type, size, userId, at) VALUES (?, ?, ?, ?, ?, ?)');
  const getFile = db.prepare('SELECT id, name, type, size, userId, at FROM files WHERE id = ?');

  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const putMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const selectAll = {}, del = {}, ins = {};
  for (const c of COLLECTIONS) {
    selectAll[c] = db.prepare(`SELECT data FROM ${c} ORDER BY rowid`);
    del[c] = db.prepare(`DELETE FROM ${c}`);
    ins[c] = db.prepare(`INSERT INTO ${c} (id, data) VALUES (?, ?)`);
  }

  /** Загрузка состояния; null — если база пуста. */
  function load() {
    const v = getMeta.get('version');
    if (!v) return null;
    const state = core.emptyState();
    for (const c of COLLECTIONS) state[c] = selectAll[c].all().map((r) => JSON.parse(r.data));
    for (const k of META_KEYS) {
      const row = getMeta.get(k);
      if (row) state[k] = JSON.parse(row.value);
    }
    return state;
  }

  /**
   * Миграция старой базы: недостающие пользователи из core.emptyState() (например, 'o1')
   * и недостающие коллекции. Возвращает true, если что-то добавлено.
   */
  function migrate(state) {
    let changed = false;
    const base = core.emptyState();
    for (const u of base.users) {
      if (!state.users.some((x) => x.id === u.id)) { state.users.push(u); changed = true; }
    }
    // Старый каталог наград (course/dayoff/merch/cert/lunch без icon) → новый каталог с лимитами
    const OLD = ['course', 'dayoff', 'merch', 'cert', 'lunch'];
    if (Array.isArray(state.rewards) && state.rewards.length && state.rewards.every((r) => OLD.includes(r.id) && r.icon == null)) {
      state.rewards = base.rewards; changed = true;
    }
    for (const k of Object.keys(base)) {
      if (state[k] === undefined || state[k] === null) { state[k] = base[k]; changed = true; }
    }
    // Новые настройки (фильтр собственника, корзина) и точки входа для старой базы
    for (const k of Object.keys(base.settings)) {
      if (state.settings[k] === undefined) { state.settings[k] = base.settings[k]; changed = true; }
    }
    if (!state.entries.length) { core.ensureDefaults(state); changed = true; }
    if (!triage && state.settings.ownerTriage) { state.settings.ownerTriage = false; changed = true; }
    return changed;
  }

  /** Полная запись состояния в одной транзакции (для объёмов MVP этого достаточно). */
  function save(state) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of COLLECTIONS) {
        del[c].run();
        const seen = new Set();
        for (const item of state[c] || []) {
          if (!item || item.id == null || seen.has(String(item.id))) continue;
          seen.add(String(item.id));
          ins[c].run(String(item.id), JSON.stringify(item));
        }
      }
      for (const k of META_KEYS) putMeta.run(k, JSON.stringify(state[k] === undefined ? null : state[k]));
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* уже откатано */ }
      throw e;
    }
  }

  const store = {
    file,
    state: null,
    load,
    save() { save(store.state); },
    /** Перечитать состояние из БД (откат несохранённых изменений в памяти). */
    reload() { const s = load(); if (s) store.state = s; return store.state; },
    filesDir: path.join(dataDir, 'files'),
    addFile(f) { insFile.run(f.id, f.name, f.type, f.size, f.userId || null, f.at); },
    getFile(id) { const r = getFile.get(id); return r ? Object.assign({}, r) : null; },
    reseed(now) { store.state = core.createSeedState(now, { triage }); save(store.state); return store.state; },
    close() { try { db.close(); } catch (_) { /* ignore */ } }
  };

  const loaded = load();
  if (loaded) {
    store.state = loaded;
    if (migrate(store.state)) { save(store.state); log.info && log.info('[db] миграция: добавлены новые пользователи/коллекции'); }
  } else {
    store.state = core.createSeedState(undefined, { triage });
    save(store.state);
    log.info && log.info('[db] база пуста — загружены демонстрационные данные (20 обращений)');
  }
  return store;
}

module.exports = { openStore, COLLECTIONS, META_KEYS };
