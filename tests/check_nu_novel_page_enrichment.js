'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const worker=fs.readFileSync('private/_worker.js','utf8');
const home=fs.readFileSync('private/index.html','utf8');
const page=fs.readFileSync('private/novel/book.js','utf8');
const html=fs.readFileSync('private/novel/index.html','utf8');
const editor=fs.readFileSync('private/admin/index.html','utf8');
const extractor=fs.readFileSync('private/admin/epub-auto-match.js','utf8');
const bulk=fs.readFileSync('private/admin/editions-enrich-all.js','utf8');
for(const script of [page,extractor,bulk])new Function(script);
assert(editor.includes("new URLSearchParams(location.search).get('book')"),
 'The admin dashboard must select the exact book from its deep link');
assert(editor.includes('if(Number.isSafeInteger(requestedId)'));
assert(page.includes("'/admin/?book='+id"));
assert(page.includes("'/admin/add-novels.html?novel='+id"));
for(const id of ['nu-apply','nu-apply-capture','nu-capture-json','nu-undo','nu-series-url']){
 assert(html.includes('id="'+id+'"'),'Missing in-page NU workflow control: '+id);
}
assert(page.includes("'/api/admin/nu/lookup?url='")===false ||
 page.includes('parseSourcePage(lookup.html,nuUrl)'));
assert(page.includes("'/api/admin/nu/book-import'"));
assert(page.includes("'/api/admin/nu/book-undo'"));
assert(worker.includes("if(imported.genres?.length)item.genres=mergeEpubTags"));
assert(worker.includes("patch.genres=mergeEpubTags(patch.genres,imported.genres)"));
assert(home.includes('item.patch.genresCombinedFromEpub'));
assert(home.includes('item.patch.genresCombinedFromNu'));
assert(extractor.includes('calibre:tags'));
assert(extractor.includes('slice(0,100)'));
assert(bulk.includes('genreUpdates'));
const start=worker.indexOf('const privateNuPageKey=');
const end=worker.indexOf('async function nuAdminRoutes(',start);
assert(start>0&&end>start);
const fn=worker.slice(start,end);
const cache=new Map(),events=new Map(),sharedQueries=[];
const novelId=100123,url='https://www.novelupdates.com/series/example-book/';
const stage={title:'Example Book',author:'Author',nu_url:url,
 payload_json:JSON.stringify({synopsis:'A real source synopsis',tags:['Adventure','Found Family'],
 genres:['Fantasy','Romance']}),
 cover_url:'https://www.novelupdates.com/images/example-cover.jpg'};
const DB={prepare(sql){
 return {bind(...args){
  return {async first(){
    if(sql==='SELECT value FROM site_settings WHERE key=?')
     return cache.has(args[0])?{value:cache.get(args[0])}:null;
    if(sql.includes('FROM epub_metadata_import_events WHERE id=?'))
     return events.get(args[0])||null;
    throw Error('Unexpected private SELECT: '+sql);
   },async run(){
    if(sql.startsWith('CREATE TABLE'))return {meta:{changes:0}};
    if(sql.startsWith('INSERT INTO site_settings')){
     if(cache.has(args[0]))return {meta:{changes:0}};
     cache.set(args[0],args[1]);return {meta:{changes:1}};
    }
    if(sql.startsWith('UPDATE site_settings')){
     const [next,key,previous]=args;
     if(cache.get(key)!==previous)return {meta:{changes:0}};
     cache.set(key,next);return {meta:{changes:1}};
    }
    if(sql.startsWith('DELETE FROM site_settings')){
     if(cache.get(args[0])!==args[1])return {meta:{changes:0}};
     cache.delete(args[0]);return {meta:{changes:1}};
    }
    if(sql.startsWith('INSERT INTO epub_metadata_import_events')){
     const [id,novel_id,setting_key,before_value,after_value,actor_email]=args;
     events.set(id,{id,novel_id,setting_key,before_value,after_value,actor_email,undone_at:null});
     return {meta:{changes:1}};
    }
    if(sql.startsWith('UPDATE epub_metadata_import_events')){
     events.get(args[0]).undone_at='now';return {meta:{changes:1}};
    }
    throw Error('Unexpected private write '+sql);
   }};
 }};
}};
const COMMUNITY_DB={prepare(sql){
 sharedQueries.push(sql);
 assert(sql.trim().startsWith('SELECT'),'Private NU links may never update shared/public DB');
 return {bind(...args){return {async first(){
  assert.equal(args[0],'example-book');
  return stage;
 }}}};
}};
const context={
 URL,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},
 isEditor:role=>role==='owner'||role==='editor',sameOrigin:()=>true,
 getJson:async request=>request.payload,
 editionBook:v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null,
 nuCanon:v=>{try{const u=new URL(String(v));return u.origin==='https://www.novelupdates.com'&&/^\/series\/[a-z0-9-]+\/$/.test(u.pathname)?u.href:''}catch{return ''}},
 nuGetExisting:async()=>({id:novelId,kind:'extra',data:{title:'Example Book',author:'Author',tags:['Classic'],genres:['Mystery']}}),
 nuFindCandidates:async()=>[],
 nuIdentity:x=>String(x||'').toLowerCase().replace(/[^a-z0-9]/g,''),
 mergeEpubTags:(a,b)=>[...new Set([...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])])].slice(0,100),
 epubSubjects:x=>Array.isArray(x)?x:[],
 textField:(v,n)=>String(v||'').slice(0,n),
 respond:(body,status=200)=>({body,status}),DB,COMMUNITY_DB,console
};
vm.createContext(context);
const {privateNuBookImport,privateNuBookUndo}=vm.runInContext(fn+';({privateNuBookImport,privateNuBookUndo})',context);
const env={DB,COMMUNITY_DB};
(async()=>{
 const req={method:'POST',payload:{id:novelId,nuUrl:url},url:'https://private.example/api/admin/nu/book-import'};
 const result=await privateNuBookImport(req,env,'owner@example.com','owner');
 assert.equal(result.status,200);
 assert.equal(result.body.privateOnly,true);
 assert.equal(result.body.published,false);
 assert.equal(result.body.sourceFound,true);
 assert.deepEqual([...result.body.changed].sort(),['cover','genres','nuUrl','synopsis','tags'].sort());
 const saved=JSON.parse(cache.get('private-nu-page:'+novelId));
 assert.equal(saved.nuUrl,url);
 assert.deepEqual([...saved.tags],['Classic','Adventure','Found Family']);
 assert.deepEqual([...saved.genres],['Mystery','Fantasy','Romance']);
 assert(saved.privateCover===true&&saved.cover.includes('novelupdates.com'));
 assert.equal(sharedQueries.filter(x=>!x.trim().startsWith('SELECT')).length,0);
 const denied=await privateNuBookImport(req,env,'reader@example.com','reader');
 assert.equal(denied.status,403);
 const undo=await privateNuBookUndo({method:'POST',payload:{eventId:result.body.eventId}},env,'owner@example.com','owner');
 assert.equal(undo.status,200);
 assert.equal(cache.has('private-nu-page:'+novelId),false);
 const different=await privateNuBookImport(req,{
  DB,COMMUNITY_DB:{prepare(sql){return{bind(){return{first:async()=>({...stage,author:'Different Author'})}}}}}
 },'owner@example.com','owner');
 assert.equal(different.status,409,'Unconfirmed title/author identity must not auto-apply');
 console.log('Private NU metadata, genres, tags, source cover, Undo and no public writes: OK');
 console.log('Editor deep links, inline source retrieval, and EPUB genre propagation: OK');
})().catch(e=>{console.error(e);process.exitCode=1});
