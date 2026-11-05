(()=>{'use strict';const $=id=>document.getElementById(id);let novels=[],lastCreated=null,parsed=[],role='reader';const show=(id,text,error=false)=>{const el=$(id);el.textContent=String(text);el.classList.toggle('error',error)};
const call=async(path,options={})=>{const r=await fetch(path,{credentials:'same-origin',cache:'no-store',...options});const j=await r.json().catch(()=>({error:'Unexpected server response'}));if(!r.ok)throw Error(j.error||'Request failed');return j};
const post=(path,data)=>call(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
const fields=['title','originalTitle','author','originalLanguage','language','translator','translation','novelOrigin','originalUrl','nuUrl','translatorUrl','sourceUrl','genres','tags','contentWarnings','totalChapters','chaptersTranslated','metadataSource','synopsis'];
function payload(){const p={};for(const field of fields){const v=$(field).value.trim();p[field]=['totalChapters','chaptersTranslated'].includes(field)?(v?Number(v):null):v;}return p;}
// Show likely matches before saving, not after somebody has created two cards.
let duplicateLookupSequence=0;
let duplicateTimer=null;
let selectedMergeId=null;
function resetMergeSelection(){selectedMergeId=null;$('create').textContent='Create novel'}
async function checkDuplicateBeforeSubmit(){
 const seq=++duplicateLookupSequence;
 const title=$('title').value.trim(),nuUrl=$('nuUrl').value.trim();
 const box=$('duplicate-check');
 if(title.length<2&&!nuUrl){box.hidden=true;box.replaceChildren();return}
 const params=new URLSearchParams({
  title,originalTitle:$('originalTitle').value.trim(),
  author:$('author').value.trim(),nuUrl,sourceUrl:$('sourceUrl').value.trim()
 });
 box.hidden=false;box.replaceChildren();box.append(document.createTextNode('Checking the existing library…'));
 try{
  const result=await call('/api/admin/nu/check-duplicate?'+params.toString());
  if(seq!==duplicateLookupSequence)return;
  box.replaceChildren();
  if(!result.items?.length){
   box.append(document.createTextNode('No matching title or Novel Updates series found. The server will check again when you save.'));
   return;
  }
  const heading=document.createElement('strong');
  heading.textContent=result.items.length+' potential existing '+(result.items.length===1?'novel':'novels')+' found:';
  box.append(heading);
  for(const item of result.items){
   const line=document.createElement('div');line.style.marginTop='8px';
   const name=document.createElement('strong');
   name.textContent='#'+item.id+' · '+item.title;
   const detail=document.createElement('small');detail.style.display='block';
   detail.textContent=(item.author||'Author unknown')+' · '+item.matchedBy+' · '+item.visibility+
    (item.hasSynopsis?' · Has synopsis':' · Missing synopsis')+' · '+item.tagCount+' tags';
   const href=document.createElement('a');
   href.href=item.kind==='extra'?'/admin/add-novels.html?novel='+encodeURIComponent(item.id):
    '/admin/catalogue-editor.html?id='+encodeURIComponent(item.id);
   href.textContent='Open existing novel';
   const choose=document.createElement('button');
   choose.type='button';choose.textContent='Merge new details into this novel';
   choose.style.cssText='display:block;margin:6px 0;background:#49644e;font-size:12px;padding:7px 9px';
   choose.addEventListener('click',()=>{
    // Selection itself is enough. No additional confirmation popup.
    // All saved changes are recorded in the reversible history.
    selectedMergeId=item.id;
    $('create').textContent='Merge into novel #'+item.id;
    const note=document.createElement('p');note.style.fontWeight='650';
    note.textContent='Selected #'+item.id+' as the destination. Submit to fill missing metadata and combine tags.';
    box.append(note);
   });
   line.append(name,detail,href,choose);box.append(line);
  }
  const merge=document.createElement('a');merge.href='/admin/resolve-duplicates.html';
  merge.textContent='Compare or merge duplicates (Undo available)';
  merge.style.cssText='display:block;margin-top:10px;font-weight:650';
  box.append(merge);
 }catch(e){
  if(seq!==duplicateLookupSequence)return;
  box.textContent='Duplicate preview unavailable ('+e.message+'). Saving will still check for matches.';
 }
}
for(const id of ['title','originalTitle','author','nuUrl','sourceUrl']){
 $(id).addEventListener('input',()=>{
  resetMergeSelection();
  clearTimeout(duplicateTimer);
  duplicateTimer=setTimeout(checkDuplicateBeforeSubmit,350);
 });
 $(id).addEventListener('change',()=>{resetMergeSelection();clearTimeout(duplicateTimer);checkDuplicateBeforeSubmit()});
}
function chooseTab(t){if(role!=='owner'&&role!=='editor')return;if(role==='editor'&&['bulk','epubs'].includes(t))return;for(const n of ['single','bulk','epubs','manage','review']){$(n).hidden=n!==t;const b=$('tab-'+n);b.setAttribute('aria-selected',String(n===t))}if(t==='review')loadPending();if(t==='epubs'||t==='manage')loadNovels()}
for(const t of ['single','bulk','epubs','manage','review'])$('tab-'+t).addEventListener('click',()=>chooseTab(t));
async function loadNovels(){try{const j=await call('/api/additional/books');novels=j.novels||[];const dl=$('additional-novel-list');dl.replaceChildren();for(const novel of novels){const op=document.createElement('option');op.value=`#${novel.id} · ${novel.title}`;dl.append(op);}}catch(e){show('epub-status',e.message,true)}}
function selectedNovel(){const x=$('epub-novel').value.trim();const found=/^#(\d+)\b/.exec(x);if(found)return novels.find(b=>b.id===Number(found[1]))||null;return novels.find(b=>b.title.toLocaleLowerCase()===x.toLocaleLowerCase())||null;}
$('create-form').addEventListener('submit',async(e)=>{e.preventDefault();const btn=$('create');btn.disabled=true;show('created','Creating novel…');try{const targetId=selectedMergeId;
 const j=await post('/api/admin/additional/create',{...payload(),publish:$('publish').checked,
  ...(targetId?{targetId,confirmIdentity:true}:{})});resetMergeSelection();lastCreated=j.id>=100000?j.id:null;
 const note=j.reused?(j.notUpdated?'Existing record reused without changing its metadata or publication status. ':('Matched an existing book and filled safe metadata gaps. '+(j.conflicts?.length?'Conflicting values were preserved for comparison. ':'')+'Undo is in Merge history. ')):'Created a new entry. ';
 const visibility=j.reused&&j.notUpdated?'Publication status was kept unchanged. ':'';
 show('created',note+'Novel #'+j.id+'. '+visibility+'You can open the existing entry or attach EPUB editions privately.');
 checkDuplicateBeforeSubmit().catch(()=>{});
 $('cover-after').hidden=j.id<100000;
 await loadNovels();
 if(j.id>=100000){
  const found=novels.find(n=>n.id===j.id);
  $('epub-novel').value=found?`#${j.id} · ${found.title}`:`#${j.id}`;
 }else{
  show('created',$('created').textContent+' This is one of the original 962 novels: use Catalogue editor for metadata and the main EPUB tools for its editions.');
 }}catch(e){show('created',e.message+'. If two different records may match, use Merge duplicates to compare them first.',true);checkDuplicateBeforeSubmit().catch(()=>{})}finally{btn.disabled=false}});
$('save-cover').addEventListener('click',async()=>{if(!lastCreated)return;const file=$('owner-cover').files[0];if(!file)return show('cover-status','Choose a cover image.',true);const fd=new FormData();fd.set('novel_id',lastCreated);fd.set('image',file);fd.set('source',$('owner-credit').value||'Owner-supplied edition cover');fd.set('replace','1');const btn=$('save-cover');btn.disabled=true;try{await call('/api/admin/additional/auto-cover',{method:'POST',body:fd});show('cover-status','Cover saved. It will display publicly only if the novel is published.')}catch(e){show('cover-status',e.message,true)}finally{btn.disabled=false}});
// Conservative RFC 4180-compatible parser: quotes, escaped quotes, and embedded newlines.
function parseCSV(t){const rows=[];let row=[],cell='',quote=false;const txt=String(t).replace(/^\uFEFF/,'');for(let i=0;i<txt.length;i++){const ch=txt[i];if(ch==='"'){if(quote&&txt[i+1]==='"'){cell+='"';i++;}else quote=!quote;}else if(ch===','&&!quote){row.push(cell);cell='';}else if((ch==='\n'||ch==='\r')&&!quote){row.push(cell);cell='';if(row.some(x=>x.trim()))rows.push(row);row=[];if(ch==='\r'&&txt[i+1]==='\n')i++;}else cell+=ch;}if(quote)throw Error('Unclosed CSV quote.');row.push(cell);if(row.some(x=>x.trim()))rows.push(row);const header=rows.shift()?.map(x=>x.trim());if(!header||!header.includes('title'))throw Error('CSV needs a “title” column.');return rows.map(r=>Object.fromEntries(header.map((h,i)=>[h,r[i]||''])))}
$('preview-entries').addEventListener('click',async()=>{const file=$('entries-file').files[0];if(!file)return show('bulk-status','Choose a CSV or JSON first.',true);if(file.size>5*1048576)return show('bulk-status','Files must be under 5 MiB.',true);try{const s=await file.text();const v=file.name.toLowerCase().endsWith('.csv')?parseCSV(s):JSON.parse(s);if(!Array.isArray(v))throw Error('JSON must contain an array of novel objects.');if(v.length>5000)throw Error('Please import up to 5000 novel entries per file.');parsed=v.map(x=>({title:String(x.title||'').trim(),...x}));if(parsed.some(x=>!x.title))throw Error('Every row must have a novel title.');$('bulk-preview').replaceChildren();for(const v of parsed.slice(0,50)){const tr=document.createElement('tr');for(const key of ['title','author','translator','sourceUrl']){const td=document.createElement('td');td.textContent=String(v[key]||'').slice(0,200);tr.append(td)}$('bulk-preview').append(tr)}show('bulk-status',`Previewing ${parsed.length} entries${parsed.length>50?' (first 50 shown)':''}. Ready to import.`);$('import-entries').disabled=!parsed.length}catch(e){parsed=[];$('import-entries').disabled=true;show('bulk-status',e.message,true)}});
$('import-entries').addEventListener('click',async()=>{if(!parsed.length)return;const count=parsed.length;if(!window.confirm(`Import ${count} catalogue entries${$('bulk-publish').checked?' and publish their metadata':''}? Duplicate titles will be skipped.`))return;const btn=$('import-entries');btn.disabled=true;let ok=0,fail=0,err=[];try{for(let i=0;i<parsed.length;i+=100){try{const j=await post('/api/admin/additional/bulk',{novels:parsed.slice(i,i+100),publish:$('bulk-publish').checked});for(const row of j.results||[]){if(row.ok)ok++;else{fail++;if(err.length<12)err.push(`${row.title}: ${row.error}`)}}}catch(e){fail+=Math.min(100,parsed.length-i);if(err.length<12)err.push(e.message)}show('bulk-status',`${Math.min(i+100,parsed.length)}/${parsed.length} processed · ${ok} added · ${fail} skipped/failed.`)}show('bulk-status',`Completed. ${ok} added, ${fail} skipped/failed.\n${err.join('\n')}`);await loadNovels();}finally{btn.disabled=false}});
async function uploadOne(file,id,label,translator,onProgress){if(!/\.epub$/i.test(file.name)||file.size<100||file.size>2147483648)throw Error(`“${file.name}” must be an EPUB under 2 GiB.`);const begin=await post('/api/private/edition/start',{novelId:id,size:file.size,filename:file.name,label,translator,language:'English'});const total=Math.ceil(file.size/begin.partSize);let finished=false;try{for(let n=1;n<=total;n++){const chunk=file.slice((n-1)*begin.partSize,Math.min(n*begin.partSize,file.size));await call(`/api/private/edition/part?session=${encodeURIComponent(begin.sessionId)}&part=${n}`,{method:'POST',headers:{'content-type':'application/octet-stream'},body:chunk});onProgress(n/total)}const j=await call('/api/private/edition/finish?session='+encodeURIComponent(begin.sessionId),{method:'POST'});finished=true;return j.edition}finally{if(!finished)await call('/api/private/edition/abort?session='+encodeURIComponent(begin.sessionId),{method:'POST'}).catch(()=>{})}}
async function coverFromEPUB(file,id){if(!$('extract-cover').checked||!window.CoverExtractor||file.size>250*1048576)return null;try{const x=await window.CoverExtractor.detectCover(file);if(!x.image)return null;const fd=new FormData();fd.set('novel_id',String(id));fd.set('image',new File([x.image],'cover.jpg',{type:'image/jpeg'}));fd.set('source',file.name.slice(0,130));const j=await call('/api/admin/additional/auto-cover',{method:'POST',body:fd});return j.published?'Cover extracted and shared':'Existing cover kept'}catch(e){return 'Cover could not be extracted: '+e.message}}
$('upload-epubs').addEventListener('click',async()=>{const novel=selectedNovel();const files=[...$('epub-files').files];if(!novel)return show('epub-status','Choose a novel from the list, or create it first.',true);if(!files.length)return show('epub-status','Choose at least one EPUB file.',true);if(!window.confirm(`Upload ${files.length} EPUB editions privately for “${novel.title}”?`))return;const b=$('upload-epubs');b.disabled=true;let successes=0,failures=0;let errors=[];try{for(let i=0;i<files.length;i++){const file=files[i];show('epub-status',`Uploading ${i+1}/${files.length}: ${file.name}`);try{await uploadOne(file,novel.id,$('epub-label').value||'Translation edition',$('epub-translator').value,(fraction)=>{$('epub-progress').value=100*(i+fraction)/files.length});successes++;const c=await coverFromEPUB(file,novel.id);if(c)errors.push(c)}catch(e){failures++;errors.push(file.name+': '+e.message)}}show('epub-status',`Finished: ${successes} uploaded, ${failures} failed.\n${errors.join('\n')}`,!!failures)}finally{b.disabled=false}});
let managed=null,lastManageEvent=null;
$('load-manage').addEventListener('click',()=>{lastManageEvent=null;$('undo-manage').hidden=true;const value=$('manage-novel').value.trim();const m=/^#(\d+)\b/.exec(value);managed=m?novels.find(n=>n.id===Number(m[1])):novels.find(n=>n.title.toLocaleLowerCase()===value.toLocaleLowerCase());if(!managed)return show('manage-status','Novel not found. Choose from the list.',true);for(const f of ['title','originalTitle','author','originalLanguage','language','novelOrigin','originalUrl','nuUrl','translatorUrl','sourceUrl','translator','synopsis','metadataSource'])$('manage-'+f).value=managed[f]||'';for(const f of ['tags','genres','contentWarnings'])$('manage-'+f).value=Array.isArray(managed[f])?managed[f].join(', '):managed[f]||'';for(const f of ['totalChapters','chaptersTranslated'])$('manage-'+f).value=managed[f]??'';$('manage-translation').value=managed.translation||'unconfirmed';$('manage-publish').checked=managed.visibility==='published';$('manage-fields').hidden=false;show('manage-status','Loaded novel #'+managed.id)});
$('save-manage').addEventListener('click',async()=>{if(!managed)return;const patch={};for(const f of ['title','originalTitle','author','originalLanguage','language','novelOrigin','originalUrl','nuUrl','translatorUrl','sourceUrl','translator','synopsis','metadataSource','tags','genres','contentWarnings','translation'])patch[f]=$('manage-'+f).value.trim();for(const f of ['totalChapters','chaptersTranslated'])patch[f]=$('manage-'+f).value.trim()?Number($('manage-'+f).value):null;const publish=$('manage-publish').checked;const button=$('save-manage');button.disabled=true;try{
 const result=await post('/api/admin/additional/edit',{id:managed.id,patch,publish});
 lastManageEvent=result.eventId||null;$('undo-manage').hidden=!lastManageEvent;
 show('manage-status',result.unchanged?'No changes needed for novel #'+managed.id+'.':
  'Saved novel #'+managed.id+' immediately. You can Undo this edit without approval.');
 await loadNovels();managed=novels.find(n=>n.id===managed.id);
}catch(e){show('manage-status',e.message,true)}finally{button.disabled=false}});
$('undo-manage').addEventListener('click',async()=>{
 if(!lastManageEvent)return;
 const button=$('undo-manage');button.disabled=true;
 try{
  await post('/api/admin/nu/undo',{eventId:lastManageEvent});
  lastManageEvent=null;button.hidden=true;
  show('manage-status','Restored the previous metadata and publication status. Reload this novel to see the original values.');
  await loadNovels();
 }catch(e){show('manage-status','Undo stopped to protect newer edits: '+e.message,true)}
 finally{button.disabled=false}
});
$('save-manage-cover').addEventListener('click',async()=>{if(!managed)return show('manage-status','Choose a novel first.',true);const cover=$('manage-cover').files[0];if(!cover)return show('manage-status','Choose a cover file.',true);const fd=new FormData();fd.set('novel_id',String(managed.id));fd.set('image',cover);fd.set('source',$('manage-cover-credit').value||'Owner-supplied cover');fd.set('replace','1');const b=$('save-manage-cover');b.disabled=true;try{await call('/api/admin/additional/auto-cover',{method:'POST',body:fd});show('manage-status','Cover updated for novel #'+managed.id+'.')}catch(e){show('manage-status',e.message,true)}finally{b.disabled=false}});
const e=(s)=>{const n=document.createElement('span');n.textContent=s;return n};
async function loadPending(){show('review-status','Loading pending suggestions…');$('review-list').replaceChildren();try{const j=await call('/api/admin/additional/submissions');const items=j.items||[];show('review-status',items.length?`${items.length} pending submission(s).`:'No pending suggestions.');for(const it of items){const box=document.createElement('article');box.className='panel';const h=document.createElement('h2');h.textContent=it.title||'Untitled submission';box.append(h);const keys=[['Original title',it.originalTitle],['Author',it.author],['Original language',it.originalLanguage],['Translator',it.translator],['Translation',it.translation],['Synopsis',it.synopsis],['Genres',(it.genres||[]).join(', ')],['Tags',(it.tags||[]).join(', ')],['Warnings',(it.contentWarnings||[]).join(', ')],['Novel Updates',it.nuUrl],['Translator link',it.translatorUrl],['Original URL',it.originalUrl],['Source',it.sourceUrl],['Credit',it.coverCredit],['Submitted by',it.displayName],['Contact',it.contactEmail]];for(const [name,val] of keys){if(!val)continue;const p=document.createElement('p');const strong=document.createElement('strong');strong.textContent=name+': ';p.append(strong,e(String(val).slice(0,7000)));box.append(p)}if(it.hasCover){const img=document.createElement('img');img.src='/api/admin/additional/submission-cover?id='+encodeURIComponent(it.id);img.alt='Submitted cover preview';img.style.cssText='display:block;max-width:140px;max-height:210px;object-fit:contain;border-radius:8px;margin:12px 0';box.append(img)}const actions=document.createElement('div');actions.className='horizontal';for(const [val,label] of [['approve','Approve & publish'],['reject','Reject']]){const btn=document.createElement('button');btn.textContent=label;btn.addEventListener('click',async()=>{if(!window.confirm(`${label} “${it.title}”?`))return;btn.disabled=true;try{await post('/api/admin/additional/review',{submissionId:it.id,action:val});await loadPending()}catch(e){show('review-status',e.message,true);btn.disabled=false}});actions.append(btn)}box.append(actions);$('review-list').append(box)}}catch(e){show('review-status',e.message,true)}}
(async()=>{try{const me=await call('/api/me');role=me.role;if(role!=='owner'&&role!=='editor')throw Error('Editor access required.');if(role==='editor'){for(const t of ['bulk','epubs'])$('tab-'+t).hidden=true;}else{for(const t of ['single','bulk','epubs','manage','review'])$('tab-'+t).hidden=false;}await loadNovels();chooseTab('single');const direct=Number(new URLSearchParams(location.search).get('novel'));if(Number.isSafeInteger(direct)&&direct>=100000){const b=novels.find(n=>n.id===direct);if(b){$('manage-novel').value='#'+b.id+' · '+b.title;chooseTab('manage');$('load-manage').click();}}$('add-novels-main').hidden=false;$('permission-message').hidden=true;}catch(e){$('add-novels-main').hidden=true;$('permission-message').hidden=false;$('permission-message').textContent='This page requires an authorized Editor or Owner account. '+String(e.message||'Could not verify permissions.');$('permission-message').classList.add('error');for(const t of ['create','import-entries','upload-epubs','save-manage'])$(t).disabled=true}})();})();