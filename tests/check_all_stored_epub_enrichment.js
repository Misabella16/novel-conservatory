'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const scanner=fs.readFileSync('private/admin/editions-enrich-all.js','utf8');
const importer=fs.readFileSync('private/admin/editions.js','utf8');
const page=fs.readFileSync('private/admin/editions.html','utf8');
const catalogue=fs.readFileSync('private/index.html','utf8');
assert(!importer.includes('const budget=12'),'Legacy 12-file limit must be removed');
assert(page.includes('Enrich ALL stored EPUBs'));
for(const id of ['backfill-stop','backfill-progress','backfill-counts','backfill-status','backfill-errors']){
 assert(page.includes('id="'+id+'"'),'Missing scan UI: '+id);
}
assert(page.includes('/admin/editions-enrich-all.js'));
assert(catalogue.includes("'Imported discoveries'"));
assert(catalogue.includes("!['epub','nu'].includes(book.metadataOrigin)"),
 'Only explicit imported EPUB or source-verified NU tags should be dynamically discoverable');
assert(scanner.includes("'/api/admin/epub/ingest-metadata'")===false,
 'The full scanner must reuse the existing guarded private metadata helper, not duplicate the API');
function element(){
 const events={};return {
  textContent:'',className:'',value:0,disabled:false,children:[],events,
  addEventListener(name,handler){events[name]=handler},
  append(...nodes){this.children.push(...nodes)},
  replaceChildren(...nodes){this.children=[...nodes]}
 };
}
const ids=Object.fromEntries(['backfill','backfill-stop','backfill-progress','backfill-counts',
 'backfill-status','backfill-errors'].map(id=>[id,element()]));
const document={getElementById:id=>ids[id]||null,createElement:()=>element()};
const cache=new Map();
const localStorage={
 getItem:key=>cache.get(key)||null,
 setItem:(key,value)=>{cache.set(key,value)}
};
const editions=Array.from({length:29},(_,i)=>({
 id:1,editionId:'edition-'+(i+1),bytes:100,
 filename:'Volume '+(i+1)+'.epub'
}));
let ingested=0,extracted=0,downloaded=0,stopOnce=true;
const tools={
 inspect:async()=>({title:'Test',synopsis:'Existing synopsis',tags:['Found Family'],metadataFound:true}),
 ingest:async()=>{
  ingested++;
  if(stopOnce&&ingested===3)ids['backfill-stop'].events.click();
  return {changed:['tags','synopsis']};
 },
 cover:async()=>{extracted++;return {published:true}},
 fetchJson:async response=>response.payload
};
const fetch=async uri=>{
 const path=String(uri);
 if(path.startsWith('/api/catalogue'))return {payload:[{id:1,title:'Sample Novel'}]};
 if(path.startsWith('/api/content'))return {payload:{edits:[]}};
 if(path.startsWith('/api/private/edition/inventory'))return {payload:{editions}};
 if(path.startsWith('/api/private/epub/bulk-status'))return {payload:{files:{}}};
 if(path.startsWith('/api/private/edition/file')){
  downloaded++;
  return {ok:true,blob:async()=>({size:100})};
 }
 throw Error('Unexpected fetch: '+path);
};
class File{constructor(parts,name){this.name=name;this.parts=parts}}
const context={document,window:{ConservatoryStoredEpubTools:tools},
 fetch,localStorage,File,console,Promise,Set,Map,Number,String,JSON,
 setTimeout:(cb)=>cb()};
vm.runInNewContext(scanner,context,{filename:'editions-enrich-all.js'});
async function run(){
 const scan=ids.backfill.events.click;
 assert.equal(typeof scan,'function','Scan all button must have handler');
 await scan();
 assert.equal(ingested,3,'Pause should finish the current EPUB without starting the next');
 assert.equal(extracted,3);
 const saved=JSON.parse(cache.get('conservatory:stored-epub-enrichment:v2'));
 assert.equal(saved.completed.length,3,'Progress must be stored per edition');
 stopOnce=false;
 await scan();
 assert.equal(ingested,29,'Single restart should process ALL remaining 26 editions, not 12');
 assert.equal(downloaded,29);
 assert.equal(extracted,29);
 const final=JSON.parse(cache.get('conservatory:stored-epub-enrichment:v2'));
 assert.equal(final.completed.length,29);
 assert.equal(final.finished,true);
 assert.equal(final.stats.tagUpdates,29);
 assert.equal(ids['backfill-progress'].value,100);
 assert.match(ids['backfill-status'].textContent,/29 \/ 29/);
 console.log('One-click scanner processes all stored EPUBs and resumes after Pause: OK');
 console.log('Private tag enrichment and live tag explorer integration: OK');
}
run().catch(error=>{console.error(error);process.exitCode=1});
