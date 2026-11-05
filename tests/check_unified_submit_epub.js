'use strict';
/* Source-level + role initialization checks for the unified Submit EPUB tabs. */
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const page=fs.readFileSync('private/submit-epub/index.html','utf8');
const code=fs.readFileSync('private/submit-epub/editor.js','utf8');
const admin=fs.readFileSync('private/admin/index.html','utf8');
const worker=fs.readFileSync('private/_worker.js','utf8');

assert(page.includes('id="tab-submit-epub"')&&page.includes('id="tab-add-entry"'));
assert(page.includes('id="editor-panel" role="tabpanel"')&&page.includes('id="submit-panel" role="tabpanel"'));
assert(page.includes('id="entry-book-list"')&&page.includes('id="entry-rights"'));
assert(page.includes('id="entry-nu-url"')&&page.includes('id="entry-translator-url"'));
assert(page.includes('id="entry-tags"')&&page.includes('id="entry-synopsis"'));
assert(page.includes('/submit-epub/editor.js'));
assert(admin.includes('/admin/add-novels.html'),'Consolidated dashboard must offer Add Novel');
assert(admin.includes('/admin/editions.html'),'Consolidated dashboard must offer bulk EPUB upload');
assert(!admin.includes('＋ Add non-CG novels &amp; EPUBs'));
assert(!admin.includes('📦 Legacy single-file importer'));
assert(admin.includes("$('bulk-tab').hidden=true"));
assert(admin.includes('/admin/add-novels.html'),'Admin novel workflow must remain available');
assert(code.includes("if(which==='entry'&&!['owner','editor'].includes(role))return"));
assert(code.includes("if(role==='owner')"));
assert(code.includes("await req('/api/private/edition/start'"));
assert(code.includes("req('/api/epub-submissions/upload'"));
assert(code.includes("method:'POST',headers:{'content-type':'application/json'}"));
assert(code.includes("publish:$('entry-publish').checked"));
assert(code.includes("!$('entry-rights').checked"));
assert(code.includes("Newly uploaded EPUB editions start unverified."));
assert(worker.includes("if(!editor||!extraOrigin(request))return extraJson({error:'Editor permission required'},403);"));
assert(worker.includes("if(!owner||!extraOrigin(request))return extraJson({error:'Owner permission required'},403);"));
assert(worker.includes("if(!isOwner)return editionJson({error:'Owner permission required'},403);"));

const extracted=[...page.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(x=>x[1]).filter(Boolean);
for(const item of extracted)new Function(item);

async function simulate(role){
 const elements=new Map();
 function el(id){
  if(!elements.has(id)){
   const handlers={};
   elements.set(id,{
    value:'',hidden:['tab-add-entry','editor-panel','entry-bulk-link','entry-review-link'].includes(id),
    required:false,disabled:false,textContent:'',attributes:{},dataset:{},files:[],
    classList:{toggle(){},add(){},remove(){}},
    setAttribute(k,v){this.attributes[k]=v},
    addEventListener(k,fn){handlers[k]=fn},
    fire(k){if(handlers[k])handlers[k]({preventDefault(){}})}
   });
  }
  return elements.get(id);
 }
 el('entry-action').value='new';
 el('entry-title').value='';
 const calls=[];
 const ctx={
  document:{getElementById:el},console,location:{search:'',hash:'',pathname:'/submit-epub/'},
  history:{replaceState(){}},URLSearchParams,confirm:()=>false,
  fetch:async (url)=>{
   calls.push(url);
   if(url==='/api/me')return {ok:true,json:async()=>({role})};
   throw Error('Unexpected role-init fetch '+url);
  }
 };
 vm.runInNewContext(code,ctx,{filename:'unified-editor.js'});
 for(let i=0;i<7;i++)await new Promise(r=>setImmediate(r));
 assert(calls.includes('/api/me'));
 assert(!el('submit-panel').hidden,'Submit EPUB must remain accessible to all private members');
 if(role==='reader'){
  assert(el('tab-add-entry').hidden,'Readers must not see the editorial tab');
  assert(el('editor-panel').hidden,'Readers cannot see the entry panel');
 }else{
  assert(!el('tab-add-entry').hidden,role+' should see the entry tab');
  el('tab-add-entry').fire('click');
  assert(!el('editor-panel').hidden,role+' should enter the editor panel');
  assert(el('submit-panel').hidden);
  assert(el('tab-add-entry').attributes['aria-selected']==='true');
  assert(el('entry-title').required);
  if(role==='editor'){
   assert(!el('entry-rights-label').hidden,'Editor must see rights checkbox');
   assert(el('entry-bulk-link').hidden,'Editors do not get owner bulk tools');
   assert(el('entry-review-link').hidden,'Editors do not get owner EPUB review queue');
  }else{
   assert(el('entry-rights-label').hidden,'Owner uploads directly');
   assert(!el('entry-bulk-link').hidden);
   assert(!el('entry-review-link').hidden);
  }
 }
}
(async()=>{
 await simulate('owner');await simulate('editor');await simulate('reader');
 console.log('Unified EPUB + novel-entry tabs, role gating and source permissions: OK');
})().catch(e=>{console.error(e);process.exitCode=1});
