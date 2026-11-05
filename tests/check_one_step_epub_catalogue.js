'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert').strict;
const matchCode=fs.readFileSync('private/admin/epub-auto-match.js','utf8');
const importCode=fs.readFileSync('private/admin/editions.js','utf8');
const worker=fs.readFileSync('private/_worker.js','utf8');
const page=fs.readFileSync('private/admin/editions.html','utf8');
const novel=fs.readFileSync('private/novel/book.js','utf8');
new Function(importCode);new Function(matchCode);new Function(novel);
assert(page.includes('id="auto-import"'));
assert(page.includes('id="import-report"'));
assert(worker.includes("new URL('/novel/index.html',request.url)"));
assert(worker.includes("path==='/api/admin/epub/undo-metadata'"));
assert(worker.includes('stagedSourceUsed:fromStaged'));
assert(worker.includes("metadataReview:fromPrivateEpub?false:true"),
 'Auto-catalogued EPUB entries must not be labeled editor-reviewed');
assert(worker.includes("metadataOrigin:'epub'"),
 'Private EPUB entries must be discoverable from real embedded metadata');
const window={};vm.runInNewContext(matchCode,{window,URL});
const match=window.ConservatoryEPUBMatch;
const books=[{id:1,title:'Little Book',author:'Author',nuUrl:'https://www.novelupdates.com/series/little-book/'}];
assert.equal(match.resolve({name:'Misnamed.epub'},{title:'Another name',nuUrl:books[0].nuUrl},books).bookId,1);
assert.equal(match.resolve({name:'Little Book.epub'},{title:'Little Book',nuUrl:'https://www.novelupdates.com/series/different/'},books).kind,'ambiguous');
const payload=match.createPayload({title:'New Novel'},{author:'A',tags:['Found Family'],genres:['Fantasy'],nuUrl:'https://www.novelupdates.com/series/new/'});
assert.equal(payload.publish,false);
assert.deepEqual(Array.from(payload.genres),['Fantasy']);
function el(){const events={};return {events,value:'',files:[],checked:false,disabled:false,hidden:true,textContent:'',children:[],className:'',style:{},
 addEventListener:(key,fn)=>events[key]=fn,setAttribute(){},
 append(...nodes){this.children.push(...nodes)},replaceChildren(...nodes){this.children=[...nodes]},
 click(){}}}
const ids=Object.fromEntries(['files','folder','scan','start','auto-import','stop','rows','counts','skip','progress','status',
 'novel-choices','import-report','import-report-summary','import-report-items','download-import-report','lookup','lookup-btn','editions'].map(id=>[id,el()]));
ids.skip.checked=true;
const files=[1,2,3].map(n=>({name:n===3?'Unknown.epub':'Novel Volume '+n+'.epub',size:500+n,
 title:n===3?'Unknown':'Novel',slice(){return new Uint8Array(500+n)}}));
let created=0,uploaded=0,ingested=0,undone=0;
const json=value=>({ok:true,json:async()=>value});
const fetch=async(uri,opts={})=>{
 const p=String(uri);
 if(p==='/api/me')return json({role:'owner'});
 if(p==='/api/catalogue')return json(books);
 if(p==='/api/content')return json({edits:[]});
 if(p==='/api/private/edition/inventory')return json({editions:[]});
 if(p==='/api/admin/additional/create'){created++;return json({id:100123,ok:true,eventId:'new-event'})}
 if(p==='/api/private/edition/start')return json({sessionId:'upload-'+(uploaded+1),partSize:8388608});
 if(p.startsWith('/api/private/edition/part'))return json({ok:true});
 if(p.startsWith('/api/private/edition/finish'))return json({edition:{id:'edition-'+(++uploaded)}});
 if(p==='/api/admin/epub/ingest-metadata'){
  const data=JSON.parse(opts.body);assert.equal(data.enrichFromStaged,true);
  return json({changed:['tags','genres'],eventId:'metadata-'+(++ingested),stagedSourceUsed:true});
 }
 if(p==='/api/admin/epub/undo-metadata'){undone++;return json({ok:true})}
 throw Error('Unexpected fetch '+p);
};
const fakeMatch={norm:match.norm,
 inspect:async file=>({title:file.title,author:'Writer',synopsis:'Summary',tags:['Magic'],genres:['Fantasy'],
  nuUrl:'https://www.novelupdates.com/series/novel/',metadataFound:true}),
 resolve:(file,meta,catalogue)=>{
  if(file.title==='Unknown')return {kind:'ambiguous',reason:'Conflicting identity'};
  const row=catalogue.find(x=>x.title==='Novel');
  return row?{kind:'matched',bookId:row.id,reason:'Matched'}:{kind:'new',title:'Novel',reason:'No match'};
 },
 createPayload:match.createPayload};
const document={getElementById:k=>ids[k]||null,createElement:()=>el(),
 createTextNode:value=>({textContent:String(value)})};
const localStorage={cache:new Map(),getItem(k){return this.cache.get(k)||null},
 setItem(k,v){this.cache.set(k,v)},removeItem(k){this.cache.delete(k)}};
vm.runInNewContext(importCode,{document,window:{ConservatoryEPUBMatch:fakeMatch,
 CoverExtractor:{detectCover:async()=>({reason:'No cover'})}},fetch,localStorage,
 Blob,File:class {},Number,Promise,Set,Map,JSON,Uint8Array,encodeURIComponent,
 URL:{createObjectURL:()=>'/blob',revokeObjectURL(){}},setTimeout:fn=>fn()});
(async()=>{
 await new Promise(resolve=>setImmediate(resolve));
 ids.files.files=files;ids.files.events.change();
 await ids['auto-import'].events.click();
 assert.equal(created,1,'Volume 2 must reuse the first novel ID');
 assert.equal(uploaded,2);
 assert.equal(ingested,2);
 assert.equal(ids['import-report'].hidden,false);
 assert.match(ids['import-report-summary'].textContent,/1 ambiguous/);
 assert.equal(ids['import-report-items'].children.length,3);
 const first=ids['import-report-items'].children[0];
 assert(first.children.some(x=>x.href==='/novel/100123'));
 const undo=first.children.find(x=>x.textContent==='Undo metadata import');
 assert(undo);
 await undo.events.click();
 assert.equal(undone,1);
 console.log('One-click importer, canonical novel entry, 2 EPUBs, ambiguity report and Undo: OK');
})().catch(e=>{console.error(e);process.exitCode=1});
