'use strict';
// Bulk Novel Updates fill: collector script builder, collector run/pause/resume,
// file validation and the importer contract it relies on.
const assert=require('node:assert/strict');
const plain=x=>JSON.parse(JSON.stringify(x)); // values from the vm realm
const fs=require('node:fs');
const vm=require('node:vm');

const bulkJs=fs.readFileSync('private/admin/nu-bulk.js','utf8');
const runnerJs=fs.readFileSync('private/admin/nu-collector-runner.js','utf8');
const sourceJs=fs.readFileSync('private/novel/nu-source.js','utf8');
const html=fs.readFileSync('private/admin/nu-bulk.html','utf8');
const adminIndex=fs.readFileSync('private/admin/index.html','utf8');
const worker=fs.readFileSync('private/_worker.js','utf8');

// ---- helpers (no DOM) --------------------------------------------------------
const ctx={URL,JSON,Math,Number,String,Array,Object,Map,Set,Error};
ctx.window=ctx;vm.createContext(ctx);vm.runInContext(bulkJs,ctx);
const B=ctx.NUBulk;
assert(B,'nu-bulk.js must expose NUBulk without a page');

assert.equal(B.canonical('https://novelupdates.com/series/Little-Mushroom'),'https://www.novelupdates.com/series/little-mushroom/');
assert.equal(B.canonical('https://www.novelupdates.com/series/x/?a=1'),'');
assert.equal(B.canonical('http://www.novelupdates.com/series/x/'),'');
assert.equal(B.canonical('https://evil.example/series/x/'),'');

const books=[
 {id:1,title:'Empty',nuUrl:'https://www.novelupdates.com/series/empty/',tags:[],genres:[],synopsis:'',cover:''},
 {id:2,title:'Full',nuUrl:'https://www.novelupdates.com/series/full/',tags:['a'],genres:['b'],synopsis:'s',cover:'c'},
 {id:3,title:'No link',nuUrl:'',tags:[]},
 {id:4,title:'Edited full',nuUrl:'https://www.novelupdates.com/series/edited/',tags:[]},
 {id:5,title:'Dup',nuUrl:'https://www.novelupdates.com/series/empty/'},
 {id:5,title:'Dup id',nuUrl:'https://www.novelupdates.com/series/dup/'}
];
const merged=B.mergeCatalogue(books,[{id:4,patch:{tags:['x'],genres:['y'],synopsis:'z',cover:'/media/c.jpg'}}]);
assert.deepEqual(plain(B.missingFields(merged[3])),[],'saved edits must count as filled');
assert.deepEqual(plain(B.pickNovels(merged).map(x=>x.id)),[1,5],'only linked novels with gaps, once per id');
assert.deepEqual(plain(B.pickNovels(merged,{all:true}).map(x=>x.id)),[1,2,4,5]);

const list=B.pickNovels(merged);
list[0].title='</script><img src=x>';
const script=B.buildCollector(sourceJs,runnerJs,list,1);
new Function(script); // must be valid JavaScript
assert(!script.includes('</script>'),'titles must not break out of a script context');
assert(script.includes(',3000);'),'delay is clamped to at least 3 seconds');
assert(B.buildCollector(sourceJs,runnerJs,list,999).includes(',30000);'));

const good={format:B.FORMAT,collectedAt:'t',items:[
 {id:1,title:'A',nuUrl:'https://www.novelupdates.com/series/a/',capture:{source:'novelupdates-browser-v1',novel:{nuUrl:'https://www.novelupdates.com/series/a/',tags:['t']}}},
 {id:2,title:'B',nuUrl:'https://www.novelupdates.com/series/b/',error:'HTTP 404'},
 {id:3,title:'C',nuUrl:'https://www.novelupdates.com/series/c/',capture:{source:'novelupdates-browser-v1',novel:{nuUrl:'https://www.novelupdates.com/series/other/'}}},
 {id:'x',nuUrl:'https://www.novelupdates.com/series/d/'}
]};
const read=B.readCollected(JSON.stringify(good));
assert.deepEqual(plain(read.ready.map(x=>x.id)),[1]);
assert.deepEqual(plain(read.failed.map(x=>String(x.id))),['2','3','x'],'mismatched or broken captures are never sent');
assert.throws(()=>B.readCollected('{"items":[]}'),/did not come from/);
assert.throws(()=>B.readCollected('nope'),/not valid JSON/);
const payload=B.importPayload(read.ready[0],['tags','genres','bogus'],true);
assert.deepEqual(plain(payload.fields),['tags','genres']);
assert.equal(payload.preview,true);
assert.equal(payload.capture.source,'novelupdates-browser-v1');
assert.throws(()=>B.importPayload(read.ready[0],['bogus'],false),/at least one/);

// ---- collector run in a fake Novel Updates tab ---------------------------------
// DOMParser stub: the "HTML" is JSON mapping selectors to text values.
function fakeDoc(spec){
 const node=v=>({textContent:v,getAttribute:k=>k==='src'?v:null});
 return {
  querySelector:s=>{for(const part of s.split(','))if(spec[part.trim()]!==undefined){const v=spec[part.trim()];return node(Array.isArray(v)?v[0]:v)}return null},
  querySelectorAll:s=>{const out=[];for(const part of s.split(','))for(const v of [].concat(spec[part.trim()]||[]))out.push(node(v));return out}
 };
}
function makeTab(responder){
 const storage=new Map(),downloads=[],alerts=[];
 const el=()=>({style:{},append(){},remove(){},click(){if(this.download)downloads.push(this.download)},set textContent(v){this._t=v},get textContent(){return this._t}});
 const tab={
  URL:Object.assign(function(u,b){return new URL(u,b)},{createObjectURL:()=>'blob:x',revokeObjectURL(){}}),
  JSON,Math,Number,String,Array,Object,Map,Set,Error,Promise,Blob:class{constructor(p){this.text=p.join('')}},
  setTimeout:(f)=>{f();return 0},console:{log(){},warn(){}},
  alert:m=>alerts.push(m),confirm:()=>true,
  location:{hostname:'www.novelupdates.com',href:'https://www.novelupdates.com/'},
  localStorage:{getItem:k=>storage.has(k)?storage.get(k):null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
  DOMParser:class{parseFromString(h){return fakeDoc(JSON.parse(h))}},
  document:{createElement:el,getElementById:()=>null,body:{appendChild(){}}},
  fetch:async p=>responder(p)
 };
 tab.window=tab;tab.globalThis=tab;
 vm.createContext(tab);
 return {tab,storage,downloads,alerts};
}
const page=(title,tags)=>JSON.stringify({'.seriestitlenu':title,'#showtags a':tags,'#seriesgenre a':['Romance'],
 '#editdescription':'About '+title,'.seriesimg img':'https://cdn.novelupdates.com/images/'+title+'.jpg'});
const res=(status,body)=>({status,ok:status>=200&&status<300,text:async()=>body});

(async()=>{
 const three=[{id:1,title:'A',nuUrl:'https://www.novelupdates.com/series/a/'},
  {id:2,title:'B',nuUrl:'https://www.novelupdates.com/series/b/'},
  {id:3,title:'C',nuUrl:'https://www.novelupdates.com/series/c/'}];
 const code=B.buildCollector(sourceJs,runnerJs,three,3);
 const requested=[];
 let challenge=true;
 const t=makeTab(p=>{requested.push(p);
  if(p==='/series/b/')return res(404,'gone');
  if(p==='/series/c/'&&challenge)return res(403,'<title>Just a moment...</title>');
  return res(200,page(p.split('/')[2],['Slow Burn','Smart MC']));});
 await vm.runInContext(code,t.tab);
 assert.deepEqual(requested,['/series/a/','/series/b/','/series/c/'],'only same-site series paths are requested');
 let saved=JSON.parse(t.storage.get('novelConservatoryNUBulk'));
 assert(saved.items[1].capture,'page A captured');
 assert.equal(saved.items[1].capture.source,'novelupdates-browser-v1');
 assert.equal(saved.items[1].capture.novel.nuUrl,'https://www.novelupdates.com/series/a/');
 assert.deepEqual([...saved.items[1].capture.novel.tags],['Slow Burn','Smart MC']);
 assert.equal(saved.items[2].error,'HTTP 404');
 assert(!saved.items[3],'challenge page is never stored as data');
 assert.equal(t.downloads.length,0,'a paused run does not download');

 // Second paste after the person passes the check: resumes, retries B, skips A.
 challenge=false;requested.length=0;
 await vm.runInContext(code,t.tab);
 assert.deepEqual(requested,['/series/b/','/series/c/']);
 saved=JSON.parse(t.storage.get('novelConservatoryNUBulk'));
 assert(saved.items[3].capture);
 assert.equal(t.downloads.length,1,'finished run downloads the file');

 // Wrong site: refuses before any request.
 const w=makeTab(()=>{throw Error('must not fetch')});w.tab.location.hostname='example.com';
 await vm.runInContext(code,w.tab);
 assert.equal(w.alerts.length,1);

 // Layout change: stops after 5 empty pages instead of hammering the site.
 const many=Array.from({length:8},(_,i)=>({id:i+1,title:'N'+i,nuUrl:'https://www.novelupdates.com/series/n'+i+'/'}));
 const e=makeTab(()=>res(200,JSON.stringify({})));let count=0;
 e.tab.fetch=async()=>{count++;return res(200,'{}')};
 await vm.runInContext(B.buildCollector(sourceJs,runnerJs,many,3),e.tab);
 assert.equal(count,5,'stops after 5 pages without metadata');

 // ---- page, navigation and importer contract ----------------------------------
 for(const id of ['nu-bulk-app','collect-build','collect-copy','collect-script','apply-file','apply-preview','apply-run','apply-stop','apply-results','undo-run'])
  assert(html.includes('id="'+id+'"'),'nu-bulk.html is missing #'+id);
 assert(html.includes('/admin/nu-bulk.js'));
 assert(adminIndex.includes('href="/admin/nu-bulk.html"'),'Editor dashboard links to bulk fill');
 assert(worker.includes("path==='/api/admin/nu/book-import'"));
 assert(worker.includes("path==='/api/admin/nu/book-undo'"));
 assert(worker.includes("capture?.source!=='novelupdates-browser-v1'"),'importer still validates browser captures');
 assert(worker.includes("if(body.preview===true)"),'importer preview stays read-only');
 assert(/if\(synopsis&&!current\.synopsis&&!old\.synopsis\)/.test(worker),'importer only fills an empty synopsis');
 assert(runnerJs.includes("location.hostname!=='www.novelupdates.com'"));
 assert(!/document\.cookie|credentials:'include'/.test(runnerJs),'collector never reads cookies or sends them cross-site');
 console.log('Bulk Novel Updates fill checks passed.');
})().catch(e=>{console.error(e);process.exit(1)});
