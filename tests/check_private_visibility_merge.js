// Verify that a private duplicate can be archived against an original
// public book without publishing anything, with working rollback and Undo.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');

const raw=fs.readFileSync('private/_worker.js','utf8');
function fragment(start,end){
 const a=raw.indexOf(start),b=raw.indexOf(end,a);
 assert(a>=0&&b>a,'Expected worker code '+start);
 return raw.slice(a,b);
}
const code=[
 fragment('const nuBlank=','async function nuBaseCatalogue('),
 fragment('async function nuSaveEdit(', 'async function nuSyncSource('),
 fragment('async function nuUndoEdit(', '// Novel Updates master staging:')
].join('\n');

const state={
 privatePatch:null,publicPatch:null,source:null,event:null,
 hasEpub:false,journalFailure:false,publicWrites:0
};
const base={id:7,title:'Moon Ice',author:'H. Park',synopsis:'Original summary',
 tags:['Adventure'],genres:['Fantasy'],nuUrl:'https://www.novelupdates.com/series/moon-ice/'};
function reset(){
 state.privatePatch=null;state.publicPatch=null;state.event=null;
 state.hasEpub=false;state.journalFailure=false;state.publicWrites=0;
 state.source={
  id:100142,title:'Moon Ice',visibility:'private',cover_key:'',
  source_submission_id:'',
  payload_json:JSON.stringify({id:100142,title:'Moon Ice',author:'H. Park',
   synopsis:'Private extra synopsis',tags:['Mystery'],
   nuUrl:'https://www.novelupdates.com/series/moon-ice/'})
 };
}
function response(changes=1){return {meta:{changes}}}
function statement(domain,sql,args=[]){
 return {
  bind(...values){return statement(domain,sql,values)},
  async first(){
   if(domain==='private'&&sql.startsWith('SELECT patch FROM novel_edits'))return state.privatePatch===null?null:{patch:state.privatePatch};
   if(domain==='community'&&sql.startsWith('SELECT * FROM additional_catalogue_novels WHERE id='))return {...state.source};
   if(domain==='community'&&sql.startsWith('SELECT patch_json FROM published_catalogue_overrides'))return state.publicPatch===null?null:{patch_json:state.publicPatch};
   if(domain==='community'&&sql.startsWith('SELECT source_submission_id FROM additional_catalogue_novels'))return {source_submission_id:state.source.source_submission_id};
   if(domain==='community'&&sql.startsWith('SELECT * FROM catalogue_edit_events'))return state.event;
   throw Error('Unexpected first(): '+domain+' '+sql);
  },
  async all(){
   if(domain==='community'&&sql.startsWith('SELECT slug,published_id FROM nu_staged_series'))return {results:[]};
   throw Error('Unexpected all(): '+domain+' '+sql);
  },
  async run(){
   if(domain==='private'&&sql.startsWith('INSERT INTO novel_edits')){
    if(state.privatePatch!==null)return response(0);
    state.privatePatch=args[1];return response();
   }
   if(domain==='private'&&sql.startsWith('UPDATE novel_edits SET patch=')){
    if(state.privatePatch!==args[2])return response(0);
    state.privatePatch=args[0];return response();
   }
   if(domain==='private'&&sql.startsWith('DELETE FROM novel_edits')){
    if(state.privatePatch!==args[1])return response(0);
    state.privatePatch=null;return response();
   }
   if(domain==='community'&&sql.startsWith('UPDATE additional_catalogue_novels SET source_submission_id=')){
    if(state.source.source_submission_id!==args[2])return response(0);
    state.source.source_submission_id=args[0];return response();
   }
   if(domain==='community'&&sql.startsWith('INSERT INTO catalogue_edit_events')){
    if(state.journalFailure)throw Error('Simulated journal outage');
    state.event={id:args[0],operation:args[1],target_id:args[2],duplicate_id:args[3],
     before_json:args[4],after_json:args[5],source_url:args[6],actor_email:args[7],undone_at:null};
    return response();
   }
   if(domain==='community'&&sql.startsWith('UPDATE catalogue_edit_events SET undone_at=')){
    state.event.undone_at='now';return response();
   }
   if(domain==='community'&&sql.includes('published_catalogue_overrides')){
    state.publicWrites++;throw Error('Private metadata must never write to public catalogue');
   }
   throw Error('Unexpected run(): '+domain+' '+sql);
  }
 }
}
const env={
 DB:{prepare:sql=>statement('private',sql)},
 COMMUNITY_DB:{prepare:sql=>statement('community',sql)}
};
const ctx={
 env,crypto,console,NU_EDITABLE:['title','originalTitle','author','synopsis','genres','tags','nuUrl','translation'],
 NU_LIST_FIELDS:new Set(['genres','tags']),
 extraTags:value=>Array.isArray(value)?value:[],
 nuIdentity:value=>String(value||'').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu,''),
 nuCanon:value=>String(value||''),
 extraId:value=>Number(value)>=100000?Number(value):null,
 extraPayload:value=>value,
 nuStoredTitleKey:value=>String(value||'').toLowerCase(),
 nuEnsureJournal:async()=>{},
 nuGetExisting:async()=>({kind:'seed',id:7,base,data:{...base},title:base.title,beforeRaw:state.publicPatch}),
 nuAdditionalData:row=>({...JSON.parse(row.payload_json),id:row.id,title:row.title}),
 nuHasPrivateEpub:async()=>state.hasEpub,
 audit:async()=>{}
};
vm.createContext(ctx);
vm.runInContext(code+';this.merge=nuSaveEdit;this.undo=nuUndoEdit;',ctx);
async function run(){
 reset();
 const source=JSON.parse(state.source.payload_json);
 const url=new URL('https://novel-conservatory.pages.dev/');
 const result=await ctx.merge(env,url,'editor',7,source,{sourceId:100142,expectedBefore:null});
 assert.equal(result.ok,true);
 assert.equal(result.privateOnly,true);
 assert.equal(state.publicWrites,0);
 assert.equal(state.publicPatch,null);
 assert.match(state.privatePatch,/Mystery/);
 assert.equal(state.source.source_submission_id,'merged-into:7');
 assert.equal(state.event.operation,'merge');
 const back=await ctx.undo(env,'editor',result.eventId);
 assert.equal(back.undone,true);
 assert.equal(state.source.source_submission_id,'');
 assert.equal(state.privatePatch,null);
 assert.equal(state.publicPatch,null);
 assert.equal(state.publicWrites,0);
 console.log('Private-only merge and Undo preserve public catalogue: OK');

 reset();state.hasEpub=true;
 await assert.rejects(()=>ctx.merge(env,url,'editor',7,source,{sourceId:100142}),/EPUB/);
 assert.equal(state.source.source_submission_id,'');
 assert.equal(state.privatePatch,null);
 console.log('EPUB-bearing duplicate is protected: OK');

 reset();state.source.cover_key='private-cover.png';
 await assert.rejects(()=>ctx.merge(env,url,'editor',7,source,{sourceId:100142}),/cover file/);
 assert.equal(state.source.source_submission_id,'');
 assert.equal(state.privatePatch,null);
 console.log('Private cover-bearing duplicate is protected: OK');

 reset();state.journalFailure=true;
 await assert.rejects(()=>ctx.merge(env,url,'editor',7,source,{sourceId:100142}),/Simulated journal outage/);
 assert.equal(state.privatePatch,null);
 assert.equal(state.source.source_submission_id,'');
 assert.equal(state.publicPatch,null);
 console.log('Failed merge rolls back private metadata and archive marker: OK');

 reset();
 const again=await ctx.merge(env,url,'editor',7,source,{sourceId:100142});
 state.privatePatch=JSON.stringify({title:'Newer user edit'});
 await assert.rejects(()=>ctx.undo(env,'editor',again.eventId),/Private book metadata changed/);
 assert.equal(state.source.source_submission_id,'merged-into:7');
 console.log('Undo refuses to overwrite later private changes: OK');
}
run().catch(e=>{console.error(e);process.exitCode=1});
