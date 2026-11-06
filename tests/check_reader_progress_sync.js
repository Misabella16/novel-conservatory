'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const worker=fs.readFileSync('private/_worker.js','utf8');
const reader=fs.readFileSync('private/read/reader.js','utf8');
const html=fs.readFileSync('private/read/index.html','utf8');
const css=fs.readFileSync('private/read/reader.css','utf8');
const progress=fs.readFileSync('private/read/progress-sync.js','utf8');
for(const source of [reader,progress])new Function(source);
assert(html.includes('/read/progress-sync.js')&&html.includes('progress-sync-status'));
assert(css.includes('.sync-note'));
assert(reader.includes('const remoteBookmarkPromise=progressSync?.load()'));
assert(reader.includes('const preferLocal=!!localCfi'));
assert(reader.includes('remoteSavedAt')&&reader.includes('positionTimeKey()'));
assert(reader.includes('rendition.display(resume||undefined)'));
assert(reader.includes('delay:30000')&&reader.includes('progressSync?.queue(cfi)'));
assert(reader.includes('progressSync?.flush({keepalive:true})'));
assert(reader.includes('progressSync?.close()')&&reader.includes('progressSync.reset()'));
const before="if(path==='/api/me/reading-position'";
const after="if(path.startsWith('/api/epub-submissions/'))";
assert(worker.includes(before)&&worker.includes(after));
const block=worker.slice(worker.indexOf(before),worker.indexOf(after,worker.indexOf(before)));
assert(!block.includes('env.COMMUNITY_DB'));
assert(block.includes('canReadEpubs(email,role,env)')&&block.includes('sameOrigin(request)'));
assert(block.includes("'conservatory-reading-position-v1:'+emailNorm(email)"));
assert(block.includes('editionTable(id)')&&block.includes('AND value=?'));
const storage=new Map();
const edition='a1111111-1111-4111-a111-111111111111';
const DB={prepare(sql){return{bind(...args){return{
 async first(){
  if(sql.startsWith('SELECT id FROM epub_editions')||sql.startsWith('SELECT id FROM additional_epub_editions'))
   return args[1]===edition?{id:args[1]}:null;
  if(sql.startsWith('SELECT value FROM site_settings WHERE key=?'))
   return storage.has(args[0])?{value:storage.get(args[0])}:null;
  throw Error('Unexpected SELECT '+sql);
 },
 async run(){
  if(sql.startsWith('INSERT INTO site_settings')){
   if(storage.has(args[0]))return{meta:{changes:0}};
   storage.set(args[0],args[1]);return{meta:{changes:1}};
  }
  if(sql.startsWith('UPDATE site_settings')){
   if(storage.get(args[1])!==args[2])return{meta:{changes:0}};
   storage.set(args[1],args[0]);return{meta:{changes:1}};
  }
  throw Error('Unexpected DB write '+sql);
 }
}}}}};
const context={env:{DB},URL,JSON,Number,String,Date,
 canReadEpubs:async(email,role)=>role==='owner'||email==='reader@example.com'||email==='other@example.com',
 editionBook:v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null,
 editionUuid:v=>/^[0-9a-f-]{36}$/.test(String(v||''))?String(v):'',
 editionTable:id=>id>962?'additional_epub_editions':'epub_editions',
 emailNorm:value=>String(value).trim().toLowerCase(),
 sameOrigin:request=>request.origin!==false,
 getJson:async request=>request.payload,
 textField:(v,max)=>String(v??'').slice(0,max),
 editionJson:(body,status=200)=>({body,status})};
vm.createContext(context);
const route=vm.runInContext('(async function(request,email,role){const path="/api/me/reading-position",method=request.method,url=new URL(request.url);'+block+'return null;})',context);
const query=(method='GET',payload={},origin=true)=>{
 const url=new URL('https://example.com/api/me/reading-position');
 url.searchParams.set('id','25');url.searchParams.set('edition',edition);
 return{method,url:url.toString(),payload,origin};
};
const cfi1='epubcfi(/6/4[chapter-one]!/4/2/10)',cfi2='epubcfi(/6/6[chapter-two]!/4/2/30)';
(async()=>{
 let a=await route(query(),'reader@example.com','member');
 assert.equal(a.status,200);assert.equal(a.body.exists,false);assert.equal(storage.size,0);
 a=await route(query('POST',{id:25,edition,cfi:cfi1,version:0}),'reader@example.com','member');
 assert.equal(a.status,200,JSON.stringify(a.body));assert.equal(a.body.position.version,1);
 assert.equal(a.body.position.cfi,cfi1);
 const second=await route(query(),'reader@example.com','member');
 assert.equal(second.body.position.cfi,cfi1);
 const other=await route(query(),'other@example.com','member');
 assert.equal(other.body.exists,false);
 const stale=await route(query('POST',{id:25,edition,cfi:cfi2,version:0}),'reader@example.com','member');
 assert.equal(stale.status,409);
 const ok=await route(query('POST',{id:25,edition,cfi:cfi2,version:1}),'reader@example.com','member');
 assert.equal(ok.status,200);assert.equal(ok.body.position.version,2);
 const reset=await route(query('POST',{id:25,edition,cfi:'',version:2}),'reader@example.com','member');
 assert.equal(reset.status,200);assert.equal(reset.body.position.cfi,'');
 assert.equal((await route(query(),'reader@example.com','member')).body.position.cfi,'');
 assert.equal((await route(query('POST',{id:25,edition,cfi:'<script>',version:3}),'reader@example.com','member')).status,400);
 assert.equal((await route(query(),'no-access@example.com','member')).status,403);
 assert.equal((await route(query('POST',{id:25,edition,cfi:cfi1,version:3},false),'reader@example.com','member')).status,403);
 assert.equal((await route(query('POST',{id:25,edition:'deadbeef-3333-4333-8333-555555555555',cfi:cfi1,version:0}),'reader@example.com','member')).status,404);
 assert([...storage.keys()].every(k=>!k.includes('other@example.com')));
 const browser={},timers=[];
 const sandbox={window:browser,setTimeout:callback=>{timers.push(callback);return timers.length},clearTimeout:()=>{},
  fetch:()=>{throw Error('No network access')}};
 vm.createContext(sandbox);vm.runInContext(progress,sandbox);
 const calls=[];let version=0,remote='';
 const fetcher=async(uri,options)=>{
  calls.push({method:options?.method||'GET',keepalive:options?.keepalive});
  if(options?.method==='POST'){
   const body=JSON.parse(options.body);
   if(body.version!==version)return{status:409,ok:false,json:async()=>({position:{version,cfi:remote}})};
   if(body.cfi!==remote){version++;remote=body.cfi}
   return{status:200,ok:true,json:async()=>({ok:true,position:{version,cfi:remote}})};
  }
  return{status:200,ok:true,json:async()=>({ok:true,exists:version>0,position:{cfi:remote,version}})};
 };
 const x=browser.ConservatoryReaderProgress.session({id:25,edition,fetcher,delay:30000});
 const y=browser.ConservatoryReaderProgress.session({id:25,edition,fetcher,delay:30000});
 assert.equal((await x.load()).exists,false);assert.equal((await y.load()).exists,false);
 x.queue(cfi1);x.queue(cfi2);
 assert.equal(calls.filter(x=>x.method==='POST').length,0);
 assert.equal(await x.flush(),true);
 assert.equal(calls.filter(x=>x.method==='POST').length,1);assert.equal(remote,cfi2);
 y.queue(cfi1);assert.equal(await y.flush(),false);assert.equal(remote,cfi2);
 y.queue(cfi1);assert.equal(await y.flush(),true);assert.equal(remote,cfi1);
 assert.equal(await y.reset(),true);assert.equal(remote,'');
 x.close();y.close();
 console.log('Cross-device EPUB bookmarks: isolated identities, edition auth, stale updates, resets, throttled writes: OK');
})().catch(e=>{console.error(e);process.exitCode=1});
