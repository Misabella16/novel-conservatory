'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert').strict;
const worker=fs.readFileSync('private/_worker.js','utf8');
const a=worker.indexOf('async function privateEpubIngestRoute(');
const z=worker.indexOf('async function privateEpubAutoCoverRoute(',a);
assert(a>0&&z>a);
const code=worker.slice(a,z);
let privateRow=null,privateEvent=null,stagedEnabled=true;
const id=100111;
const nu='https://www.novelupdates.com/series/summer-novel/';
const captured={title:'Summer Novel',author:'Author',nu_url:nu,
 payload_json:JSON.stringify({synopsis:'A captured series synopsis',tags:['Found Family'],
  genres:['Fantasy']})};
const original={title:'Summer Novel',author:'Author',nuUrl:nu,tags:[],genres:[]};
function stmt(db,sql,args=[]){
 return {bind(...v){return stmt(db,sql,v)},async first(){
  if(db==='private'&&sql.startsWith('SELECT value FROM site_settings'))return privateRow===null?null:{value:privateRow};
  if(db==='community'&&sql.startsWith('SELECT payload_json,title,source_submission_id'))return {
   payload_json:JSON.stringify(original),title:original.title,source_submission_id:''};
  if(db==='community'&&sql.startsWith('SELECT title,author,payload_json,nu_url FROM nu_staged_series'))
   return stagedEnabled?captured:null;
  throw Error('Unexpected SELECT '+db+': '+sql);
 },async run(){
  if(sql.startsWith('CREATE TABLE'))return {meta:{changes:0}};
  if(db==='private'&&sql.startsWith('INSERT INTO site_settings')){
   if(privateRow!==null)return {meta:{changes:0}};
   privateRow=args[1];return {meta:{changes:1}};
  }
  if(db==='private'&&sql.startsWith('UPDATE site_settings')){
   if(privateRow!==args[2])return {meta:{changes:0}};
   privateRow=args[0];return {meta:{changes:1}};
  }
  if(db==='private'&&sql.startsWith('INSERT INTO epub_metadata_import_events')){
   privateEvent={id:args[0],novelId:args[1],before:args[3],after:args[4]};
   return {meta:{changes:1}};
  }
  throw Error('Unexpected write '+db+': '+sql);
 }}}
const env={DB:{prepare:s=>stmt('private',s)},COMMUNITY_DB:{prepare:s=>stmt('community',s)}};
const canonical=x=>{
 try{
  const u=new URL(String(x||''));
  if(u.protocol!=='https:'||u.hostname!=='www.novelupdates.com'||!/\/series\/[a-z0-9-]+\/?$/.test(u.pathname))return '';
  return u.href;
 }catch{return ''}
};
const identity=x=>String(x||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const ctx={PRIVATE_EMBEDDED_KEY:'private-epub-metadata:',
 env,console,Date,JSON,URL,
 editionBook:x=>Number(x)>0?Number(x):null,editionUuid:x=>x==='edition-id'?x:null,
 privateEpubLinked:async()=>true,strictOrigin:()=>true,getJson:async r=>r.body,
 textField:(x,max)=>String(x||'').slice(0,max),
 epubSubjects:x=>Array.isArray(x)?[...new Set(x.filter(z=>typeof z==='string'))]:[],
 mergeEpubTags:(a,c)=>[...new Set([...(a||[]),...(c||[])])],
 nuCanon:canonical,nuIdentity:identity,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},
 respond:(payload,status=200)=>({payload,status})};
vm.createContext(ctx);
vm.runInContext(code+';this.ingest=privateEpubIngestRoute',ctx);
async function check(){
 let request={method:'POST',body:{id,editionId:'edition-id',
  enrichFromStaged:true,
  metadata:{title:'Summer Novel',author:'Author',nuUrl:nu,tags:['School Life'],genres:[]}}};
 let result=await ctx.ingest(request,env,'owner@example.com','owner');
 assert.equal(result.status,200);
 assert.equal(result.payload.ok,true);
 assert.equal(result.payload.stagedSourceUsed,true);
 assert.equal(result.payload.published,false);
 assert(result.payload.changed.includes('synopsis'));
 assert(result.payload.changed.includes('genres'));
 assert(result.payload.changed.includes('tags'));
 assert(privateEvent&&privateEvent.before===null,'Undo event must preserve original private state');
 const data=JSON.parse(privateRow);
 assert.deepEqual(data.tags,['School Life','Found Family']);
 assert.deepEqual(data.genres,['Fantasy']);
 assert.equal(data.synopsis,'A captured series synopsis');
 assert.equal(data.nuUrl,undefined,'Existing canonical NU link should not be redundantly overwritten');
 assert(data.metadataSource.includes('Novel Updates'));
 assert(!worker.includes('fetch(nu)'), 'Staged source must not bypass blocked remote scraping');
 const previous=privateRow;
 request={...request,body:{...request.body,metadata:{...request.body.metadata,
   nuUrl:'https://www.novelupdates.com/series/another-novel/'}}};
 result=await ctx.ingest(request,env,'owner@example.com','owner');
 assert.equal(result.status,409);
 assert.equal(privateRow,previous,'A conflicting source URL must not mutate private metadata');
 stagedEnabled=false;privateRow=null;privateEvent=null;original.nuUrl='';
 result=await ctx.ingest({...request,body:{...request.body,
  metadata:{title:'Summer Novel',author:'Author',nuUrl:nu,tags:['Fantasy']}}},
  env,'owner@example.com','owner');
 assert.equal(result.payload.stagedSourceUsed,false);
 assert.equal(JSON.parse(privateRow).tags[0],'Fantasy');
 assert.equal(JSON.parse(privateRow).nuUrl,nu,
  'An exact EPUB source URL can be saved privately when both title and author match');
 privateRow=null;privateEvent=null;
 result=await ctx.ingest({...request,body:{...request.body,
  metadata:{title:'Summer Novel',author:'Different Person',nuUrl:nu,tags:['Mystery']}}},
  env,'owner@example.com','owner');
 assert.equal(result.status,200);
 assert.equal(JSON.parse(privateRow).nuUrl,undefined,
  'A conflicting author cannot silently establish a source identity');
 console.log('Staged NU metadata used only after identity check, private-only fields + undo snapshot: OK');
}
check().catch(e=>{console.error(e);process.exitCode=1});
