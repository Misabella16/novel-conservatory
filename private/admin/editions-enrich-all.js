/* One-click scan for ALL privately stored EPUB editions.
 * Runs sequentially in the owner's authenticated browser, without uploading
 * EPUB text anywhere else. Saves a local checkpoint after each edition. */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
const button=$('backfill'),pause=$('backfill-stop'),progress=$('backfill-progress');
if(!button||!pause||!progress)return;
const checkpointKey='conservatory:stored-epub-enrichment:v2';
let running=false,stopRequested=false;
const blankStats=()=>({metadataImproved:0,tagUpdates:0,genreUpdates:0,synopsisUpdates:0,coversStored:0,
 noSubjectTags:0,noCoverFound:0,metadataMissing:0,tooLarge:0});
const fileKey=row=>[row.id,row.editionId,row.bytes||0].join('|');
function status(message,error=false){
 const box=$('backfill-status');
 box.textContent=message;box.className='topmsg'+(error?' error':'');
}
function loadCheckpoint(){
 try{
  const result=JSON.parse(localStorage.getItem(checkpointKey)||'null');
  return result?.version===2&&Array.isArray(result.completed)&&result.failures&&
   typeof result.failures==='object'?result:null;
 }catch{return null}
}
function saveCheckpoint(state){
 try{localStorage.setItem(checkpointKey,JSON.stringify(state));return true}
 catch{return false}
}
function updateProgress(done,total,stats,failed,filename=''){
 progress.value=total?Math.min(100,Math.round(done/total*100)):100;
 $('backfill-counts').textContent=done+' / '+total+' EPUBs attempted · '+
  stats.tagUpdates+' tag updates · '+stats.genreUpdates+' genre updates · '+stats.coversStored+' private covers · '+
  failed+' needing retry'+(filename?' · '+filename:'');
}
function renderErrors(errors){
 const host=$('backfill-errors');host.replaceChildren();
 const pairs=Object.values(errors);
 if(!pairs.length)return;
 const heading=document.createElement('strong');
 heading.textContent=pairs.length+' files needing retry or manual attention';
 host.append(heading);
 const list=document.createElement('ul');
 for(const message of pairs.slice(0,100)){
  const item=document.createElement('li');item.textContent=message;list.append(item);
 }
 host.append(list);
 if(pairs.length>100){
  const more=document.createElement('p');
  more.textContent='Showing the first 100 errors of '+pairs.length+'.';
  host.append(more);
 }
}
pause.addEventListener('click',()=>{
 if(!running)return;
 stopRequested=true;pause.disabled=true;
 status('Pausing after the current file. Click Enrich all again to resume.');
});
button.addEventListener('click',async()=>{
 const tools=window.ConservatoryStoredEpubTools;
 if(running||!tools)return;
 running=true;stopRequested=false;button.disabled=true;pause.disabled=false;
 status('Reading the full private EPUB inventory…');
 try{
  const [catalogue,content,inventory,legacy]=await Promise.all([
   tools.fetchJson(await fetch('/api/catalogue',{cache:'no-store',credentials:'same-origin'})),
   tools.fetchJson(await fetch('/api/content',{cache:'no-store',credentials:'same-origin'})),
   tools.fetchJson(await fetch('/api/private/edition/inventory',{cache:'no-store',credentials:'same-origin'})),
   tools.fetchJson(await fetch('/api/private/epub/bulk-status',{cache:'no-store',credentials:'same-origin'}))
  ]);
  const edits=new Map((content.edits||[]).map(x=>[Number(x.id),x.patch]));
  const original=Array.isArray(catalogue)?catalogue:catalogue.books||[];
  const allBooks=original.map(x=>({...x,...(edits.get(Number(x.id))||{})}));
  const knownIds=new Set(allBooks.map(x=>Number(x.id)));
  const entries=new Map();
  for(const row of [
   ...(inventory.editions||[]),
   ...Object.entries(legacy.files||{}).map(([id,info])=>({
    id:Number(id),editionId:'legacy',filename:info.name||'stored.epub',
    bytes:Number(info.size)||0
   }))
  ]){
   if(!Number.isSafeInteger(Number(row.id))||!row.editionId)continue;
   entries.set(fileKey(row),row);
  }
  const rows=[...entries.values()];
  const total=rows.length;
  let checkpoint=loadCheckpoint();
  const currentKeys=new Set(entries.keys());
  if(!checkpoint||checkpoint.finished){
   checkpoint={version:2,completed:[],failures:{},stats:blankStats(),finished:false};
  }
  const completed=new Set(checkpoint.completed.filter(k=>currentKeys.has(k)));
  const errors=Object.fromEntries(
   Object.entries(checkpoint.failures).filter(([key])=>currentKeys.has(key)));
  const stats={...blankStats(),...checkpoint.stats};
  let attempted=new Set(completed);
  updateProgress(attempted.size,total,stats,Object.keys(errors).length);
  if(!total){
   status('No stored EPUB editions were found.');
   return;
  }
  status('Scanning all '+total+' stored EPUBs, one at a time. Keep this browser tab open.');
  for(const row of rows){
   if(stopRequested)break;
   const key=fileKey(row);
   if(completed.has(key))continue;
   const id=Number(row.id),editionId=row.editionId;
   const filename=String(row.filename||'stored.epub');
   attempted.add(key);
   updateProgress(attempted.size,total,stats,Object.keys(errors).length,filename);
   try{
    if(!knownIds.has(id))throw Error('No matching catalogue novel ID');
    if(Number(row.bytes)>250*1048576){
     stats.tooLarge++;
    }else{
     const endpoint=editionId==='legacy'
      ?'/api/private/epub/file?id='+encodeURIComponent(id)
      :'/api/private/edition/file?id='+encodeURIComponent(id)+'&edition='+encodeURIComponent(editionId);
     const download=await fetch(endpoint,{cache:'no-store',credentials:'same-origin'});
     if(!download.ok)throw Error('Could not read private EPUB (HTTP '+download.status+')');
     const epub=new File([await download.blob()],filename,{type:'application/epub+zip'});
     const metadata=await tools.inspect(epub);
     if(!metadata.metadataFound)stats.metadataMissing++;
     if(!metadata.tags?.length)stats.noSubjectTags++;
     const saved=await tools.ingest(id,editionId,metadata);
     if(saved.changed?.length){
      stats.metadataImproved++;
      if(saved.changed.includes('tags'))stats.tagUpdates++;
      if(saved.changed.includes('genres'))stats.genreUpdates++;
      if(saved.changed.includes('synopsis'))stats.synopsisUpdates++;
     }
     const cover=await tools.cover({file:epub,bookId:id});
     if(cover.published)stats.coversStored++;
     else if(/no cover|not found|unavailable/i.test(cover.detail||''))stats.noCoverFound++;
    }
    completed.add(key);
    delete errors[key];
   }catch(error){
    errors[key]='#'+id+' · '+filename+': '+String(error.message||error);
   }
   checkpoint={version:2,completed:[...completed],failures:errors,stats,finished:false};
   const saved=saveCheckpoint(checkpoint);
   updateProgress(attempted.size,total,stats,Object.keys(errors).length);
   if(!saved)status('Your browser could not save scan progress. Keep this tab open.',true);
   // Allow the browser to paint between EPUBs; never retain a growing list
   // of unpacked EPUB files in memory.
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  const remaining=total-completed.size;
  checkpoint={version:2,completed:[...completed],failures:errors,stats,
   finished:remaining===0};
  saveCheckpoint(checkpoint);
  updateProgress(attempted.size,total,stats,Object.keys(errors).length);
  renderErrors(errors);
  status(
   'Processed '+attempted.size+' / '+total+' stored EPUB editions. '+
   stats.tagUpdates+' novels received additional subject tags, '+stats.genreUpdates+' received genres, '+
   stats.synopsisUpdates+' received missing synopses, '+
   stats.coversStored+' private covers were saved. '+
   stats.noSubjectTags+' EPUBs have no embedded subject tags, '+
   stats.tooLarge+' were too large to inspect in the browser. '+
   (remaining?remaining+' editions still need processing/retry. ':'All editions processed. ')+
   (stopRequested?'Paused safely. Click again to resume. ':'')+
   'Refresh the private catalogue to see imported metadata.',
   Object.keys(errors).length>0
  );
 }catch(error){
  status('Could not finish the full-library scan: '+String(error.message||error)+
   '. Click Enrich all to retry any saved progress.',true);
 }finally{
  running=false;button.disabled=false;pause.disabled=true;
 }
});
})();
