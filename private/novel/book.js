/* One durable novel URL per canonical ID. All data comes from signed-in,
 * private Access-protected endpoints; private EPUB bytes are never embedded. */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
let activeNovelId=null,activeNovelUrl='',lastNuImportId=null,isEditor=false;
const norm=value=>String(value??'').normalize('NFKD').toLocaleLowerCase()
 .replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]/gu,'');
function seriesUrl(value){
 try{
  const u=new URL(String(value||'').trim());
  if(u.protocol!=='https:'||!['www.novelupdates.com','novelupdates.com'].includes(u.hostname)||
   u.username||u.password||u.port||u.search||u.hash)return '';
  const match=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/i.exec(u.pathname);
  return match?'https://www.novelupdates.com/series/'+match[1].toLowerCase()+'/':'';
 }catch{return ''}
}
const sourceStatus=(value,error=false)=>{
 $('nu-status').textContent=value;$('nu-status').style.color=error?'#a23329':'#285f4a';
};
function unionLabels(a,b){
 const out=Array.isArray(a)?[...a]:[];
 for(const label of Array.isArray(b)?b:[]){
  const v=String(label||'').trim();
  if(v&&!out.some(x=>norm(x)===norm(v)))out.push(v);
 }
 return out.slice(0,100);
}
function parseSourcePage(html,url){
 const doc=new DOMParser().parseFromString(String(html||''),'text/html');
 const first=selectors=>{
  for(const selector of selectors){
   const element=doc.querySelector(selector),v=String(element?.textContent||'').trim();
   if(v)return v.replace(/\s+/g,' ');
  }
  return '';
 };
 const list=selectors=>{
  const out=[];
  for(const selector of selectors)for(const node of doc.querySelectorAll(selector)){
   const v=String(node.textContent||'').replace(/\s+/g,' ').trim();
   if(v&&v.length<=90&&!out.includes(v))out.push(v);
  }
  return out.slice(0,100);
 };
 const cover=doc.querySelector('#seriesimg img,.seriesimg img,.series-image img');
 let coverUrl='';
 try{
  const raw=cover?.getAttribute('data-src')||cover?.getAttribute('src');
  if(raw)coverUrl=new URL(raw,url).href;
 }catch{}
 const sourceLabel=(label)=>{
  const candidates=Array.from(doc.querySelectorAll('#showtranslated,#showstatus,#showchapters,.seriesstat,.seriesstatus'));
  const direct=candidates.map(node=>String(node.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean);
  if(label==='translation')return direct.find(v=>/^(yes|no|completed|ongoing|fully translated|not fully translated)$/i.test(v))||'';
  if(label==='chapters')return direct.find(v=>/\d/.test(v)&&v.length<=100)||'';
  return '';
 };
 const novel={nuUrl:url,title:first(['.seriestitlenu','#edit-title','.series-title']).slice(0,210),
  author:first(['#showauthors','#seriesauthors','.author-content']).slice(0,140),
  originalTitle:first(['#editassociated','#seriesothernames','#showassociated','#seriesassociated']).slice(0,210),
  synopsis:first(['#editdescription','#seriesdescription','.series-description','#showdescription','.seriesdescription']).slice(0,6000),
  genres:list(['#seriesgenre a','#showgenres a','.seriesgenre a']),
  tags:list(['#showtags a','#seriestags a','.seriestags a']),nuTranslationSourceStatus:sourceLabel('translation'),nuChapterSourceText:sourceLabel('chapters'),coverUrl};
 return novel.title&&(novel.synopsis||novel.tags.length||novel.genres.length)?
  {source:'novelupdates-browser-v1',novel}:null;
}
async function postNU(path,body){
 const r=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const result=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(result.error||'Could not apply metadata');
 return result;
}
let preparedNu=null,currentIdentity={title:'',author:''};
const chosenFields=()=>Array.from(document.querySelectorAll('input[name="nu-fields"]:checked')).map(input=>input.value);
const setBusy=busy=>{
 for(const id of ['nu-preview','nu-preview-copied','nu-apply-capture','nu-apply'])
  $(id).disabled=busy||id==='nu-apply'&&!preparedNu;
};
function resetPreview(){
 preparedNu=null;
 $('nu-preview-box').hidden=true;
 $('nu-preview-list').replaceChildren();
 $('nu-apply').disabled=true;
}
function brief(value){
 const s=Array.isArray(value)?value.join(', '):String(value??'');
 return s.length>260?s.slice(0,260)+'…':s;
}
function showManualOptions(){
 // Keep both capture methods available. Highlight the most convenient one.
 const small=typeof window.matchMedia==='function'&&window.matchMedia('(max-width: 700px)').matches;
 $('nu-capture-help').open=small;
 $('nu-advanced-capture').open=!small;
}
async function previewNu(capture=null,origin=''){
 if(!isEditor)return sourceStatus('Only authorized editors can apply source updates.',true);
 const nuUrl=seriesUrl($('nu-series-url').value);
 if(!nuUrl)return sourceStatus('Paste the exact Novel Updates series URL.',true);
 const fields=chosenFields();
 if(!fields.length)return sourceStatus('Select at least one detail to update.',true);
 resetPreview();setBusy(true);
 sourceStatus('Looking for source information for this novel…');
 try{
  if(capture&&
    (capture.source!=='novelupdates-browser-v1'||!capture.novel||
     seriesUrl(capture.novel.nuUrl)!==nuUrl))
   throw Error('The copied source must match this novel’s exact NU link.');
  if(!capture){
   const result=await window.ConservatoryNUSource.discover(nuUrl);
   if(result.mode==='blocked'){
    sourceStatus('Novel Updates did not return usable information automatically. Choose the phone copy-and-paste option or the original computer bookmarklet below.');
    showManualOptions();
    return;
   }
   capture=result.capture;
   origin=result.mode==='staged'?'Previously captured Novel Updates metadata':'Novel Updates series page';
  }
  const request={id:activeNovelId,nuUrl,fields,preview:true};
  if(capture)request.capture=capture;
  const result=await postNU('/api/admin/nu/book-import',request);
  if(result.needsCapture){
   sourceStatus('No source details were available for this link. Use either the phone copy-and-paste method or the original computer bookmarklet below.');
   showManualOptions();
   return;
  }
  const list=$('nu-preview-list');
  list.replaceChildren();
  const values=result.fields||{};
  for(const [name,value] of Object.entries(values)){
   if(name==='nuUrl')continue;
   const item=document.createElement('li');
   const strong=document.createElement('strong');strong.textContent=name.replace(/^nu/,'NU ')+': ';
   const span=document.createElement('span');span.textContent=brief(value);
   item.append(strong,span);list.append(item);
  }
  if(!list.children.length){
   sourceStatus('No missing fields to add for your selection. Existing information is preserved.');
   return;
  }
  $('nu-preview-heading').textContent='Step 3 · Review ' + list.children.length + ' proposed field updates';
  $('nu-preview-origin').textContent='Source: '+(origin||'Novel Updates')+'. Nothing has been changed yet.';
  preparedNu={nuUrl,fields,capture};
  $('nu-preview-box').hidden=false;
  $('nu-apply').disabled=false;
  sourceStatus('Review the proposed updates below, then apply them when ready.');
 }catch(e){
  sourceStatus(e.message||'Could not preview Novel Updates data.',true);
  showManualOptions();
 }finally{setBusy(false)}
}
async function applyNu(){
 if(!isEditor||!preparedNu)return sourceStatus('Preview the source updates before applying.',true);
 const payload={id:activeNovelId,nuUrl:preparedNu.nuUrl,fields:preparedNu.fields};
 if(preparedNu.capture)payload.capture=preparedNu.capture;
 setBusy(true);sourceStatus('Saving selected information…');
 try{
  const result=await postNU('/api/admin/nu/book-import',payload);
  lastNuImportId=result.eventId||null;
  $('nu-undo').hidden=!lastNuImportId;
  resetPreview();
  sourceStatus(result.needsCapture?'No new source details were found. Use either the phone method or the original computer bookmarklet below.':
   'Updated this novel: '+(result.changed||[]).join(', ')+'. Your curated fields and EPUBs were preserved.');
  await start();
 }catch(e){sourceStatus(e.message,true)}
 finally{setBusy(false)}
}
$('nu-preview').addEventListener('click',()=>previewNu());
$('nu-apply').addEventListener('click',()=>applyNu());
let mobileCopiedCapture=null;
const reviewedLines=id=>Array.from(new Set($(id).value.split(/\r?\n/).map(s=>s.trim())
 .filter(s=>s&&s.length<=70))).slice(0,100);
$('nu-preview-copied').addEventListener('click',()=>{
 try{
  const nuUrl=seriesUrl($('nu-series-url').value);
  const sourceText=$('nu-copied-text').value.trim();
  const mode=$('nu-paste-mode').value;
  const capture=window.ConservatoryNUSource.parseCopiedText(sourceText,nuUrl,currentIdentity,{mode});
  mobileCopiedCapture=capture;
  $('nu-segment-tags').value=(capture.novel.tags||[]).join('\n');
  $('nu-segment-genres').value=(capture.novel.genres||[]).join('\n');
  const warnings=[...(capture.review?.unresolvedTags||[]),...(capture.review?.unresolvedGenres||[])];
  $('nu-segment-uncertain').hidden=!warnings.length;
  $('nu-segment-leftovers').textContent=warnings.join('\n');
  const tags=capture.novel.tags.length,genres=capture.novel.genres.length;
  $('nu-segment-message').textContent=tags+' tag'+(tags===1?'':'s')+' and '+genres+
   ' genre'+(genres===1?'':'s')+' separated.'+
   (warnings.length?' Review '+warnings.length+' unrecognized fragment'+(warnings.length===1?'':'s')+
   ' below, and add missing complete names one per line.':' Check the full list before saving.');
  $('nu-segment-review').hidden=false;
  sourceStatus('Separated known NU names. Review the editable list, then continue to the change preview.');
 }catch(e){mobileCopiedCapture=null;$('nu-segment-review').hidden=true;sourceStatus(e.message,true)}
});
$('nu-segment-continue').addEventListener('click',()=>{
 try{
  if(!mobileCopiedCapture)throw Error('First separate the copied Novel Updates text.');
  const tags=reviewedLines('nu-segment-tags'),genres=reviewedLines('nu-segment-genres');
  mobileCopiedCapture.novel.tags=tags;
  mobileCopiedCapture.novel.genres=genres;
  const n=mobileCopiedCapture.novel;
  if(!tags.length&&!genres.length&&!n.synopsis&&!n.nuChapterSourceText&&
     !n.nuTranslationSourceStatus&&!n.nuOriginalSourceStatus)
   throw Error('Add at least one complete tag or genre, one per line, before continuing.');
  previewNu(mobileCopiedCapture,'NU text copied and reviewed on mobile');
 }catch(e){sourceStatus(e.message,true)}
});
$('nu-copied-text').addEventListener('input',()=>{
 mobileCopiedCapture=null;$('nu-segment-review').hidden=true;resetPreview();
});
$('nu-paste-mode').addEventListener('change',()=>{
 mobileCopiedCapture=null;$('nu-segment-review').hidden=true;resetPreview();
});
$('nu-apply-capture').addEventListener('click',()=>{
 try{
  const raw=$('nu-capture-json').value.trim();
  if(!raw||raw.length>15000)throw Error('Paste up to 15,000 characters of captured Novel Updates JSON.');
  const capture=JSON.parse(raw);
  previewNu(capture,'Existing Novel Updates browser capture');
 }catch(e){sourceStatus(e.message,true)}
});
$('nu-series-url').addEventListener('input',resetPreview);
document.querySelectorAll('input[name="nu-fields"]').forEach(input=>
 input.addEventListener('change',resetPreview));
$('nu-undo').addEventListener('click',async()=>{
 if(!lastNuImportId)return;
 const button=$('nu-undo');button.disabled=true;
 try{
  await postNU('/api/admin/nu/book-undo',{eventId:lastNuImportId});
  lastNuImportId=null;button.hidden=true;
  sourceStatus('The last private NU import was undone.');
  await start();
 }catch(e){sourceStatus(e.message,true)}
 finally{button.disabled=false}
});

const fail=(msg)=>{$('alert').textContent=msg;$('alert').classList.remove('hidden')};
const json=async url=>{
 const response=await fetch(url,{credentials:'same-origin',cache:'no-store'});
 const value=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(value.error||'Request failed ('+response.status+')');
 return value;
};
const cleanUrl=(value)=>{
 try{
  const raw=String(value||'').trim();
  const safeRelative=/^covers\/[0-9]+\.(?:png|jpe?g|webp)$/i.test(raw)?'/'+raw:raw;
  const u=new URL(safeRelative,location.origin);
  if(u.protocol==='https:'||u.origin===location.origin&&u.pathname.startsWith('/')){
   if(u.username||u.password)return '';
   return u.href;
  }
 }catch{}
 return '';
};
function link(parent,label,url,primary=false){
 const href=cleanUrl(url);if(!href)return;
 const a=document.createElement('a');a.className='btn'+(primary?' primary':'');
 a.href=href;a.textContent=label;
 if(new URL(href).origin!==location.origin){a.target='_blank';a.rel='noopener noreferrer nofollow'}
 parent.append(a);
}
function chips(target,values){
 target.replaceChildren();
 const arr=Array.isArray(values)?values.filter(x=>typeof x==='string'&&x.trim()).slice(0,60):[];
 if(!arr.length){target.textContent='Not yet catalogued';target.className='muted';return}
 target.className='';
 for(const name of arr){
  const chip=document.createElement('span');chip.className='chip';chip.textContent=name;
  target.append(chip);
 }
}
function parseId(){
 const m=/^\/novel\/([1-9]\d{0,10})\/?$/.exec(location.pathname);
 const value=m?.[1]||new URLSearchParams(location.search).get('id');
 const n=Number(value);
 return Number.isSafeInteger(n)&&n>0?n:null;
}
async function start(){
 const requested=parseId();
 if(!requested)return fail('This novel link is missing a valid catalogue ID.');
 try{
  const identity=await json('/api/novel/resolve?id='+encodeURIComponent(requested));
  const id=Number(identity.canonicalId);
  if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid canonical novel ID.');
  const [cat,content,me]=await Promise.all([json('/api/catalogue'),json('/api/content'),json('/api/me')]);
  activeNovelId=id;isEditor=['owner','editor'].includes(me.role);
  $('nu-preview').disabled=!isEditor;
  $('nu-preview-copied').disabled=!isEditor;
  $('nu-apply-capture').disabled=!isEditor;
  $('nu-apply').disabled=!isEditor||!preparedNu;
  if(!isEditor)sourceStatus('Editors can apply missing metadata. Share the NU series URL with a library editor to help fill this record.');
  const list=Array.isArray(cat)?cat:cat.books||[];
  const base=list.find(x=>Number(x.id)===id);
  if(!base)throw Error('This novel is not currently visible in the private catalogue.');
  const patch=(content.edits||[]).find(x=>Number(x.id)===id)?.patch||{};
  const additional=(content.additional||[]).find(x=>Number(x.id)===id)||{};
  const d={...base,...additional,...patch};
  if(patch.tagsCombinedFromNu||patch.tagsCombinedFromEpub||['nu','epub'].includes(patch.metadataOrigin))
   d.tags=unionLabels(base.tags,patch.tags);
  if(patch.genresCombinedFromNu||patch.genresCombinedFromEpub||['nu','epub'].includes(patch.metadataOrigin))
   d.genres=unionLabels(base.genres,patch.genres);
  document.title=(d.title||'Novel')+' · Novel Conservatory';
  $('title').textContent=d.title||'Untitled novel';
  currentIdentity={title:d.title||'',author:d.author||''};
  $('catalogue-id').textContent='Novel Conservatory · catalogue #'+id;
  $('original').textContent=d.originalTitle||'';
  $('author').textContent=d.author?'By '+d.author:'Author not yet listed';
  $('synopsis').textContent=d.synopsis||'This novel does not have a synopsis yet. EPUB and Novel Updates metadata can fill missing information.';
  $('source-info').textContent=d.metadataSource?'Metadata source: '+d.metadataSource:'';
  chips($('genres'),d.genres);chips($('tags'),d.tags);
  $('nu-source-progress').textContent=[d.nuTranslationSourceStatus?'NU translation completion report: '+d.nuTranslationSourceStatus:'',d.nuChapterSourceText?'NU chapter information: '+d.nuChapterSourceText:''].filter(Boolean).join(' · ')||'Novel Updates chapter count and translation completion are not yet verified for this entry.';
  // Preserve original book-cover paths from the root catalogue. Relative
  // "covers/123.png" must not resolve underneath /novel/123.
  // Only display source artwork when rights or private EPUB scope are known.
  const coverPath=String(d.cover||'');
  const allowedCover=!!(d.coverRights||d.privateCover);
  const src=allowedCover?cleanUrl(/^covers\/[0-9]+\.(?:png|jpe?g|webp)$/i.test(coverPath)?
   '/'+coverPath:coverPath):'';
  if(src){
   $('cover').referrerPolicy='no-referrer';
   $('cover').src=src;$('cover').alt='Cover of '+d.title;
   $('cover').classList.remove('hidden');$('placeholder').classList.add('hidden');
   $('cover').onerror=()=>{
    $('cover').classList.add('hidden');$('placeholder').classList.remove('hidden');
   };
  }else{$('placeholder').textContent=d.title||'📚'}
  const actions=$('links');actions.replaceChildren();
  link(actions,'Novel Updates',d.nuUrl);
  link(actions,'Translator website',d.translatorUrl);
  link(actions,'Open in my catalogue','/#browse');
  if(isEditor)link(actions,'✎ Edit this novel',id>=100000?
   '/admin/add-novels.html?novel='+id:'/admin/?book='+id);
  // Most novels already have a source link; never make readers re-enter it.
  if(d.nuUrl)$('nu-series-url').value=d.nuUrl;
  const existing=seriesUrl(d.nuUrl);
  $('nu-link-state').textContent=existing?
   '✓ Linked NU page found. Tap “Pull linked NU information” to check the fields above.':
   'No NU series link saved yet. Paste its source page link once below.';
  $('nu-open-source').href=existing||'https://www.novelupdates.com/';
  $('nu-open-source').textContent=existing?'Open linked NU page ↗':'Find this novel on Novel Updates ↗';
  const coverSource=$('nu-cover-link');coverSource.replaceChildren();
  if(d.nuCoverUrl){
   const label=document.createElement('span');label.textContent='NU cover source: ';
   coverSource.append(label);
   link(coverSource,'View source image',d.nuCoverUrl);
  }
  const editionList=$('editions');
  try{
   const data=await json('/api/private/edition/list?id='+encodeURIComponent(id));
   const editions=Array.isArray(data.editions)?data.editions:[];
   if(!editions.length)editionList.textContent='No private EPUB editions attached yet.';
   for(const edition of editions){
    const line=document.createElement('div');line.className='edition';
    const title=document.createElement('strong');title.textContent=edition.label||edition.filename||'EPUB edition';
    line.append(title);
    const meta=document.createElement('div');meta.className='muted tiny';
    meta.textContent=[edition.translator,edition.filename].filter(Boolean).join(' · ');
    line.append(meta);
    link(line,'Read EPUB','/read/?id='+id+'&edition='+encodeURIComponent(edition.id),true);
    editionList.append(line);
   }
  }catch(e){
   editionList.textContent='EPUB editions are private and require reading access. '+e.message;
  }
  $('alert').classList.add('hidden');$('detail').classList.remove('hidden');
  if(requested!==id)history.replaceState(null,'','/novel/'+id);
 }catch(e){fail(e.message)}
}
start();
})();