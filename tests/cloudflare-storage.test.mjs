import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = process.env.MODUS_TEST_SOURCE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { CompanyStore } = await import(pathToFileURL(resolve(root, 'cloudflare/store.mjs')));
const { BodyBudget, canonicalFiles, readBounded, uploadFile, serveFile } = await import(pathToFileURL(resolve(root, 'cloudflare/files.mjs')));

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const calls = [];
  const storage = {
    sql: {
      exec(query, ...params) {
        calls.push(query);
        const args = params.map(p => p instanceof ArrayBuffer ? new Uint8Array(p) : p);
        const stmt = db.prepare(query);
        const rows = stmt.columns().length ? stmt.all(...args).map(row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k, v instanceof Uint8Array ? v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength) : v]))) : (stmt.run(...args), []);
        return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
      }
    },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const result=fn();db.exec('COMMIT');return result; }
      catch(error) { db.exec('ROLLBACK');throw error; }
    }
  };
  const store = new CompanyStore(storage);
  calls.length = 0;
  return { store, storage, calls };
}
function request(bytes, extra = {}) {
  return new Request('https://signal.test/api/files', { method:'POST', body:bytes, headers: { 'content-type':'image/png', 'x-file-name':encodeURIComponent('Фото входа.png'), ...extra } });
}
async function uploaded(store, bytes = new Uint8Array([1,2,3]), owner='o1') {
  const response=await uploadFile(request(bytes),store,owner,{});
  assert.equal(response.status,201);
  return response.json();
}

test('state diff saves only changed records, survives reload and removes records transactionally', t => {
  const {store,calls}=fixture(t);
  store.save();
  assert.equal(calls.filter(q=>/^(INSERT|UPDATE|DELETE)/.test(q)).length,0);
  calls.length=0;
  store.state.users[0].name='Действующий собственник';
  store.save();
  assert.equal(calls.filter(q=>q.startsWith('INSERT INTO records')).length,1);
  store.reload();
  assert.equal(store.state.users[0].name,'Действующий собственник');
  const removed=store.state.entries.shift().id;
  store.save();store.reload();
  assert.ok(!store.state.entries.some(e=>e.id===removed));
  assert.equal(store.state.entries.length,1);
});

test('failed save rolls back earlier record writes and reload recovers known persisted state', t => {
  const {store}=fixture(t);
  store.state.users[0].name='Unsaved mutation';
  store.state.entries.push({ name:'Invalid record without id' });
  assert.throws(()=>store.save(),/Invalid persistent record/);
  store.reload();
  assert.equal(store.state.users[0].name,'Собственник');
  assert.equal(store.state.entries.length,2);
});

test('rate limiter persists rejected attempts across reload and expires deterministically', t => {
  const {store}=fixture(t);
  store.rateLimit('test',2,60000);store.rateLimit('test',2,60000);store.reload();
  assert.throws(()=>store.rateLimit('test',2,60000),{status:429});
  store.sql.exec('UPDATE rate_limits SET expires=? WHERE key=?',Date.now()-1,'test');
  store.rateLimit('test',2,60000);
  assert.equal(store.sql.exec('SELECT count FROM rate_limits WHERE key=?','test').toArray()[0].count,1);
});

test('chunked upload, whole reads, boundary ranges, suffix ranges and HEAD preserve exact bytes', async t => {
  const {store}=fixture(t), size=512*1024*2+19;
  const data=Uint8Array.from({length:size},(_,i)=>i%251);
  const file=await uploaded(store,data);
  assert.equal(file.owner,undefined);
  assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM file_parts WHERE file_id=?',file.id).toArray()[0].n,3);
  const full=serveFile(new Request('https://signal.test'+file.url),store,file.id);
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()),data);
  const first=512*1024-4,last=512*1024+5;
  const partial=serveFile(new Request('https://signal.test'+file.url,{headers:{range:`bytes=${first}-${last}`}}),store,file.id);
  assert.equal(partial.status,206);
  assert.equal(partial.headers.get('content-range'),`bytes ${first}-${last}/${size}`);
  assert.deepEqual(new Uint8Array(await partial.arrayBuffer()),data.slice(first,last+1));
  const suffix=serveFile(new Request('https://signal.test'+file.url,{headers:{range:'bytes=-13'}}),store,file.id);
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()),data.slice(-13));
  const head=serveFile(new Request('https://signal.test'+file.url,{method:'HEAD'}),store,file.id);
  assert.equal(head.headers.get('content-length'),String(size));
  assert.equal((await head.arrayBuffer()).byteLength,0);
  assert.equal(serveFile(new Request('https://signal.test'+file.url,{headers:{range:`bytes=${size}-`}}),store,file.id).status,416);
});

test('attachment metadata is canonical, owner-bound, restricted to ten files and never trusts a supplied URL', async t => {
  const {store}=fixture(t),file=await uploaded(store);
  const clean=canonicalFiles(store,[{id:file.id,url:'https://evil.example',type:'image/svg+xml',name:'forged.svg'}],'o1');
  assert.equal(clean[0].url,file.url);
  assert.equal(clean[0].type,'image/png');
  assert.equal(clean[0].name,'Фото входа.png');
  assert.throws(()=>canonicalFiles(store,[file],'u1'),{status:400});
  assert.throws(()=>canonicalFiles(store,Array.from({length:11},()=>file),'o1'),{status:400});
  assert.throws(()=>canonicalFiles(store,[{id:'missing'}],'o1'),{status:400});
});

test('uploads reject oversized declarations, streaming overflow, SVG, empty data and storage exhaustion', async t => {
  const {store}=fixture(t);
  await assert.rejects(uploadFile(request(new Uint8Array([1]),{'content-length':String(25*1024*1024+1)}),store,'o1',{}),{status:413});
  await assert.rejects(readBounded(request(new Uint8Array([1,2,3])),2),{status:413});
  await assert.rejects(uploadFile(request(new Uint8Array([1]),{'content-type':'image/svg+xml'}),store,'o1',{}),{status:415});
  await assert.rejects(uploadFile(request(new Uint8Array()),store,'o1',{}),{status:400});
  await assert.rejects(uploadFile(request(new Uint8Array(1025)),store,'o1',{MAX_STORAGE_MB:0.0001}),{status:507});
  assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM files').toArray()[0].n,0);
});

test('cleanup deletes aged orphans while preserving ticket and chat attachments', async t => {
  const {store}=fixture(t),orphan=await uploaded(store),ticket=await uploaded(store),chat=await uploaded(store);
  store.state.tickets.push({id:'test-ticket',attachments:[ticket]});
  store.state.chat.push({id:'test-chat',files:[chat]});
  store.sql.exec('UPDATE files SET at=?',Date.now()-2*86400000);
  store.cleanup();
  assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM file_parts WHERE file_id=?',orphan.id).toArray()[0].n,0);
  assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM files').toArray()[0].n,2);
  assert.equal(canonicalFiles(store,[ticket],'o1')[0].id,ticket.id);
  assert.equal(canonicalFiles(store,[chat],'o1')[0].id,chat.id);
});

test('body budget bounds concurrent bytes and request count until explicit release', () => {
  const budget=new BodyBudget(),mb=1024*1024;
  const releaseFile=budget.reserve(25*mb);
  assert.throws(()=>budget.reserve(25*mb),{status:429});
  const small=Array.from({length:7},()=>budget.reserve(mb));
  assert.throws(()=>budget.reserve(1),{status:429});
  releaseFile();releaseFile();
  const replacement=budget.reserve(25*mb);
  for(const release of small)release();
  replacement();
  assert.equal(budget.bytes,0);assert.equal(budget.count,0);
});

test('prebuffered upload stores bytes without reading the consumed request body again', async t => {
  const {store}=fixture(t),bytes=new Uint8Array([3,7,9]),req=request(bytes);
  const buffered=await readBounded(req,1024);
  const response=await uploadFile(req,store,'o1',{},buffered);
  assert.equal(response.status,201);
  const file=await response.json();
  assert.deepEqual(new Uint8Array(await serveFile(new Request('https://signal.test'+file.url),store,file.id).arrayBuffer()),bytes);
});

test('an unfinished incoming body times out instead of holding a request indefinitely', async () => {
  let cancelled=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}});
  const req=new Request('https://signal.test/api/files',{method:'POST',body:stream,duplex:'half'});
  await assert.rejects(readBounded(req,1024,25),{status:408});
  assert.equal(cancelled,true);
});
