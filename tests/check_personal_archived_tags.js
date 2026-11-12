'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const worker=fs.readFileSync('private/_worker.js','utf8');
const home=fs.readFileSync('private/index.html','utf8');
const novel=fs.readFileSync('private/novel/book.js','utf8');
const novelHtml=fs.readFileSync('private/novel/index.html','utf8');
const reader=fs.readFileSync('private/read/reader.js','utf8');
const readerHtml=fs.readFileSync('private/read/index.html','utf8');
const before="if(path==='/api/me/archived-tags'";
const after="if(path.startsWith('/api/epub-submissions/'))";
assert(worker.includes(before)&&worker.includes(after));
const block=worker.slice(worker.indexOf(before),worker.indexOf(after,worker.indexOf(before)));
assert(block.includes("'conservatory-archived-tags-v1:'+email"));
assert(block.includes("if(!sameOrigin(request))"));
assert(!block.includes('env.COMMUNITY_DB'),'Account tag archive must not affect community database');
assert(home.includes('id="archived-tags-manager"'));
assert(home.includes('id="archived-tag-list"'));
assert(home.includes('id="archived-tag-count"'));
assert(home.includes('className=\'archive-tag-button\''));
assert(home.includes("isArchivedTag(name)"));
assert(home.includes('filter(t=>!isArchivedTag(t))'),'Tag labels must be suppressed');
assert(home.includes('filter(x=>!isArchivedTag(x))'),'Series labels must be suppressed');
assert(home.includes("renderPersonalArchivedTags()"));
assert(home.includes('function loadPersonalArchivedTags()'));
// Regression: hide all archived shortcut chips without invoking single-element $.
const shortcutFn=home.slice(
 home.indexOf('function applyPersonalTagShortcutVisibility(){'),
 home.indexOf('function renderPersonalArchivedTags()')
);
assert(shortcutFn.startsWith('function applyPersonalTagShortcutVisibility(){'));
const chips=[{dataset:{storyTag:'Black Belly'},hidden:false},{dataset:{storyTag:'Childhood Friends'},hidden:false},{dataset:{storyTag:'Character Growth'},hidden:false}];
vm.runInNewContext(shortcutFn+';applyPersonalTagShortcutVisibility()',{
 $$:selector=>{assert.equal(selector,'[data-story-tag]');return chips},
 $:()=>{throw Error('Single-element selector used to iterate story shortcuts')},
 isArchivedTag:name=>name==='Black Belly'||name==='Character Growth'
});
assert.deepEqual(chips.map(chip=>chip.hidden),[true,false,true]);
assert(home.includes("loadPersonalArchivedTags();"));
assert(home.includes("makeChecks('#tag-filters',Object.keys(tagCounts).filter(t=>!isArchivedTag(t))"));
assert(home.includes('function matches(d)'));
assert(!home.slice(home.indexOf('function matches(d)'),home.indexOf('function renderBooks()')).includes('if(isArchivedTag('),
 'Archiving a label must not hide books');
assert(novel.includes("json('/api/me/archived-tags').catch"));
assert(novel.includes('const visibleTags=(d.tags||[]).filter'));
assert(novelHtml.includes('id="personal-tag-hint"'));
assert(reader.includes("localStorage.setItem(positionKey(),cfi)"));
assert(reader.includes("localStorage.getItem(positionKey())"));
assert(reader.includes("conservatory-position-"));
assert(reader.includes("rendition.display(resume||undefined)"));
assert(readerHtml.includes('offline fallback'));

const values=new Map();
let denyOrigin=false;
const DB={prepare(sql){return {bind(...args){return{
 async first(){
  assert(sql==='SELECT value FROM site_settings WHERE key=?');
  return values.has(args[0])?{value:values.get(args[0])}:null;
 },
 async run(){
  if(sql.startsWith('INSERT INTO site_settings')){
   if(values.has(args[0]))return {meta:{changes:0}};
   values.set(args[0],args[1]);return {meta:{changes:1}};
  }
  if(sql.startsWith('UPDATE site_settings')){
   if(values.get(args[1])!==args[2])return {meta:{changes:0}};
   values.set(args[1],args[0]);return {meta:{changes:1}};
  }
  throw Error('Unexpected DB write '+sql);
 }
}}}}};
const context={env:{DB},sameOrigin:()=>!denyOrigin,getJson:async r=>r.payload,
 respond:(body,status=200)=>({body,status}),textField:(v,max)=>String(v||'').slice(0,max)};
vm.createContext(context);
const route=vm.runInContext(
 '(async function(request,email){const path="/api/me/archived-tags",method=request.method;'+block+'return null;})',
 context);
const req=(method,payload={})=>({method,payload});
(async()=>{
 let result=await route(req('GET'),'reader@example.com');
 assert.deepEqual([...result.body.tags],[]);
 result=await route(req('POST',{tag:'  Character Growth ',action:'archive'}),'reader@example.com');
 assert.equal(result.status,200);
 assert.deepEqual([...result.body.tags],['character growth']);
 result=await route(req('POST',{tag:'BLACK BELLY',action:'archive'}),'reader@example.com');
 assert.deepEqual([...result.body.tags],['character growth','black belly']);
 result=await route(req('GET'),'other@example.com');
 assert.deepEqual([...result.body.tags],[],'Preferences must not leak into another user');
 result=await route(req('POST',{tag:'Black Belly',action:'restore'}),'reader@example.com');
 assert.deepEqual([...result.body.tags],['character growth']);
 result=await route(req('POST',{tag:'<script>',action:'archive'}),'reader@example.com');
 assert.equal(result.status,400);
 denyOrigin=true;
 result=await route(req('POST',{tag:'safe',action:'archive'}),'reader@example.com');
 assert.equal(result.status,403);
 denyOrigin=false;
 assert(!values.has('conservatory-archived-tags-v1:other@example.com'));
 console.log('Personal tag archive API: per-account isolation, restore, validation, origin and private DB only: OK');
 console.log('Tag UI and existing per-device EPUB last-read position: OK');
})().catch(e=>{console.error(e);process.exitCode=1});
