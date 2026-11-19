/* Bulk-fill missing novel details from Novel Updates.
 * Step 1 builds a collector script the owner runs in their own
 * novelupdates.com tab (see nu-collector-runner.js). Step 2 sends each
 * collected page through the existing per-novel importer
 * (/api/admin/nu/book-import), which fills only empty fields, keeps an Undo
 * record per novel and stays private. Nothing here contacts Novel Updates.
 */
(function(root){
'use strict';
const FORMAT='novel-conservatory-nu-bulk-v1';
const FILL_FIELDS=['tags','genres','synopsis','cover'];
const IMPORT_FIELDS=new Set(['tags','genres','synopsis','author','originalTitle','cover',
 'nuChapterSourceText','nuTranslationSourceStatus','nuOriginalSourceStatus']);
const UNDO_KEY='nc-nu-bulk-last-batch';

const empty=v=>v===undefined||v===null||v===''||(Array.isArray(v)&&!v.length);
function canonical(value){
 try{
  const u=new URL(String(value||'').trim());
  const m=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/i.exec(u.pathname);
  if(u.protocol!=='https:'||!['novelupdates.com','www.novelupdates.com'].includes(u.hostname)||
   u.username||u.password||u.port||u.search||u.hash||!m)return '';
  return 'https://www.novelupdates.com/series/'+m[1].toLowerCase()+'/';
 }catch{return ''}
}
// Catalogue rows with saved private/community edits applied on top.
function mergeCatalogue(books,edits){
 const patches=new Map((edits||[]).map(e=>[Number(e.id),e.patch||{}]));
 return (books||[]).map(b=>({...b,...(patches.get(Number(b.id))||{})}));
}
function missingFields(book){return FILL_FIELDS.filter(f=>empty(book[f]))}
function pickNovels(books,{all=false}={}){
 const seen=new Set(),list=[];
 for(const b of books||[]){
  const nuUrl=canonical(b.nuUrl);
  if(!nuUrl||seen.has(Number(b.id)))continue;
  if(!all&&!missingFields(b).length)continue;
  seen.add(Number(b.id));
  list.push({id:Number(b.id),title:String(b.title||'').slice(0,160),nuUrl});
 }
 return list;
}
function buildCollector(sourceJs,runnerJs,list,delaySeconds){
 const delay=Math.max(3,Math.min(30,Number(delaySeconds)||5))*1000;
 const json=JSON.stringify(list).replace(/</g,'\\u003c');
 return '/* Novel Conservatory · Novel Updates collector · '+list.length+' novels.\n'+
  ' * Paste into the developer console of a www.novelupdates.com tab. */\n'+
  sourceJs.trim()+'\n;\n'+runnerJs.trim().replace(/;\s*$/,'')+'('+json+','+delay+');\n';
}
function readCollected(text){
 let data;
 try{data=JSON.parse(text)}catch{throw Error('That file is not valid JSON.')}
 if(!data||data.format!==FORMAT||!Array.isArray(data.items))
  throw Error('That file did not come from the Novel Conservatory collector.');
 const ready=[],failed=[];
 for(const item of data.items){
  const id=Number(item?.id),nuUrl=canonical(item?.nuUrl);
  const cap=item?.capture;
  if(!Number.isSafeInteger(id)||id<1||!nuUrl){failed.push({id:item?.id,title:item?.title,error:'Invalid entry'});continue}
  if(cap&&cap.source==='novelupdates-browser-v1'&&cap.novel&&typeof cap.novel==='object'&&
     canonical(cap.novel.nuUrl)===nuUrl)
   ready.push({id,title:String(item.title||''),nuUrl,capture:{source:cap.source,novel:cap.novel}});
  else failed.push({id,title:String(item.title||''),nuUrl,error:String(item.error||'No usable capture')});
 }
 return {collectedAt:String(data.collectedAt||''),ready,failed};
}
function importPayload(item,fields,preview){
 const chosen=fields.filter(f=>IMPORT_FIELDS.has(f));
 if(!chosen.length)throw Error('Choose at least one detail to fill.');
 const body={id:item.id,nuUrl:item.nuUrl,fields:chosen,capture:item.capture};
 if(preview)body.preview=true;
 return body;
}
root.NUBulk=Object.freeze({FORMAT,canonical,mergeCatalogue,missingFields,pickNovels,buildCollector,readCollected,importPayload});

// ---------------------------------------------------------------- page UI --
if(typeof document==='undefined'||!document.getElementById('nu-bulk-app'))return;
const $=id=>document.getElementById(id);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,method='GET',body){
 const r=await fetch(path,{method,credentials:'same-origin',cache:'no-store',
  headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 const j=await r.json().catch(()=>({}));
 if(!r.ok){const e=Error(j.error||('Request failed ('+r.status+')'));e.status=r.status;throw e}
 return j;
}
function say(id,text,bad=false){const el=$(id);el.textContent=text;el.classList.toggle('bad',!!bad)}

let catalogue=[],collector='',loaded=null,running=false,stopRequested=false;

async function loadCatalogue(){
 say('collect-status','Loading your catalogue…');
 try{
  const me=await api('/api/me');
  if(!['owner','editor'].includes(me.role)){say('collect-status','Only the owner or an editor can use this page.',true);return}
  const [books,content]=await Promise.all([api('/api/catalogue'),api('/api/content').catch(()=>({edits:[]}))]);
  catalogue=mergeCatalogue(Array.isArray(books)?books:(books.books||[]),content.edits);
  refreshList();
 }catch(e){say('collect-status','Could not load the catalogue: '+e.message,true)}
}
function refreshList(){
 const list=pickNovels(catalogue,{all:$('collect-all').checked});
 const linked=catalogue.filter(b=>canonical(b.nuUrl)).length;
 const delay=Number($('collect-delay').value)||5;
 $('collect-count').textContent=list.length;
 say('collect-status',list.length+' of '+linked+' linked novels will be looked up (about '+
  Math.ceil(list.length*(delay+1)/60)+' minutes). '+(catalogue.length-linked)+' novels have no Novel Updates link.');
 $('collect-build').disabled=!list.length;
 collector='';$('collect-output').hidden=true;
}
async function build(){
 const list=pickNovels(catalogue,{all:$('collect-all').checked});
 try{
  const [src,runner]=await Promise.all(['/novel/nu-source.js','/admin/nu-collector-runner.js'].map(async p=>{
   const r=await fetch(p,{cache:'no-store',credentials:'same-origin'});if(!r.ok)throw Error(p+' unavailable');return r.text()}));
  collector=buildCollector(src,runner,list,$('collect-delay').value);
  $('collect-script').value=collector;
  $('collect-output').hidden=false;
  say('collect-status','Script ready for '+list.length+' novels. Copy it, then follow the steps below.');
 }catch(e){say('collect-status','Could not build the script: '+e.message,true)}
}
async function copyScript(){
 try{await navigator.clipboard.writeText(collector);say('collect-status','Copied. Now paste it into the console of your Novel Updates tab.')}
 catch{$('collect-script').select();say('collect-status','Copy was blocked. The script is selected; press Cmd+C.',true)}
}
function downloadScript(){
 const a=document.createElement('a');
 a.href=URL.createObjectURL(new Blob([collector],{type:'text/javascript'}));
 a.download='nu-collector.js';document.body.appendChild(a);a.click();a.remove();
}

function chosenFields(){return [...document.querySelectorAll('input[name="bulk-field"]:checked')].map(x=>x.value)}
async function readFile(){
 const file=$('apply-file').files[0];
 loaded=null;$('apply-run').disabled=$('apply-preview').disabled=true;$('apply-results').replaceChildren();
 if(!file)return;
 try{
  loaded=readCollected(await file.text());
  say('apply-status',loaded.ready.length+' novels ready to fill'+(loaded.failed.length?', '+loaded.failed.length+
   ' could not be read on Novel Updates (listed below)':'')+'. Preview first to see what would change.');
  for(const f of loaded.failed)addRow(f,'Skipped',f.error,'skip');
  $('apply-run').disabled=$('apply-preview').disabled=!loaded.ready.length;
 }catch(e){say('apply-status',e.message,true)}
}
function addRow(item,outcome,detail,kind){
 const tr=document.createElement('tr');tr.className=kind;
 const link=document.createElement('a');link.href='/novel/'+encodeURIComponent(item.id)+'#nu';link.textContent='#'+item.id;
 link.target='_blank';link.rel='noopener';
 const cells=[link,item.title||'',outcome,detail||''];
 for(const c of cells){const td=document.createElement('td');td.append(c);tr.append(td)}
 $('apply-results').append(tr);
}
async function run(preview){
 if(running||!loaded)return;
 const fields=chosenFields();
 if(!fields.length)return say('apply-status','Choose at least one detail to fill.',true);
 if(!preview&&!confirm('Fill '+fields.join(', ')+' for up to '+loaded.ready.length+
  ' novels? Only empty fields are filled, and every novel can be undone.'))return;
 running=true;stopRequested=false;
 $('apply-stop').hidden=false;$('apply-run').disabled=$('apply-preview').disabled=true;
 $('apply-results').replaceChildren();
 for(const f of loaded.failed)addRow(f,'Skipped',f.error,'skip');
 const batch=[],tally={};let changed=0,unchanged=0,errors=0;
 try{
  for(const [i,item] of loaded.ready.entries()){
   if(stopRequested)break;
   say('apply-status',(preview?'Previewing ':'Filling ')+(i+1)+' of '+loaded.ready.length+' · '+item.title);
   try{
    const r=await api('/api/admin/nu/book-import','POST',importPayload(item,fields,preview));
    const list=(preview?Object.keys(r.fields||{}):(r.changed||[])).filter(f=>f!=='nuUrl');
    if(r.eventId)batch.push({eventId:r.eventId,id:item.id});
    if(list.length){changed++;for(const f of list)tally[f]=(tally[f]||0)+1;
     addRow(item,preview?'Would fill':'Filled',list.join(', '),'ok')}
    else{unchanged++;addRow(item,'Nothing missing','', 'same')}
   }catch(e){
    errors++;addRow(item,'Needs a look',e.message,'err');
    if(e.status===401||e.status===403&&/editor/i.test(e.message)){say('apply-status','Your sign-in expired. Reload and continue.',true);break}
   }
   if(!preview&&batch.length){try{localStorage.setItem(UNDO_KEY,JSON.stringify({at:new Date().toISOString(),batch}))}catch{}}
   await sleep(preview?120:300);
  }
 }finally{
  running=false;$('apply-stop').hidden=true;$('apply-run').disabled=$('apply-preview').disabled=false;
  const parts=Object.entries(tally).map(([k,v])=>k+' '+v).join(', ');
  say('apply-status',(stopRequested?'Stopped. ':'Done. ')+(preview?'Would fill ':'Filled ')+changed+' novels'+
   (parts?' ('+parts+')':'')+'; '+unchanged+' had nothing missing; '+errors+' need a look.'+
   (preview?' Nothing was changed.':' Use “Undo this batch” if anything looks wrong.'),!!errors&&!changed);
  showUndo();
 }
}
function lastBatch(){try{return JSON.parse(localStorage.getItem(UNDO_KEY)||'null')}catch{return null}}
function showUndo(){
 const b=lastBatch();
 $('undo-box').hidden=!(b&&b.batch&&b.batch.length);
 if(b&&b.batch)$('undo-info').textContent='Last batch: '+b.batch.length+' novels filled on '+new Date(b.at).toLocaleString()+'.';
}
async function undoBatch(){
 const b=lastBatch();if(!b||!b.batch?.length||running)return;
 if(!confirm('Undo the last bulk fill for '+b.batch.length+' novels?'))return;
 running=true;let ok=0;const left=[];
 for(const [i,entry] of [...b.batch].reverse().entries()){
  say('undo-status','Undoing '+(i+1)+' of '+b.batch.length+'…');
  try{await api('/api/admin/nu/book-undo','POST',{eventId:entry.eventId});ok++}
  catch(e){left.push({...entry,error:e.message})}
  await sleep(200);
 }
 running=false;
 try{left.length?localStorage.setItem(UNDO_KEY,JSON.stringify({at:b.at,batch:left})):localStorage.removeItem(UNDO_KEY)}catch{}
 say('undo-status','Undid '+ok+' novels.'+(left.length?' '+left.length+' could not be undone (they were edited since): '+
  left.slice(0,10).map(x=>'#'+x.id).join(', '):''),!!left.length);
 showUndo();
}

$('collect-all').addEventListener('change',refreshList);
$('collect-delay').addEventListener('change',refreshList);
$('collect-build').addEventListener('click',build);
$('collect-copy').addEventListener('click',copyScript);
$('collect-download').addEventListener('click',downloadScript);
$('apply-file').addEventListener('change',readFile);
$('apply-preview').addEventListener('click',()=>run(true));
$('apply-run').addEventListener('click',()=>run(false));
$('apply-stop').addEventListener('click',()=>{stopRequested=true;say('apply-status','Stopping after this novel…')});
$('undo-run').addEventListener('click',undoBatch);
showUndo();
loadCatalogue();
})(typeof window!=='undefined'?window:globalThis);
