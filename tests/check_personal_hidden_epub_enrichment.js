'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const worker=fs.readFileSync('private/_worker.js','utf8');
const page=fs.readFileSync('private/index.html','utf8');
const bulk=fs.readFileSync('private/admin/editions.js','utf8');
const fullScan=fs.readFileSync('private/admin/editions-enrich-all.js','utf8');
const screen=fs.readFileSync('private/admin/editions.html','utf8');
const add=fs.readFileSync('private/admin/add-novels.js','utf8');
function between(a,b){
 const i=worker.indexOf(a),j=worker.indexOf(b,i+a.length);
 assert(i>=0&&j>i,'Could not locate '+a+' or '+b);
 return worker.slice(i,j);
}
const hide=between("if(path==='/api/me/hidden'","if(path.startsWith('/api/epub-submissions/'))");
assert(hide.includes("'conservatory-hidden-v1:'+email"));
assert(hide.includes('if(!sameOrigin(request))'));
assert(hide.includes("['hide','restore'].includes(action)"));
assert(!hide.includes('env.COMMUNITY_DB'),'Personal archive must not affect shared database');
assert(page.includes('id="toggle-hidden"'));
assert(page.includes('id="detail-archive"'));
assert(page.includes('hiddenIds.has(Number(d.id))'));
assert(page.includes("fetch('/api/me/hidden'"));
const stores={};
function prepare(sql){
 return {bind(...args){
  return {
   async first(){
    if(sql.startsWith('SELECT value FROM site_settings'))return stores[args[0]]===undefined?null:{value:stores[args[0]]};
    throw Error('Unexpected SELECT '+sql);
   },
   async run(){
    if(sql.startsWith('INSERT INTO site_settings')){
     if(stores[args[0]]!==undefined)return {meta:{changes:0}};
     stores[args[0]]=args[1];return {meta:{changes:1}};
    }
    if(sql.startsWith('UPDATE site_settings')){
     if(stores[args[1]]!==args[2])return {meta:{changes:0}};
     stores[args[1]]=args[0];return {meta:{changes:1}};
    }
    throw Error('Unexpected write '+sql);
   }
  };
 }};
}
const env={DB:{prepare}};
const context={env,respond:(body,status=200)=>({body,status}),
 bookIdValid:x=>Number.isSafeInteger(Number(x))&&Number(x)>=1,
 sameOrigin:()=>true,getJson:async request=>request.payload,
 textField:(value,max)=>String(value||'').slice(0,max),JSON,Set,Number};
vm.createContext(context);
const run=vm.runInContext('(async function(request,email){const path="/api/me/hidden",method=request.method;'+hide+'return null;})',context);
const req=(method,payload={})=>({method,payload,url:'https://private.example/api/me/hidden'});
async function test(){
 let a=await run(req('POST',{id:100001,action:'hide'}),'first@example.com');
 assert.equal(a.status,200);
 assert.deepEqual([...a.body.ids],[100001]);
 const other=await run(req('GET'),'other@example.com');
 assert.deepEqual([...other.body.ids],[]);
 a=await run(req('GET'),'first@example.com');
 assert.deepEqual([...a.body.ids],[100001]);
 a=await run(req('POST',{id:100001,action:'restore'}),'first@example.com');
 assert.deepEqual([...a.body.ids],[]);
 console.log('Personal Hide and Restore are isolated by signed-in account');

 const helper=between('const PRIVATE_EMBEDDED_KEY=', 'async function privateEpubCoverRoute(');
 const sandbox={textField:(value,max)=>String(value??'').trim().slice(0,max)};
 vm.createContext(sandbox);
 const funcs=vm.runInContext(helper+';({mergeEpubTags})',sandbox);
 assert.deepEqual([...funcs.mergeEpubTags(['Magic','Romance'],['romance','Time Travel'])],['Magic','Romance','Time Travel']);
 assert(helper.includes("role!=='owner'"));
 assert(helper.includes("private-epub-metadata:"));
 assert(helper.includes("private-epub-cover:"));
 assert(helper.includes("publicPublished:false"));
 assert(helper.includes("if(tags.length){"));
 assert(helper.includes("if(genres.length){"));
 assert(!helper.includes("if(tags.length&&!source.metadataReview)"),
  'Explicit EPUB subjects may enrich reviewed books without replacing manual fields');
 assert(worker.includes("env.DB.prepare(\"SELECT key,value FROM site_settings WHERE key LIKE 'private-epub-metadata:%'"));
 assert(worker.includes("if(imported.tags?.length)item.tags=mergeEpubTags"));
 assert(worker.includes("if(imported.genres?.length)item.genres=mergeEpubTags"));
 assert(!worker.includes("if(!item.metadataReview&&imported.tags?.length)"),
  'Private source labels must remain additive even on reviewed books');
 assert(!helper.includes('env.COMMUNITY_IMAGES.put'),'Private cover must not write to public image storage');
 assert(bulk.includes("'/api/admin/epub/ingest-metadata'"));
 assert(bulk.includes("'/api/admin/epub-artwork/private-auto'"));
 assert(fullScan.includes("'/api/private/epub/bulk-status'"));
 assert(fullScan.includes("'/api/private/epub/file?id='"));
 assert(add.includes("'/api/admin/epub/ingest-metadata'"));
 assert(add.includes("'/api/admin/epub-artwork/private-auto'"));
 assert(screen.includes('id="backfill"'));
 assert(!screen.includes('Covers are published automatically'));
 console.log('Private EPUB tag/cover import and legacy backfill wired; curated tags protected');
}
test().catch(e=>{console.error(e);process.exitCode=1});
