(()=>{
'use strict';
const $=id=>document.getElementById(id);
const api=async(url,init={})=>{
 const r=await fetch(url,{cache:'no-store',credentials:'same-origin',...init});
 const data=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(data.error||'Request failed ('+r.status+')');
 return data;
};
const show=(node,msg,error=false)=>{node.textContent=msg;node.classList.toggle('error',!!error)};
let latest=null;
let safeScan=null;
async function scanSafe(){
 const status=$('safe-status'),host=$('safe-results'),button=$('safe-scan');
 button.disabled=true;$('safe-merge').disabled=true;
 host.replaceChildren();show(status,'Scanning the current catalogue for exact source and author/title matches…');
 try{
  const result=await api('/api/admin/nu/duplicates/scan');
  safeScan=result;
  show(status,result.proposals.length+' safe merge'+(result.proposals.length===1?'':'s')+' found. '+
   result.skipped.length+' skipped for safety. No records have been changed.');
  for(const item of result.proposals.slice(0,45)){
   const row=document.createElement('div');row.className='result';
   row.append(text('span','✓ #'+item.sourceId+' '+item.sourceTitle+' → keep #'+item.targetId+' '+item.targetTitle+' ('+item.match+')'));
   host.append(row);
  }
  if(result.skipped.length){
   const heading=text('h3','Skipped entries that need attention');host.append(heading);
   for(const item of result.skipped.slice(0,40)){
    const row=document.createElement('div');row.className='result';
    row.append(text('span','#'+item.id+' · '+item.title+' · '+item.reason));host.append(row);
   }
  }
  $('safe-merge').disabled=!result.proposals.length;
 }catch(error){safeScan=null;show(status,'Scan failed: '+error.message,true)}
 finally{button.disabled=false}
}
$('safe-scan').addEventListener('click',scanSafe);
$('safe-merge').addEventListener('click',async()=>{
 if(!safeScan?.proposals?.length)return;
 const button=$('safe-merge');button.disabled=true;
 show($('safe-status'),'Merging at most 12 safe duplicate pairs. Every change gets an Undo entry…');
 try{
  const result=await api('/api/admin/nu/duplicates/merge-safe',{method:'POST',
   headers:{'content-type':'application/json'},body:JSON.stringify({})});
  const errors=(result.results||[]).filter(x=>!x.ok);
  show($('safe-status'),'✓ '+result.merged+' duplicate'+(result.merged===1?'':'s')+
   ' combined with no per-book approval. '+errors.length+' skipped at save time. '+
   (result.remainingMayExist?'Another batch may be available; scan again. ':'')+
   'Open Undo history below to reverse a merge.'+
   (errors.length?'\nSkipped: '+errors.slice(0,5).map(x=>'#'+x.sourceId+': '+x.error).join('; '):''));
  await history();
  await scanSafe();
 }catch(error){show($('safe-status'),'Nothing else was merged: '+error.message,true);button.disabled=false}
});

const idOf=x=>{
 const match=/^#?([1-9][0-9]*)/.exec(String(x||'').trim());
 return match?Number(match[1]):null;
};
function text(tag,content){
 const el=document.createElement(tag);el.textContent=String(content??'');return el;
}
function limit(value){
 const s=Array.isArray(value)?value.join(', '):String(value??'');
 return s.length>1800?s.slice(0,1800)+'…':s||'Not provided';
}
async function find(){
 const q=$('find-q').value.trim(),host=$('find-results');host.replaceChildren();
 if(q.length<2)return;
 try{
  const {items=[]}=await api('/api/admin/nu/search-books?q='+encodeURIComponent(q));
  if(!items.length){host.append(text('p','No matches. Try an alternative spelling.'));return}
  for(const item of items){
   const row=document.createElement('div');row.className='result';
   const info=document.createElement('div'),name=text('strong','#'+item.id+' · '+item.title);
   const sub=text('small',' · '+(item.kind==='original'?'Original CG entry':'Added novel')+
    (item.hasSynopsis?' · Synopsis present':' · Missing synopsis')+
    ' · '+item.tags+' tags · '+item.genres+' genres');
   info.append(name,sub);row.append(info);
   const actions=document.createElement('div');actions.className='row';
   if(item.id>=100000){
    const source=text('button','Use as duplicate');source.type='button';source.className='secondary';
    source.addEventListener('click',()=>{$('source-id').value=item.id;show($('merge-status'),'Duplicate selected: '+item.title+'. Choose the record you want to keep.')});
    actions.append(source);
   }
   const target=text('button','Keep this one');target.type='button';target.className='secondary';
   target.addEventListener('click',()=>{$('target-id').value=item.id;show($('merge-status'),'Destination selected: '+item.title+'. Compare records before merging.')});
   actions.append(target);row.append(actions);host.append(row);
  }
 }catch(err){host.append(text('p','Could not search: '+err.message))}
}
$('find-books').addEventListener('click',find);
$('find-q').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();find()}});
async function compare(){
 const sourceId=idOf($('source-id').value),targetId=idOf($('target-id').value);
 $('merge-preview').hidden=true;latest=null;
 if(!sourceId||!targetId||sourceId===targetId)return show($('merge-status'),'Choose different source and destination IDs.',true);
 try{
  const result=await api('/api/admin/nu/merge-preview?sourceId='+sourceId+'&targetId='+targetId);
  latest=result;
  $('merge-head').textContent='Merge #'+sourceId+' into #'+targetId;
  $('merge-summary').textContent='Keep “'+result.target.title+'” and combine information from “'+result.source.title+'”. Original record #'+targetId+' survives.';
  const wrap=$('merge-conflicts');wrap.replaceChildren();
  for(const c of result.conflicts||[]){
   const block=document.createElement('div');block.className='conflict';
   const header=text('strong','Conflict: '+c.field);block.append(header);
   const columns=document.createElement('div');columns.className='compare';
   const a=document.createElement('div'),b=document.createElement('div');
   a.append(text('strong','Current (kept by default)'),text('p',limit(c.current)));
   b.append(text('strong','Duplicate (optional replacement)'),text('p',limit(c.incoming)));
   columns.append(a,b);block.append(columns);
   const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.dataset.field=c.field;
   label.append(check,text('span','Use the duplicate’s '+c.field+' instead'));block.append(label);
   wrap.append(block);
  }
  if(!(result.conflicts||[]).length)wrap.append(text('p','No conflicting scalar fields. The missing fields and unique story tags will be combined automatically.'));
  const blocked=!!result.blockedByEpub||!!result.alreadyMerged;
  $('merge-go').disabled=blocked;
  $('merge-preview').hidden=false;
  show($('merge-status'),blocked?(result.alreadyMerged?
   'That duplicate has already been merged. Check the Undo history.':
   'This duplicate has EPUB editions attached. The merge is blocked to avoid breaking EPUB links. Ask the Owner to transfer the editions first.'):
   'Ready. Merging will preserve the source record for Undo, without requiring a separate approval.',blocked);
 }catch(e){show($('merge-status'),e.message,true)}
}
$('preview-merge').addEventListener('click',compare);
$('merge-go').addEventListener('click',async()=>{
 if(!latest||latest.blockedByEpub||latest.alreadyMerged)return;
 const btn=$('merge-go');btn.disabled=true;
 const fields=[...$('merge-conflicts').querySelectorAll('input[data-field]:checked')].map(x=>x.dataset.field);
 try{
  const result=await api('/api/admin/nu/merge-apply',{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({
    sourceId:latest.source.id,targetId:latest.target.id,
    preferSourceFields:fields,expectedBefore:latest.expectedBefore
   })
  });
  $('merge-preview').hidden=true;latest=null;
  show($('merge-status'),'✓ Merged duplicate #'+result.mergedFrom+' into #'+result.id+'. The original ID is preserved; browse should show one record after refreshing. Undo is available in the history below.'+
   (result.privateSynced===false?'\nPrivate catalogue synchronization needs attention.':''));
  await history();await find();
 }catch(error){show($('merge-status'),error.message,true);btn.disabled=false}
});
async function history(){
 const host=$('undo-history');host.replaceChildren();
 try{
  const {items=[]}=await api('/api/admin/nu/merge-history');
  if(!items.length)host.append(text('p','No changes recorded yet.'));
  for(const item of items){
   const row=document.createElement('div');row.className='history-row';
   const info=document.createElement('div');
   const description=item.operation==='merge'?
    'Merged duplicate #'+item.duplicate_id+' into #'+item.target_id:
    item.operation==='create'?'Created novel #'+item.target_id:
    'Updated existing novel #'+item.target_id;
   info.append(text('strong',description),
    text('small',new Date(item.created_at+'Z').toLocaleString()+' · '+item.actor_email),
    text('small',item.undone_at?'Undone':'Change ID: '+item.id));
   row.append(info);
   const b=text('button',item.undone_at?'Undone':'↶ Undo');b.type='button';b.className='danger';b.disabled=!!item.undone_at;
   b.addEventListener('click',async()=>{
    b.disabled=true;
    try{
     const result=await api('/api/admin/nu/undo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({eventId:item.id})});
     show($('history-status'),'Restored previous state of novel #'+result.targetId+'. '+(result.restoredDuplicateId?'Duplicate #'+result.restoredDuplicateId+' is visible again.':'')+
      (result.privateSynced===false?' The public change was undone, but a newer private edit needs manual review.':''));
     await history();
    }catch(e){show($('history-status'),'Undo stopped safely: '+e.message,true);b.disabled=false}
   });
   row.append(b);host.append(row);
  }
  show($('history-status'),items.length+' recent changes. Undo any newer changes before older ones.');
 }catch(error){show($('history-status'),error.message+'. If the migration is missing, ask the Owner to run database/CATALOGUE_MERGE_UNDO_MIGRATION.sql in shared D1.',true)}
}
$('refresh-history').addEventListener('click',history);
history();
})();