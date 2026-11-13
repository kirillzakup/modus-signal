import ownerReports from '../server/owner-reports.js';
import ownerAi from '../server/owner-report-ai.js';
import { DurableObject } from 'cloudflare:workers';
import core from '../public/core.js';
import personalAssistant from '../server/personal-assistant.js';
import { CompanyStore } from './store.mjs';
import { createAuth } from './auth.mjs';
import { createTelegram } from './telegram.mjs';
import { routeApi } from './routes.mjs';
import { BodyBudget, readBounded, uploadFile, serveFile, canonicalFiles } from './files.mjs';

const fail = (status,code,message) => Object.assign(new Error(message),{status,code});
const WRITE = new Set(['POST','PUT','PATCH','DELETE']);
function parseBody(bytes) {
  let body;
  try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw fail(400,'bad_json','Некорректный JSON');}
  if(!body||typeof body!=='object'||Array.isArray(body))throw fail(400,'validation','Ожидается объект');
  return body;
}
function responseError(e) {
  const status=e.status || ({forbidden:403,not_found:404,validation:400,unauthorized:401}[e.code]) || 500;
  const assistantError=['ai_not_configured','ai_balance','ai_configuration','ai_unavailable','ai_timeout','ai_empty_response','ai_invalid_response','ai_truncated','ai_response_size'].includes(e.code);
  return Response.json({error:status>=500&&!assistantError?'Сервис временно недоступен. Повторите запрос позже.':e.message,code:e.code||'internal_error'},{status});
}
function secure(response) {
  const headers=new Headers(response.headers);
  headers.set('Cache-Control','no-store');
  headers.set('X-Content-Type-Options','nosniff');
  headers.set('Referrer-Policy','no-referrer');
  return new Response(response.body,{status:response.status,headers});
}

export class Company extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.store=new CompanyStore(ctx.storage);
    this.auth=createAuth(this.store,env);
    this.pending=Promise.resolve();
    this.telegram=createTelegram(this.store,env,{serialize:fn=>this.serial(fn)});
    this.bodyBudget=new BodyBudget();
    this.assistant=personalAssistant.createPersonalAssistant({core,env});
    this.assistantPending=new Set();
  }

  serial(fn) {
    const result=this.pending.then(fn);
    this.pending=result.catch(()=>{});
    return result;
  }

  scheduleNotifications() {
    if(this.notificationsPending||!this.telegram.enabled)return;
    this.notificationsPending=true;
    this.ctx.waitUntil(this.drainNotifications()
      .catch(()=>console.warn('Telegram delivery will be retried.'))
      .finally(()=>{this.notificationsPending=false;}));
  }

  async drainNotifications() {
    if(!this.telegram.enabled)return;
    try{return await this.telegram.flushNotifications(10);}
    finally{
      const next=await this.serial(()=>{
        const pending=this.store.state.notifications.filter(n=>n.delivered===false);
        if(!pending.length)return null;
        const pause=this.store.sql.exec("SELECT value FROM telegram_meta WHERE key='pause_until'").toArray()[0]?.value||0;
        const earliest=Math.min(...pending.map(n=>Number(n.tgNextAttemptAt)||0));
        return Math.max(Date.now()+10000,Number(pause),earliest);
      });
      if(next){const current=await this.ctx.storage.getAlarm();if(!current||current>next)await this.ctx.storage.setAlarm(next);}
    }
  }

  async alarm() { await this.drainNotifications(); }

  async askAssistant(request,bytes) {
    if(request.method!=='POST')throw fail(405,'method','Метод не поддерживается');
    if(!(request.headers.get('content-type')||'').startsWith('application/json'))throw fail(415,'content_type','Ожидается JSON');
    const body=parseBody(bytes);
    const {actorId,prepared}=await this.serial(async()=>{
      const me=await this.auth.authenticate(request);
      if(!me)throw fail(401,'unauthorized','Войдите в систему');
      if(this.assistantPending.has(me.id))throw fail(429,'ai_in_progress','Дождитесь ответа на предыдущий вопрос');
      const prepared=this.assistant.prepare(this.store.state,me.id,body);
      this.store.rateLimit('assistant:'+me.id,10,60000);
      this.assistantPending.add(me.id);
      return {actorId:me.id,prepared};
    });
    try{
      const result=await this.assistant.complete(prepared);
      return await this.serial(async()=>{
        const me=await this.auth.authenticate(request);
        if(!me||me.id!==actorId)throw fail(401,'unauthorized','Войдите в систему');
        this.assistant.revalidate(this.store.state,actorId,body);
        return Response.json(result);
      });
    }finally{await this.serial(()=>this.assistantPending.delete(actorId));}
  }

  async fetch(request) {
    // Read incoming bodies outside the company queue: a slow uploader must not
    // delay other employees, authentication or scheduled maintenance.
    let release=()=>{},bytes,registrationProof;
    try {
      const incomingUrl=new URL(request.url),incomingPath=incomingUrl.pathname;
      if(!['GET','HEAD',...WRITE].includes(request.method))throw fail(405,'method','Метод не поддерживается');
      if(incomingPath==='/api/telegram/webhook'&&request.method!=='POST')throw fail(405,'method','Метод не поддерживается');
      if(WRITE.has(request.method)){
        const url=new URL(request.url),path=url.pathname;
        if(path==='/api/telegram/webhook'){
          if(request.method!=='POST')throw fail(405,'method','Метод не поддерживается');
          this.telegram.verifyWebhook(request);
        }else if(request.headers.get('origin')!==url.origin)throw fail(403,'origin_mismatch','Запрос должен быть отправлен из приложения');
        const limit=['/api/files','/api/public/files'].includes(path)?25*1024*1024:path==='/api/assistant/ask'?128*1024:1024*1024;
        if(Number(request.headers.get('content-length'))>limit)throw fail(413,'body_size','Превышен допустимый размер запроса');
        release=this.bodyBudget.reserve(limit);
        bytes=await readBounded(request,limit);
      }
      if((incomingPath==='/api/owner/report'&&request.method==='POST')||(/^\/api\/owner\/reports\/[^/]+\/pdf$/.test(incomingPath)&&request.method==='GET')){
        const actor=await this.serial(async()=>{const u=await this.auth.authenticate(request);if(!u||u.role!=='owner')throw fail(403,'forbidden','Отчёты доступны собственнику');this.store.rateLimit('owner-report:'+u.id,5,60000);return u.id;});
        if(request.method==='POST'){const report=await this.dailyReport(true);await this.serial(async()=>{const u=await this.auth.authenticate(request);if(!u||u.id!==actor||u.role!=='owner')throw fail(403,'forbidden','Доступ изменён');});return secure(Response.json(report));}
        const id=decodeURIComponent(incomingPath.split('/')[4]);
        const report=await this.serial(()=>{const r=this.store.state.reports.find(x=>x.id===id&&x.kind==='owner-daily');if(!r)throw fail(404,'not_found','Отчёт не найден');return structuredClone(r);});
        const font=await this.env.ASSETS.fetch(new Request(new URL('/vendor/NotoSans-Regular.ttf',request.url)));
        if(!font.ok)throw fail(503,'font','Шрифт PDF недоступен');
        const pdf=await ownerReports.renderOwnerReportPdf(report,{fontBytes:new Uint8Array(await font.arrayBuffer())});
        await this.serial(async()=>{const u=await this.auth.authenticate(request);if(!u||u.id!==actor||u.role!=='owner')throw fail(403,'forbidden','Доступ изменён');});
        return secure(new Response(pdf,{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="modus-report-'+report.day+'.pdf"'}}));
      }
      if(incomingPath==='/api/telegram/webhook')return secure(await this.telegram.handleUpdate(parseBody(bytes)));
      if(incomingPath==='/api/assistant/ask'){
        release();
        return secure(await this.askAssistant(request,bytes));
      }
      if(incomingPath==='/api/auth/telegram/register'&&request.method==='POST'){
        const ip=request.headers.get('CF-Connecting-IP')||'local';
        const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip));
        const key=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
        await this.serial(()=>this.store.rateLimit('register:'+key,8,15*60000));
        registrationProof=await this.auth.prepareRegistration(parseBody(bytes));
      }
      const response=await this.serial(async()=>{
        try {return secure(await this.handle(request,bytes,registrationProof));}
        catch(e){this.store.reload();return secure(responseError(e));}
      });
      if(response.ok&&WRITE.has(request.method))this.scheduleNotifications();
      return response;
    }catch(e){return secure(responseError(e));}
    finally{release();}
  }

  async handle(request,bufferedBody,registrationProof) {
    const url=new URL(request.url),path=url.pathname,method=request.method;
    const changing=WRITE.has(method);
    if(changing){
      const origin=request.headers.get('origin');
      if(origin!==url.origin)throw fail(403,'origin_mismatch','Запрос должен быть отправлен из приложения');
    }
    if(path==='/api/health'&&method==='GET')return Response.json({ok:true,mode:'server',demo:false,version:'5.1.0',hosting:'cloudflare',bot:this.telegram.enabled,llm:{configured:false},assistant:this.assistant.info});
    const ip=request.headers.get('CF-Connecting-IP')||'local';
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip));
    const client=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    if(changing&&/^\/api\/auth\/(login|setup)$/.test(path))this.store.rateLimit('auth:'+client,8,15*60000);
    if(path.startsWith('/api/public/')){
      const kind=path==='/api/public/files'?'upload':method==='POST'?'submit':'read';
      this.store.rateLimit('public:'+kind+':'+client,kind==='upload'?20:kind==='submit'?5:240);
    }
    if(changing)this.store.rateLimit('write:'+client,300,60000);
    const publicPath=path.startsWith('/api/public/')||/^\/api\/files\/[a-f0-9]{48}$/.test(path)||path==='/api/auth/status';
    const me=publicPath?null:await this.auth.authenticate(request);
    const fileMatch=/^\/api\/files\/([a-f0-9]{48})$/.exec(path);
    if(fileMatch&&['GET','HEAD'].includes(method))return serveFile(request,this.store,fileMatch[1]);
    if(method==='POST'&&(path==='/api/files'||path==='/api/public/files')){
      let owner=me?.id;
      if(path==='/api/public/files'){
        const entry=core.publicEntry(this.store.state,url.searchParams.get('code'));
        if(!entry.active)throw fail(403,'closed','Точка входа отключена');
        owner='entry:'+url.searchParams.get('code');
      }else if(!me)throw fail(401,'unauthorized','Войдите в систему');
      return uploadFile(request,this.store,owner,this.env,bufferedBody);
    }
    let body={};
    if(changing){
      const bytes=bufferedBody ?? new Uint8Array();
      if(bytes.length){
        if(!(request.headers.get('content-type')||'').startsWith('application/json'))throw fail(415,'content_type','Ожидается JSON');
        body=parseBody(bytes);
      }
    }
    const authResponse=await this.auth.handle(request,body,me,registrationProof);
    if(authResponse){if(changing)this.store.save();return authResponse;}
    if(!me&&!path.startsWith('/api/public/'))throw fail(401,'unauthorized','Войдите в систему');
    if(path==='/api/assistant/info'&&method==='GET')return Response.json(this.assistant.info);
    if(body.attachments!=null)body.attachments=canonicalFiles(this.store,body.attachments,path==='/api/public/tickets'?'entry:'+body.code:me?.id);
    if(path==='/api/chat'&&body.files!=null)body.files=canonicalFiles(this.store,body.files,me?.id);
    const response=await routeApi({request,url,body,me,store:this.store,env:this.env,via:request.headers.get('authorization')?.startsWith('tma ')?'tma':'session'});
    if(!response)throw fail(404,'not_found','Адрес не найден');
    if(changing)this.store.save();
    return response;
  }

  async dailyReport(force=false){
    if(this.reportPending){if(force)throw fail(429,'report_busy','Отчёт уже формируется');return null;}
    this.reportPending=true;
    try{
      const base=await this.serial(()=>{const r=ownerReports.buildOwnerReport(this.store.state,{now:Date.now()});const old=this.store.state.reports.find(x=>x.id===r.id);if(old&&!force)return null;this.store.state.reports=this.store.state.reports.filter(x=>x.id!==r.id).slice(-119);this.store.state.reports.push(r);this.store.save();return r;});
      if(!base)return null;
      const report=await ownerAi.enrichOwnerReport(base,{env:this.env});
      await this.serial(()=>{const i=this.store.state.reports.findIndex(x=>x.id===report.id);if(i>=0)this.store.state.reports[i]=report;this.store.save();});
      return report;
    }finally{this.reportPending=false;}
  }

  async maintenance() {
    await this.serial(async()=>{
      try{
        core.tick(this.store.state);
        const hour=Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:'Asia/Tashkent'}).format(new Date()));
        // Daily report network work runs outside this queue.
        this.store.save();this.store.cleanup();
      }
      catch(e){this.store.reload();throw e;}
    });
    const hour=Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:'Asia/Tashkent'}).format(new Date()));
    if(hour>=9)await this.dailyReport();
    return this.drainNotifications();
  }
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)){
      url.protocol='https:';
      return Response.redirect(url.href,308);
    }
    if(url.pathname.startsWith('/api/')){
      try{return await env.COMPANY.get(env.COMPANY.idFromName('modus-trade')).fetch(request);}
      catch{return secure(responseError(fail(503,'unavailable','Сервис недоступен')));}
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller,env,ctx) {
    ctx.waitUntil(env.COMPANY.get(env.COMPANY.idFromName('modus-trade')).maintenance());
  }
};
