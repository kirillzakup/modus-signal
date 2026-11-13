import core from '../public/core.js';
import { createProductionState } from './seed.mjs';

const COLLECTIONS = ['users','categories','tickets','events','ledger','notifications','redemptions','rewards','chat','reports','chests','entries'];
const META = ['seq','settings','departments','version'];

export class CompanyStore {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY(collection,id))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, data TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS file_parts (file_id TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(file_id,part))');
    this.reload();
    if (!this.state) this.state = createProductionState();
    core.ensureDefaults(this.state);
    this.state.departments = [];
    this.save();
  }

  reload() {
    const meta = this.sql.exec('SELECT key,value FROM meta').toArray();
    this.cached = new Map();
    this.metaCache = new Map(meta.map(r => [r.key, r.value]));
    if (!this.metaCache.has('version')) { this.state = null; return; }
    const state = {};
    for (const key of META) state[key] = JSON.parse(this.metaCache.get(key));
    for (const name of COLLECTIONS) state[name] = [];
    for (const row of this.sql.exec('SELECT collection,id,data,ordinal FROM records ORDER BY ordinal')) {
      if (!COLLECTIONS.includes(row.collection)) continue;
      state[row.collection].push(JSON.parse(row.data));
      this.cached.set(row.collection + ':' + row.id, { data: row.data, ordinal: row.ordinal });
    }
    this.state = state;
  }

  save() {
    const next = new Map(), meta = new Map();
    this.storage.transactionSync(() => {
      for (const collection of COLLECTIONS) {
        for (const [ordinal, item] of (this.state[collection] || []).entries()) {
          if (!item || item.id == null) throw new Error('Invalid persistent record');
          const id = String(item.id), key = collection + ':' + id, data = JSON.stringify(item);
          const previous = this.cached.get(key);
          if (!previous || previous.data !== data || previous.ordinal !== ordinal) {
            this.sql.exec('INSERT INTO records(collection,id,data,ordinal) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,ordinal=excluded.ordinal', collection,id,data,ordinal);
          }
          next.set(key, { data, ordinal });
        }
      }
      for (const key of this.cached.keys()) {
        if (!next.has(key)) { const split = key.indexOf(':'); this.sql.exec('DELETE FROM records WHERE collection=? AND id=?',key.slice(0,split),key.slice(split+1)); }
      }
      for (const key of META) {
        const value = JSON.stringify(this.state[key]);
        if (value !== this.metaCache.get(key)) this.sql.exec('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,value);
        meta.set(key,value);
      }
    });
    this.cached = next;
    this.metaCache = meta;
  }

  rateLimit(key, max, periodMs = 3600000) {
    const now = Date.now();
    const row = this.sql.exec('SELECT count,expires FROM rate_limits WHERE key=?',key).toArray()[0];
    if (row && row.expires > now && row.count >= max) throw Object.assign(new Error('Слишком много попыток. Повторите позже.'),{status:429,code:'rate_limited'});
    const count = row && row.expires > now ? row.count + 1 : 1;
    const expires = row && row.expires > now ? row.expires : now + periodMs;
    this.sql.exec('INSERT INTO rate_limits(key,count,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires=excluded.expires',key,count,expires);
  }

  cleanup() {
    this.sql.exec('DELETE FROM rate_limits WHERE expires<?',Date.now());
    const refs = new Set();
    for (const t of this.state.tickets) for (const f of t.attachments || []) refs.add(f.id);
    for (const c of this.state.chat) for (const f of c.files || []) refs.add(f.id);
    const orphans = this.sql.exec('SELECT id FROM files WHERE at<?',Date.now()-86400000).toArray().filter(f=>!refs.has(f.id));
    this.storage.transactionSync(()=>{for(const f of orphans){this.sql.exec('DELETE FROM file_parts WHERE file_id=?',f.id);this.sql.exec('DELETE FROM files WHERE id=?',f.id);}});
  }
}
