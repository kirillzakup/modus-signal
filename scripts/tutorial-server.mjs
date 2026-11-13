// Isolated, loopback-only filming fixture. Never deploy or import into the Worker.
// Uses the production UI, auth, workflow and storage. Telegram identity/membership
// is simulated with a fake signing key and visibly labelled as a training example.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
const scriptDir=path.dirname(fileURLToPath(import.meta.url));
const root=fs.existsSync(path.resolve(scriptDir,'../public/core.js'))?path.resolve(scriptDir,'..'):path.resolve(scriptDir,'../../..');
const load=relative=>import(pathToFileURL(path.join(root,relative)).href);
const [{default:core},{CompanyStore},{createAuth},{routeApi},{canonicalFiles,uploadFile,serveFile},{default:personalAssistant},{default:ownerReports},{default:ownerAi}]=await Promise.all([
  load('public/core.js'),load('cloudflare/store.mjs'),load('cloudflare/auth.mjs'),load('cloudflare/routes.mjs'),load('cloudflare/files.mjs'),
  load('server/personal-assistant.js'),load('server/owner-reports.js'),load('server/owner-report-ai.js')
]);
const run=process.env.TUTORIAL_RUN||'v2';
if(!/^v2(?:-[a-z0-9-]{1,40})?$/.test(run))throw new Error('TUTORIAL_RUN must be v2 or v2-suffix');
const artifacts=path.join(root,'artifacts/tutorial-'+run);
fs.mkdirSync(artifacts,{recursive:true});
const port=Number(process.env.TUTORIAL_PORT||8791);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local tutorial port');
const origin='http://127.0.0.1:'+port;
const nativeFetch=globalThis.fetch.bind(globalThis);
const aiEnv={};
if(process.env.TUTORIAL_REAL_AI==='1'){
  const key=fs.readFileSync(path.join(root,'config/deepseek-key.txt'),'utf8').trim();
  if(!key||/[\r\n]/.test(key))throw new Error('Local DeepSeek key is missing or malformed');
  aiEnv.DEEPSEEK_API_KEY=key;
}
const deepseekFetch=(url,options)=>{
  if(String(url)!=='https://api.deepseek.com/chat/completions')throw new Error('Tutorial AI destination blocked');
  return nativeFetch(url,{...options,redirect:'error'});
};
const assistant=personalAssistant.createPersonalAssistant({core,env:aiEnv,fetchImpl:deepseekFetch});
const reportClock=process.env.TUTORIAL_REPORT_NOW;
if(reportClock&&(!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(reportClock)||!Number.isFinite(Date.parse(reportClock))||Math.abs(Date.parse(reportClock)-Date.now())>2*86400000))throw new Error('TUTORIAL_REPORT_NOW must be ISO within two days of today');
const botToken='1000000000:local-only-tutorial-signing-key';
const env={BOT_TOKEN:botToken,BOT_USERNAME:'Modus_agent_bot',TELEGRAM_GROUP_ID:'-1000000000000',SETUP_TOKEN:'tutorial-only-setup-'.repeat(4)};
const actors={owner:{id:9000000001,first_name:'Елена',last_name:'Петрова'},manager:{id:9000000002,first_name:'Илья',last_name:'Соколов'},employee:{id:9000000003,first_name:'Анна',last_name:'Смирнова'}};
const dbPath=path.join(artifacts,'tutorial.sqlite');
const db=new DatabaseSync(dbPath);
const storage={sql:{exec(query,...params){
  const stmt=db.prepare(query),args=params.map(p=>p instanceof ArrayBuffer?new Uint8Array(p):p);
  const rows=stmt.columns().length?stmt.all(...args).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Uint8Array?v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength):v]))):(stmt.run(...args),[]);
  return {toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]()};
}},transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
const store=new CompanyStore(storage),auth=createAuth(store,env);

// Telegram is simulated; only the explicit DeepSeek adapter can use native fetch.
globalThis.fetch=async(url,options={})=>{
  if(String(url)!=='https://api.telegram.org/bot'+botToken+'/getChatMember')throw new Error('Tutorial outbound request blocked');
  const id=String(JSON.parse(options.body).user_id);
  if(!Object.values(actors).some(a=>String(a.id)===id))return Response.json({ok:false},{status:403});
  return Response.json({ok:true,result:{status:'member',user:{id:Number(id)}}});
};
function initData(persona){
  const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify(actors[persona])});
  const key=createHmac('sha256','WebAppData').update(botToken).digest();
  const data=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');
  params.set('hash',createHmac('sha256',key).update(data).digest('hex'));
  return params.toString();
}
if((await (await auth.handle(new Request(origin+'/api/auth/status'))).json()).setupRequired){
  await auth.handle(new Request(origin+'/api/auth/setup',{method:'POST'}),{token:env.SETUP_TOKEN,name:'Елена Петрова',login:'tutorial.owner',password:'Tutorial-only-Owner-2026',initData:initData('owner')});
  const manager=core.createUser(store.state,'o1',{name:'Илья Соколов',jobTitle:'Координатор',role:'employee'});
  store.state.users.find(u=>u.id===manager.id).tgId=String(actors.manager.id);
  store.state.rewards=[];
  core.updateReward(store.state,'o1',null,{name:'Учебный кофе',icon:'☕',cost:20,stock:10,perUser:1,active:true,desc:'Учебный пример: покупку подтверждает собственник'});
  store.save();
}
const clipParts=new Map();
let queue=Promise.resolve();
const serial=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
function injection(persona){
  if(!actors[persona])return '';
  return '<script>window.Telegram={WebApp:{initData:'+JSON.stringify(initData(persona))+',initDataUnsafe:{user:'+JSON.stringify(actors[persona])+'},version:"7.0",platform:"web",ready:function(){},expand:function(){},setHeaderColor:function(){},setBackgroundColor:function(){},isVersionAtLeast:function(){return false;},onEvent:function(){},offEvent:function(){},BackButton:{onClick:function(){},show:function(){},hide:function(){}}}};</script>';
}
function personaControls(){
  const labels=Object.fromEntries(Object.entries(actors).map(([name,actor])=>[name,actor.first_name+' '+actor.last_name]));
  labels.web='Вход в приложение';
  return '<script>(function(){var labels='+JSON.stringify(labels)+',clock='+JSON.stringify(reportClock||'')+';window.tutorial.persona=function(name,hash){if(!Object.prototype.hasOwnProperty.call(labels,name))throw new Error("Unknown training persona");var fragment=hash?String(hash):"#/";if(fragment.charAt(0)!=="#")throw new Error("Expected application hash");document.getElementById("appFrame").src="/?"+(name==="web"?"":"tma=1&")+"persona="+name+fragment;document.getElementById("training").textContent="УЧЕБНЫЙ ПРИМЕР · "+labels[name]+(clock?" · отчёт: пример следующего дня":"");document.getElementById("cursor").style.display="none";window.tutorial.caption("");};if(clock)document.getElementById("training").textContent+=" · отчёт: пример следующего дня";})();</script>';
}
function stage(persona){
  const role={employee:'Сотрудник · Анна Смирнова',manager:'Ответственный · Илья Соколов',owner:'Собственник · Елена Петрова',web:'Вход в приложение'}[persona]||'Вход в приложение';
  const html='<!doctype html><html lang="ru"><meta charset="utf-8"><title>МОДУС СИГНАЛ · запись инструкции</title><style>body{margin:0;background:#dde5ed;display:grid;place-content:center;min-height:100vh;font:14px Arial}#stage{position:relative;width:1280px;height:720px;background:white;overflow:hidden}iframe{width:1280px;height:720px;border:0}#training{position:absolute;z-index:100;left:20px;top:10px;color:#cbd9e5;font:11px Arial;pointer-events:none;letter-spacing:.03em}#cursor{display:none;position:absolute;width:22px;height:22px;border:3px solid #e00000;border-radius:50%;background:#fff9;pointer-events:none;z-index:200;transition:left .35s ease,top .35s ease;box-shadow:0 0 0 7px #e000001a}#caption{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:8px;background:#082742ee;color:white;display:none;pointer-events:none;z-index:200}</style><div id="stage"><iframe id="appFrame" src="/?'+(persona==='web'?'':'tma=1&')+'persona='+persona+'"></iframe><div id="training">УЧЕБНЫЙ ПРИМЕР · '+role+'</div><div id="cursor"></div><div id="caption"></div></div><script>window.tutorial={point:function(x,y){var c=document.getElementById("cursor");c.style.display="block";c.style.left=(x-12)+"px";c.style.top=(y-12)+"px";},caption:function(t){var e=document.getElementById("caption");e.textContent=t;e.style.display=t?"block":"none";}};</script><script src="/__tutorial/recorder.js"></script></html>';
  return html.replace('</html>',personaControls()+'</html>');
}
async function api(request,url,bytes){
  const method=request.method,changing=['POST','PUT','PATCH','DELETE'].includes(method),p=url.pathname;
  if(changing&&request.headers.get('origin')!==origin)throw Object.assign(new Error('Origin mismatch'),{status:403});
  if(p==='/api/health')return Response.json({ok:true,mode:'server',demo:false,version:'tutorial-v2',bot:true,llm:{configured:false},assistant:assistant.info});
  const publicPath=p.startsWith('/api/public/')||p==='/api/auth/status';
  const me=publicPath?null:await auth.authenticate(request);
  if(/^\/api\/files\/[a-f0-9]{48}$/.test(p))return serveFile(request,store,p.split('/').pop());
  if(p==='/api/files'&&method==='POST'){
    if(!me)throw Object.assign(new Error('Требуется вход'),{status:401});
    return uploadFile(request,store,me.id,env,bytes);
  }
  let body={};if(bytes.length){try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw Object.assign(new Error('Некорректный JSON'),{status:400});}}
  const proof=p==='/api/auth/telegram/register'?await auth.prepareRegistration(body):null;
  const authResult=await auth.handle(request,body,me,proof);
  if(authResult){if(changing)store.save();return authResult;}
  if(!me&&!p.startsWith('/api/public/'))throw Object.assign(new Error('Войдите в систему'),{status:401,code:'unauthorized'});
  if(p==='/api/assistant/info'&&method==='GET')return Response.json(assistant.info);
  if(p==='/api/assistant/ask'){
    if(method!=='POST')throw Object.assign(new Error('Метод не поддерживается'),{status:405});
    store.rateLimit('tutorial-assistant:'+me.id,10,60000);
    const prepared=assistant.prepare(store.state,me.id,body);
    const answer=await assistant.complete(prepared);
    assistant.revalidate(store.state,me.id,body);
    return Response.json(answer);
  }
  if((p==='/api/owner/report'&&method==='POST')||(/^\/api\/owner\/reports\/[^/]+\/pdf$/.test(p)&&method==='GET')){
    if(me.role!=='owner')throw Object.assign(new Error('Отчёты доступны собственнику'),{status:403,code:'forbidden'});
    store.rateLimit('tutorial-owner-report:'+me.id,5,60000);
    if(method==='POST'){
      const report=await ownerAi.enrichOwnerReport(ownerReports.buildOwnerReport(store.state,{now:reportClock?Date.parse(reportClock):Date.now()}),{env:aiEnv,fetchImpl:deepseekFetch});
      if(reportClock){report.tutorialClock=reportClock;report.text='УЧЕБНЫЙ ПРИМЕР СЛЕДУЮЩЕГО ДНЯ\n'+report.text;}
      store.state.reports=store.state.reports.filter(r=>r.id!==report.id).slice(-119);store.state.reports.push(report);store.save();
      return Response.json(report,{status:201});
    }
    const report=store.state.reports.find(r=>r.id===decodeURIComponent(p.split('/')[4])&&r.kind==='owner-daily');
    if(!report)throw Object.assign(new Error('Отчёт не найден'),{status:404,code:'not_found'});
    const pdf=await ownerReports.renderOwnerReportPdf(report,{fontBytes:fs.readFileSync(path.join(root,'public/vendor/NotoSans-Regular.ttf'))});
    return new Response(pdf,{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="tutorial-modus-report-'+report.day+'.pdf"'}});
  }
  if(body.attachments)body.attachments=canonicalFiles(store,body.attachments,me?.id);
  const result=await routeApi({request,url,body,me,store,env,via:'tma'});
  if(changing)store.save();
  return result||Response.json({error:'Не найдено'},{status:404});
}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.headers.host!=='127.0.0.1:'+port){res.writeHead(403).end();return;}
    const url=new URL(req.url,origin);
    const parts=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>25*1024*1024)throw Object.assign(new Error('Too large'),{status:413});parts.push(chunk);}
    const bytes=Buffer.concat(parts);
    if(url.pathname==='/__tutorial/recorder.js'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'}).end(fs.readFileSync(path.join(root,'scripts/tutorial-recorder.js')));return;
    }
    if(url.pathname==='/__tutorial/clip'&&req.method==='POST'){
      if(req.headers.origin!==origin||req.headers['content-type']!=='video/webm')throw Object.assign(new Error('Invalid capture origin'),{status:403});
      const name=url.searchParams.get('scene'),part=Number(url.searchParams.get('part'));
      if(!/^\d{2}(?:-[a-z0-9]+)?$/.test(name)||!Number.isInteger(part)||part<0)throw new Error('Invalid clip identifier');
      const folder=path.join(artifacts,'clips');fs.mkdirSync(folder,{recursive:true});const target=path.join(folder,name+'.webm');
      if(part===0){fs.writeFileSync(target,bytes,{flag:'wx'});clipParts.set(name,1);}
      else {if(clipParts.get(name)!==part)throw new Error('Out-of-order clip chunk');fs.appendFileSync(target,bytes);clipParts.set(name,part+1);}
      res.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true}');return;
    }
    if(url.pathname==='/__tutorial/checkpoint'&&req.method==='POST'){
      if(req.headers.origin!==origin)throw Object.assign(new Error('Origin mismatch'),{status:403});
      const name=JSON.parse(bytes.toString()).name;if(!/^[a-z0-9_-]{1,60}$/.test(name))throw new Error('Invalid checkpoint');
      await serial(()=>{store.save();fs.copyFileSync(dbPath,path.join(artifacts,name+'.sqlite'));});
      res.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true}');return;
    }
    if(url.pathname.startsWith('/api/')){
      const request=new Request(url,{method:req.method,headers:req.headers});
      const response=await serial(()=>api(request,url,bytes).catch(e=>{store.reload();throw e;}));
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(url.pathname==='/stage'){
      const persona=['web','employee','owner','manager'].includes(url.searchParams.get('persona'))?url.searchParams.get('persona'):'web';
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(stage(persona));return;
    }
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!['index.html','core.js','auth-ui.js','display-ui.js','workspace.css','team-ui.js','team.css','telegram-avatar.png','vendor/NotoSans-Regular.ttf'].includes(name)){res.writeHead(404).end();return;}
    let content=fs.readFileSync(path.join(root,'public',name));
    if(name==='index.html')content=Buffer.from(content.toString('utf8').replace('<script src="auth-ui.js"></script>',injection(url.searchParams.get('persona'))+'<script src="auth-ui.js"></script>'));
    const type=name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':name.endsWith('.ttf')?'font/ttf':'text/html';
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'}).end(content);
  }catch(e){res.writeHead(e.status||({validation:400,forbidden:403,not_found:404,unauthorized:401}[e.code])||500,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({error:e.message,code:e.code||'error'}));}
});
server.listen(port,'127.0.0.1',()=>console.log('Isolated tutorial fixture: '+origin+'/stage?persona=web'));
