'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const raw=fs.readFileSync('private/_worker.js','utf8');
const a=raw.indexOf('const nuAssetColumns='),b=raw.indexOf('async function nuSaveEdit(',a);
assert(a>=0&&b>a,'Asset transfer helpers must exist');
const script=raw.slice(a,b);
const ctx={editionBook:x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null};
vm.createContext(ctx);
const f=vm.runInContext(script+';({nuAssetPlan,nuMoveAssetReferences,nuVerifyAssetPlan})',ctx);
const sourceId=100142,seedId=7,extraId=100260;
function row(id,novelId,key){return {id,novel_id:novelId,label:'Translated edition',translator:'T',language:'English',
 filename:key+'.epub',object_key:key,bytes:2000,uploaded_by:'owner',created_at:'2026-11-05'};}
let state,active=false,legacy=false;
function reset(){
 state={additional_epub_editions:[row('uuid-1',sourceId,'file-1'),row('uuid-2',sourceId,'file-2')],epub_editions:[]};
 active=false;legacy=false;
}
function query(sql,values,mode){
 if(sql.startsWith('SELECT id FROM additional_epub_upload_sessions'))return active?{id:'active'}:null;
 if(sql.startsWith('SELECT value FROM site_settings'))return legacy?{value:'legacy'}:null;
 if(sql.startsWith('SELECT id FROM epub_editions'))return null;
 const m=sql.match(/FROM (additional_epub_editions|epub_editions)/);
 if(!m)throw Error('Unexpected SQL '+sql);
 let rows=state[m[1]].filter(x=>x.novel_id===values[0]);
 if(sql.includes('AND id=?'))rows=rows.filter(x=>x.id===values[1]);
 return mode==='first'?rows[0]||null:{results:rows.map(x=>({...x}))};
}
function exec(command){
 const {sql,args}=command;
 if(sql.startsWith('UPDATE additional_epub_editions SET novel_id=')){
  const rows=state.additional_epub_editions.filter(x=>x.novel_id===args[1]&&x.id===args[2]&&x.object_key===args[3]);
  for(const x of rows)x.novel_id=args[0];
  return rows.length;
 }
 if(sql.startsWith('INSERT INTO ')){
  const m=sql.match(/INSERT INTO (additional_epub_editions|epub_editions).*FROM (additional_epub_editions|epub_editions)/);
  assert(m,'Expected reversible cross-table insert');
  const src=state[m[2]].filter(x=>x.novel_id===args[1]&&x.id===args[2]&&x.object_key===args[3]);
  for(const x of src){
   assert(!state[m[1]].some(other=>other.id===x.id),'Duplicated edition UUID');
   state[m[1]].push({...x,novel_id:args[0]});
  }
  return src.length;
 }
 if(sql.startsWith('DELETE FROM ')){
  const m=sql.match(/DELETE FROM (additional_epub_editions|epub_editions)/);
  const before=state[m[1]].length;
  state[m[1]]=state[m[1]].filter(x=>!(x.novel_id===args[0]&&x.id===args[1]&&x.object_key===args[2]));
  return before-state[m[1]].length;
 }
 throw Error('Unexpected SQL write: '+sql);
}
const env={DB:{
 prepare(sql){return {bind(...args){
  return {first:async()=>query(sql,args,'first'),all:async()=>query(sql,args,'all'),sql,args};
 }}},
 async batch(commands){
  const backup=JSON.stringify(state);
  try{return commands.map(c=>({meta:{changes:exec(c)}}));}
  catch(e){state=JSON.parse(backup);throw e}
 }
}};
async function main(){
 reset();
 const p=await f.nuAssetPlan(env,sourceId,seedId,{cover_key:'private-cover'});
 assert.equal(p.editions.length,2);assert.equal(p.coverKey,'private-cover');
 await f.nuMoveAssetReferences(env,p);
 assert.equal(state.additional_epub_editions.length,0);
 assert.equal(state.epub_editions.length,2);
 assert(state.epub_editions.every(x=>x.novel_id===seedId));
 await f.nuMoveAssetReferences(env,p,true);
 assert.equal(state.epub_editions.length,0);
 assert.equal(state.additional_epub_editions.length,2);
 assert(state.additional_epub_editions.every(x=>x.novel_id===sourceId));
 console.log('Original novel: two EPUBs move and Undo restores every source reference');

 reset();
 const p2=await f.nuAssetPlan(env,sourceId,extraId,{cover_key:''});
 await f.nuMoveAssetReferences(env,p2);
 assert(state.additional_epub_editions.every(x=>x.novel_id===extraId));
 await f.nuMoveAssetReferences(env,p2,true);
 assert(state.additional_epub_editions.every(x=>x.novel_id===sourceId));
 console.log('Added novel: references move and undo without changing R2 keys');

 reset();active=true;
 await assert.rejects(()=>f.nuAssetPlan(env,sourceId,seedId,{}),/still in progress/);
 reset();legacy=true;
 await assert.rejects(()=>f.nuAssetPlan(env,sourceId,seedId,{}),/legacy EPUB/);
 console.log('Unsafe active and legacy uploads are blocked');

 reset();
 const p3=await f.nuAssetPlan(env,sourceId,seedId,{});
 state.additional_epub_editions[0].filename='Changed after preview.epub';
 await assert.rejects(()=>f.nuMoveAssetReferences(env,p3),/changed or removed/);
 assert.equal(state.additional_epub_editions.length,2);
 console.log('Stale previews refuse to touch newer edits');
}
main().catch(e=>{console.error(e);process.exitCode=1});
