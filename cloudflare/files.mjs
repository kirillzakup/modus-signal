const MAX_FILE = 25 * 1024 * 1024;
const PART = 512 * 1024;
const ID = /^[0-9a-f]{48}$/;
const TYPES = new Set(['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif','image/avif','image/bmp','image/tiff','video/mp4','video/webm','video/quicktime','application/pdf','application/msword','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/plain','text/csv']);
const error = (status, message) => Object.assign(new Error(message), { status,code:'file_error' });
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join('');

// Reserve the full permitted size, even when Content-Length is absent or false.
export class BodyBudget {
  constructor() { this.bytes=0; this.count=0; }
  reserve(max) {
    if(this.bytes+max>32*1024*1024 || this.count>=8)throw error(429,'Загрузка занята. Повторите через несколько секунд.');
    this.bytes+=max;this.count++;
    let released=false;
    return ()=>{if(!released){released=true;this.bytes-=max;this.count--;}};
  }
}

export async function readBounded(request,max,timeoutMs=15000) {
  const declared = Number(request.headers.get('content-length')||0);
  if(declared>max) throw error(413,'Превышен допустимый размер запроса');
  if(!request.body) return new Uint8Array();
  const reader=request.body.getReader(), chunks=[];let size=0,timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(error(408,'Время загрузки истекло. Повторите отправку.'));void reader.cancel().catch(()=>{});},timeoutMs);});
  try {
    while(true){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;size+=value.length;if(size>max){await reader.cancel();throw error(413,'Превышен допустимый размер запроса');}chunks.push(value);}
  } finally {clearTimeout(timer);reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;
}

export function getFile(store,id) {
  if(!ID.test(String(id)))return null;
  const row=store.sql.exec('SELECT data FROM files WHERE id=?',id).toArray()[0];
  return row?JSON.parse(row.data):null;
}

export function canonicalFiles(store, files, owner) {
  if(!Array.isArray(files))throw error(400,'Вложения должны быть списком');
  if(files.length>10)throw error(400,'Можно приложить до 10 файлов');
  return files.map(f=>{
    const saved=getFile(store,f?.id);
    if(!saved || saved.owner!==owner)throw error(400,'Файл не найден или загружен другим пользователем');
    return publicFile(saved);
  });
}

function publicFile(meta) { const {owner,...result}=meta;return result; }

export async function uploadFile(request,store,owner,env,bufferedBody) {
  const type=(request.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(!TYPES.has(type))throw error(415,'Допустимы фото, видео, PDF, Word, Excel, TXT и CSV');
  let name=request.headers.get('x-file-name')||'файл';try{name=decodeURIComponent(name);}catch{}
  name=name.replace(/[\u0000-\u001f\u007f/\\]/g,'_').slice(0,140)||'файл';
  const bytes=bufferedBody ?? await readBounded(request,MAX_FILE);
  if(bytes.length>MAX_FILE)throw error(413,'Превышен допустимый размер запроса');
  if(!bytes.length)throw error(400,'Пустой файл');
  const used=store.sql.exec('SELECT COALESCE(SUM(size),0) AS size FROM files').toArray()[0].size;
  if(used+bytes.length>Math.min(Number(env.MAX_STORAGE_MB)||900,900)*1024*1024)throw error(507,'Хранилище вложений заполнено. Обратитесь к администратору.');
  const id=randomId(),meta={id,name,type,size:bytes.length,owner,kind:type.startsWith('image/')?'image':type.startsWith('video/')?'video':'doc',url:'/api/files/'+id};
  store.storage.transactionSync(()=>{
    store.sql.exec('INSERT INTO files(id,data,size,at) VALUES(?,?,?,?)',id,JSON.stringify(meta),bytes.length,Date.now());
    for(let start=0,part=0;start<bytes.length;start+=PART,part++)store.sql.exec('INSERT INTO file_parts(file_id,part,bytes) VALUES(?,?,?)',id,part,bytes.slice(start,start+PART).buffer);
  });
  return Response.json(publicFile(meta),{status:201});
}

export function serveFile(request,store,id) {
  const meta=getFile(store,id);if(!meta)throw error(404,'Файл не найден');
  let start=0,end=meta.size-1,status=200;
  const range=request.headers.get('range');
  if(range){
    const m=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!m || (!m[1]&&!m[2]))return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+meta.size}});
    if(!m[1]){const suffix=Number(m[2]);if(!suffix)return new Response(null,{status:416});start=Math.max(0,meta.size-suffix);}
    else {start=Number(m[1]);if(m[2])end=Math.min(Number(m[2]),end);}
    if(start>end||start>=meta.size)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+meta.size}});status=206;
  }
  const headers={'Content-Type':meta.type,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'; img-src 'self'; media-src 'self'"};
  const inline=meta.kind!=='doc'||meta.type==='application/pdf';
  headers['Content-Disposition']=(inline?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(meta.name);
  if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${meta.size}`;
  if(request.method==='HEAD')return new Response(null,{status,headers});
  const first=Math.floor(start/PART),last=Math.floor(end/PART);
  let part=first;
  const stream=new ReadableStream({pull(controller){
    const row=store.sql.exec('SELECT bytes FROM file_parts WHERE file_id=? AND part=?',id,part).toArray()[0];
    if(!row){controller.error(new Error('Missing file data'));return;}
    const bytes=new Uint8Array(row.bytes);
    controller.enqueue(bytes.slice(part===first?start%PART:0,part===last?end%PART+1:bytes.length));
    if(part++===last)controller.close();
  }});
  return new Response(stream,{status,headers});
}
