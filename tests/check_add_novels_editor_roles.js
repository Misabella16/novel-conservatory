/* Test the Add Novels page role-based tab initialization without a browser. */
'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const html=fs.readFileSync('private/admin/add-novels.html','utf8');
const script=fs.readFileSync('private/admin/add-novels.js','utf8');
const worker=fs.readFileSync('private/_worker.js','utf8');

assert(html.includes('id="add-novels-main" hidden'),'Forms must be hidden before checking the role');
assert(html.includes('id="permission-message"')&&html.includes('role="alert"'));
assert(html.includes('section[hidden]{display:none}'));
assert(worker.includes("if(!editor||!extraOrigin(request))return extraJson({error:'Editor permission required'},403);"),'Server must continue enforcing editor permissions');
assert(worker.includes("if(!owner||!extraOrigin(request))return extraJson({error:'Owner permission required'},403);"),'Server must continue enforcing owner-only bulk imports');
assert(worker.includes("if(!isOwner)return editionJson({error:'Owner permission required'},403);"),'Server must continue enforcing owner-only EPUB uploads');

async function roleCase(role){
 const elements=new Map();
 function el(id){
  if(!elements.has(id)){
   const handlers={};
   elements.set(id,{
    id,
    hidden:['permission-message','add-novels-main','bulk','epubs','manage','review'].includes(id),
    disabled:false,
    value:'',
    textContent:'',
    attributes:{},
    classList:{add(){},remove(){},toggle(){}},
    setAttribute(name,value){this.attributes[name]=value},
    addEventListener(name,handler){handlers[name]=handler},
    fire(name){if(handlers[name])handlers[name]({preventDefault(){}})},
    replaceChildren(){},
    append(){},
    appendChild(){},
    style:{}
   });
  }
  return elements.get(id);
 }
 const calls=[];
 const context={
  document:{getElementById:el,createElement:()=>el('generated-option')},
  location:{search:''},
  URLSearchParams,
  window:{confirm:()=>false},
  console,
  fetch:async path=>{
   calls.push(path);
   if(path==='/api/me')return {ok:true,json:async()=>({role})};
   if(path==='/api/additional/books')return {ok:true,json:async()=>({novels:[]})};
   throw Error('Unexpected request '+path);
  }
 };
 vm.runInNewContext(script,context,{filename:'add-novels.js'});
 // Allow the awaited role request and novel list request to resolve.
 for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
 assert(calls.includes('/api/me'));
 if(role==='reader'){
  assert(el('add-novels-main').hidden,'Readers must never see editor forms');
  assert(!el('permission-message').hidden,'Readers must receive a permission message');
  assert(el('create').disabled,'Reader create action disabled');
  assert(!calls.includes('/api/additional/books'),'Do not initialize editor controls for readers');
  return;
 }
 assert(!el('add-novels-main').hidden,role+' must see editor forms');
 assert(el('permission-message').hidden,role+' must not see an error');
 assert(!el('single').hidden,role+' must land on Add one novel');
 assert(el('review').hidden,'Do not force Review submissions at startup');
 assert(el('tab-single').attributes['aria-selected']==='true');
 assert(calls.includes('/api/additional/books'),'Catalog selector should initialize');
 if(role==='editor'){
  assert(el('tab-bulk').hidden,'Bulk import is owner-only');
  assert(el('tab-epubs').hidden,'Direct EPUB upload is owner-only');
  assert(!el('tab-manage').hidden,'Editors must be able to manage novel entries');
  el('tab-manage').fire('click');
  assert(!el('manage').hidden,'Editor can open Manage added novels');
  assert(el('single').hidden,'Only the selected panel is visible');
  el('tab-review').fire('click');
  assert(!el('review').hidden,'Editors can review submissions');
  assert(el('bulk').hidden&&el('epubs').hidden,'Owner-only panels remain hidden');
 }else{
  assert(!el('tab-bulk').hidden&&!el('tab-epubs').hidden,'Owners retain their controls');
  el('tab-epubs').fire('click');
  assert(!el('epubs').hidden,'Owner can open EPUB uploading');
 }
}
(async()=>{
 await roleCase('owner');await roleCase('editor');await roleCase('reader');
 console.log('Add Novels owner/editor/reader permissions and tab initialization passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
