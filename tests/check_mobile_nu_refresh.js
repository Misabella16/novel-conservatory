'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('private/novel/nu-source.js','utf8');
const page=fs.readFileSync('private/novel/book.js','utf8');
const html=fs.readFileSync('private/novel/index.html','utf8');
const catalogue=fs.readFileSync('private/index.html','utf8');
const worker=fs.readFileSync('private/_worker.js','utf8');
for(const code of [source,page,worker])new Function(code);
assert(html.includes('name="nu-fields"')&&html.includes('id="nu-preview-box"'));
assert(html.includes('id="nu-copied-text"')&&html.includes('id="nu-preview-copied"'));
assert(html.includes('@media(max-width:700px){main'));
assert(html.includes('.layout{display:block!important}'),'Mobile novel page must not use narrow desktop split');
assert(html.includes('/novel/nu-source.js'));
assert(catalogue.includes('name="inline-nu-field"'));
assert(catalogue.includes('id="inline-nu-preview"'));
assert(catalogue.includes('nu-source.js'));
assert(page.includes('result.mode===')===false || page.includes("result.mode==='blocked'"));
const browser={};
const browserContext={window:browser,URL,console};
vm.createContext(browserContext);
vm.runInContext(source,browserContext);
const url='https://www.novelupdates.com/series/test-book/';
const parsed=browser.ConservatoryNUSource.parseCopiedText(
 'Genres: Fantasy, Romance\nTags: Found Family, Slow Burn\nChapters: 120\nCompletely Translated: Yes\nStatus in COO: Completed',
 url,{title:'Test Book',author:'Test Author'});
assert.equal(parsed.novel.title,'Test Book');
assert.deepEqual(Array.from(parsed.novel.genres),['Fantasy','Romance']);
assert.deepEqual(Array.from(parsed.novel.tags),['Found Family','Slow Burn']);
assert.equal(parsed.novel.nuChapterSourceText,'120');
assert.equal(parsed.novel.nuTranslationSourceStatus,'Yes');
assert.equal(parsed.novel.nuOriginalSourceStatus,'Completed');
assert.equal(browser.ConservatoryNUSource.canonical('https://evil.com/series/test-book/'),'');
assert.throws(()=>browser.ConservatoryNUSource.parseCopiedText('Random prose',url,{}));

const block=worker.slice(worker.indexOf('const privateNuPageKey='),worker.indexOf('async function nuAdminRoutes('));
const saved=new Map(),events=new Map();
const DB={prepare(sql){return{
  async run(){if(sql.startsWith('CREATE TABLE'))return {meta:{changes:0}};throw Error('Unexpected DB write: '+sql)},
  bind(...args){return{
   async first(){
    if(sql==='SELECT value FROM site_settings WHERE key=?')
     return saved.has(args[0])?{value:saved.get(args[0])}:null;
    if(sql.includes('FROM epub_metadata_import_events'))return events.get(args[0])||null;
    throw Error('Unexpected SELECT '+sql);
   },
   async run(){
    if(sql.startsWith('INSERT INTO site_settings')){
     if(saved.has(args[0]))return{meta:{changes:0}};
     saved.set(args[0],args[1]);return{meta:{changes:1}};
    }
    if(sql.startsWith('UPDATE site_settings')){
     if(saved.get(args[1])!==args[2])return{meta:{changes:0}};
     saved.set(args[1],args[0]);return{meta:{changes:1}};
    }
    if(sql.startsWith('DELETE FROM site_settings')){
     if(saved.get(args[0])!==args[1])return{meta:{changes:0}};
     saved.delete(args[0]);return{meta:{changes:1}};
    }
    if(sql.startsWith('INSERT INTO epub_metadata_import_events')){
     events.set(args[0],{id:args[0],novel_id:args[1],setting_key:args[2],before_value:args[3],
      after_value:args[4],actor_email:args[5],undone_at:null});
     return{meta:{changes:1}};
    }
    if(sql.startsWith('UPDATE epub_metadata_import_events'))return{meta:{changes:1}};
    throw Error('Unexpected write '+sql);
   }
  }}
 }};
}};
const stage={title:'Test Book',author:'Test Author',nu_url:url,
 payload_json:JSON.stringify({synopsis:'NU synopsis',genres:['Fantasy'],
 tags:['Found Family'],nuChapterSourceText:'120',nuTranslationSourceStatus:'Yes',
 nuOriginalSourceStatus:'Completed'}),cover_url:''};
const COMMUNITY_DB={prepare(sql){
 assert(sql.trim().startsWith('SELECT'),'Private import must not write to public database');
 return {bind(){return{async first(){return stage}}}};
}};
const context={
 URL,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},
 isEditor:r=>r==='owner'||r==='editor',sameOrigin:()=>true,
 getJson:async r=>r.payload,editionBook:v=>Number(v),
 nuCanon:v=>browser.ConservatoryNUSource.canonical(v),
 nuGetExisting:async()=>({data:{title:'Test Book',author:'Test Author',tags:['Classic'],genres:['Mystery']}}),
 nuFindCandidates:async()=>[],
 nuIdentity:v=>String(v||'').toLowerCase().replace(/[^a-z0-9]/g,''),
 mergeEpubTags:(a,b)=>[...new Set([...(a||[]),...(b||[])])],
 epubSubjects:v=>Array.isArray(v)?v:[],
 textField:(v,max)=>String(v||'').slice(0,max),
 respond:(body,status=200)=>({body,status}),DB,COMMUNITY_DB,console
};
vm.createContext(context);
const {privateNuBookImport}=vm.runInContext(block+';({privateNuBookImport})',context);
(async()=>{
 const request={method:'POST',url:'https://private.example/api/admin/nu/book-import',
  payload:{id:100123,nuUrl:url,fields:['tags','nuChapterSourceText'],preview:true}};
 const preview=await privateNuBookImport(request,{DB,COMMUNITY_DB},'editor@example.com','editor');
 assert.equal(preview.status,200,JSON.stringify(preview.body));
 assert.equal(preview.body.preview,true);
 assert.equal(saved.size,0,'Preview must be read-only');
 assert.deepEqual(Array.from(preview.body.fields.tags),['Classic','Found Family']);
 assert.equal(preview.body.fields.nuChapterSourceText,'120');
 assert.equal(preview.body.fields.synopsis,undefined,'Unselected field leaked into preview');
 request.payload.preview=false;
 const applied=await privateNuBookImport(request,{DB,COMMUNITY_DB},'editor@example.com','editor');
 assert.equal(applied.status,200,JSON.stringify(applied.body));
 const actual=JSON.parse(saved.get('private-nu-page:100123'));
 assert.deepEqual(actual.tags,['Classic','Found Family']);
 assert.equal(actual.nuChapterSourceText,'120');
 assert.equal(actual.synopsis,undefined,'Unselected synopsis was overwritten');
 assert.equal(actual.nuTranslationSourceStatus,undefined,'Unselected status was overwritten');
 console.log('Mobile NU source parser, responsive controls, read-only preview, selected apply, and private-only edits: OK');
})().catch(error=>{console.error(error);process.exitCode=1});
