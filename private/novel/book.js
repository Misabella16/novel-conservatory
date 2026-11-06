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
  const direct=candidates.map(node=>String(node.textContent||'').replace(/\\s+/g,' ').trim()).filter(Boolean);
  if(label==='translation')return direct.find(v=>/^(yes|no|completed|ongoing|fully translated|not fully translated)$/i.test(v))||'';
  return '';
 };
 const novel={nuUrl:url,title:first(['.seriestitlenu','#edit-title','.series-title']).slice(0,210),
  author:first(['#showauthors','#seriesauthors','.author-content']).slice(0,140),
  originalTitle:first(['#editassociated','#seriesothernames','#showassociated','#seriesassociated']).slice(0,210),
  synopsis:first(['#editdescription','#seriesdescription','.series-description','#showdescription','.seriesdescription']).slice(0,6000),
  genres:list(['#seriesgenre a','#showgenres a','.seriesgenre a']),
  tags:list(['#showtags a','#seriestags a','.seriestags a']),nuTranslationSourceStatus:sourceLabel('translation'),coverUrl};
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
async function applyNu(capture=null){
 if(!isEditor)return sourceStatus('Only authorized editors can apply this source.',true);
 const nuUrl=seriesUrl($('nu-series-url').value);
 if(!nuUrl)return sourceStatus('Paste the exact Novel Updates series page URL, not a search link.',true);
 const button=capture?$('nu-apply-capture'):$('nu-apply');
 button.disabled=true;
 sourceStatus('Checking source metadata for this novel…');
 try{
  if(capture){
   if(capture.source!=='novelupdates-browser-v1'||!capture.novel||
      seriesUrl(capture.novel.nuUrl)!==nuUrl)
    throw Error('The captured series must match the Novel Updates URL above.');
  }else{
   // Read previously staged official source first. If absent, attempt a
   // normal allowed fetch through the existing NU lookup endpoint.
   try{
    const staged=await fetch('/api/admin/nu/staged-by-url?url='+encodeURIComponent(nuUrl),
     {credentials:'same-origin',cache:'no-store'});
    if(!staged.ok){
     const lookup=await json('/api/admin/nu/lookup?url='+encodeURIComponent(nuUrl));
     capture=parseSourcePage(lookup.html,nuUrl);
    }
   }catch{
    // 403/429, origin blocks and unavailable pages are expected. Never
    // attempt any access-control bypass. The link alone can still be saved.
   }
  }
  const result=await postNU('/api/admin/nu/book-import',
   {id:activeNovelId,nuUrl,...(capture?{capture}:{})});
  lastNuImportId=result.eventId||null;
  $('nu-undo').hidden=!lastNuImportId;
  sourceStatus(result.needsCapture?
   'Novel Updates link saved privately. Full tags/genres and cover were not available automatically. Open the capture instructions below, then paste the source metadata.':
   'Applied to novel #'+activeNovelId+': '+(result.changed||[]).join(', ')+
   '. The existing editorial fields and private EPUBs were preserved.');
  $('nu-capture-help').open=!!result.needsCapture;
  await start();
 }catch(e){sourceStatus(e.message,true);$('nu-capture-help').open=true}
 finally{button.disabled=false}
}
$('nu-apply').addEventListener('click',()=>applyNu());
$('nu-apply-capture').addEventListener('click',()=>{
 try{
  const raw=$('nu-capture-json').value.trim();
  if(!raw||raw.length>15000)throw Error('Paste up to 15,000 characters of captured Novel Updates JSON.');
  const capture=JSON.parse(raw);applyNu(capture);
 }catch(e){sourceStatus(e.message,true)}
});
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
  $('nu-apply').disabled=!isEditor;$('nu-apply-capture').disabled=!isEditor;
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
  if(d.nuUrl&&!$('nu-series-url').value)$('nu-series-url').value=d.nuUrl;
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