(()=>{'use strict';
const $=id=>document.getElementById(id),api=async(url,options)=>{const r=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Request failed');return j};
let records=[],offset=0,total=0,selected=null,source='not scanned',epubInspected=false,fieldSources={},coverBlob=null,coverPreviewUrl='',scanBusy=false,scanStop=false;
const applyMissing=(id,value,origin)=>{
 const data=Array.isArray(value)?value.join(', '):String(value||'').trim();
 if(!data||$(id).value.trim())return false;
 $(id).value=(id==='synopsis'?data.slice(0,2000):data);
 fieldSources[id]=origin;return true;
};
const ensureEpubFirst=()=>{
 if(!selected){setStatus('Choose an existing novel first.',true);return false}
 if(selected.editionId!=='none'&&!epubInspected){
  setStatus('This novel has a linked EPUB. Click Inspect first; Novel Updates only fills fields missing from the EPUB.',true);
  return false;
 }
 return true;
};
const mergeNovelUpdates=(novel,origin)=>{
 if(!ensureEpubFirst())return;
 const filled=[];
 for(const [id,val] of [['title',novel.title],['synopsis',novel.synopsis],['tags',novel.tags],['genres',novel.genres]]){
  if(applyMissing(id,val,origin))filled.push(id);
 }
 source=[...new Set(Object.values(fieldSources))].join(' + ')||origin;
 $('origin').textContent='Field sources: '+Object.entries(fieldSources).map(([k,v])=>k+' ← '+v).join('; ');
 $('apply').disabled=true;
 setStatus(filled.length?'Filled missing fields from '+origin+': '+filled.join(', ')+'. Existing EPUB/manual entries were preserved.':'No blank fields to fill. Existing EPUB/manual entries were preserved.');
 return filled;
};
const setStatus=(msg,err=false)=>{const el=$('status');el.textContent=msg;el.classList.toggle('error',err)};
const unique=s=>[...new Set(String(s||'').split(',').map(x=>x.trim()).filter(Boolean))].slice(0,30);
const short=v=>String(v||'').trim().slice(0,2000);
const byName=(doc,name)=>[...doc.getElementsByTagName('*')].filter(x=>x.localName===name);
const meta=(doc,name)=>byName(doc,name)[0]?.textContent?.trim()||'';
function pathOf(opf,href){
 if(!href||href.startsWith('/')||/^[a-z]+:/i.test(href))return null;
 try{const base='https://epub.invalid/'+opf;const u=new URL(href.split('#')[0],base);const p=decodeURI(u.pathname).slice(1);return p.includes('..')?null:p}catch{return null}
}
async function inspectBook(blob){
 if(typeof JSZip==='undefined')throw Error('The EPUB reader is unavailable.');
 if(blob.size>120*1048576)throw Error('This edition is over the 120 MiB browser analysis limit.');
 const zip=await JSZip.loadAsync(blob);
 const container=zip.file('META-INF/container.xml');if(!container)throw Error('Missing EPUB container metadata');
 const parser=new DOMParser(),xml=parser.parseFromString(await container.async('text'),'application/xml');
 const root=byName(xml,'rootfile')[0]?.getAttribute('full-path');
 if(!root||root.startsWith('/')||root.includes('..')||!zip.file(root))throw Error('Invalid EPUB package path');
 const packageDoc=parser.parseFromString(await zip.file(root).async('text'),'application/xml');
 const data={title:meta(packageDoc,'title'),author:meta(packageDoc,'creator'),synopsis:meta(packageDoc,'description'),
  tags:[...new Set(byName(packageDoc,'subject').map(x=>x.textContent.trim()).filter(Boolean))].slice(0,30)};
 return data;
}

function resetCoverPreview(){
 if(coverPreviewUrl){URL.revokeObjectURL(coverPreviewUrl);coverPreviewUrl=''}
 coverBlob=null;
 $('embedded-cover-panel').hidden=true;
 $('embedded-cover-preview').hidden=true;
 $('embedded-cover-preview').removeAttribute('src');
 $('embedded-cover-rights').checked=false;
 $('embedded-cover-save').disabled=true;
 $('embedded-cover-replace').disabled=true;
}
async function inspectCover(file){
 resetCoverPreview();
 const panel=$('embedded-cover-panel');panel.hidden=false;
 $('embedded-cover-status').textContent='Looking for the image declared in the EPUB package…';
 if(!window.CoverExtractor){$('embedded-cover-status').textContent='EPUB cover reader unavailable.';return}
 try{
  const result=await CoverExtractor.detectCover(file);
  if(!result.image){
   $('embedded-cover-status').textContent=result.reason||'No embedded cover found. The decorative jacket will remain.';
   return;
  }
  coverBlob=result.image;
  coverPreviewUrl=URL.createObjectURL(coverBlob);
  $('embedded-cover-preview').src=coverPreviewUrl;
  $('embedded-cover-preview').hidden=false;
  $('embedded-cover-status').textContent='Found the cover embedded at '+(result.path||'the EPUB package')+'. Review before displaying it.';
  updateCoverActions();
 }catch(error){$('embedded-cover-status').textContent='Could not inspect embedded cover: '+error.message}
}
function updateCoverActions(){
 const allowed=!!selected&&!!coverBlob&&$('embedded-cover-rights').checked;
 $('embedded-cover-save').disabled=!allowed;
 $('embedded-cover-replace').disabled=!allowed;
}
$('embedded-cover-rights').addEventListener('change',updateCoverActions);
async function savePrivateCover(replace){
 if(!coverBlob||!selected||!$('embedded-cover-rights').checked)return;
 if(!confirm((replace?'Replace the current private cover':'Use the embedded image as the private cover')+
  ' for novel #'+selected.novelId+'? This requires display permission and will not publish on the public site.'))return;
 const buttons=[$('embedded-cover-save'),$('embedded-cover-replace')];
 for(const button of buttons)button.disabled=true;
 try{
  const fd=new FormData();
  fd.set('novelId',String(selected.novelId));fd.set('editionId',selected.editionId);
  fd.set('replace',String(!!replace));
  fd.set('rightsConfirmed','true');fd.set('confirm','true');
  fd.set('image',new File([coverBlob],'private-epub-cover.jpg',{type:'image/jpeg'}));
  const response=await api('/api/admin/epub-insights/private-cover',{method:'POST',body:fd});
  $('embedded-cover-status').textContent='Cover saved for private novel #'+response.novelId+'. It will show in the private catalogue after refreshing. Nothing was published publicly.';
 }catch(error){$('embedded-cover-status').textContent='Cover was not saved: '+error.message}
 finally{updateCoverActions()}
}
$('embedded-cover-save').addEventListener('click',()=>savePrivateCover(false));
$('embedded-cover-replace').addEventListener('click',()=>savePrivateCover(true));
async function storedEpubFile(item){
 if(item.editionId==='none')throw Error('No stored EPUB exists.');
 const path=item.editionId==='legacy'?'/api/private/epub/file?id='+item.novelId:
  '/api/private/edition/file?id='+item.novelId+'&edition='+encodeURIComponent(item.editionId);
 const r=await fetch(path,{credentials:'same-origin',cache:'no-store'});
 if(!r.ok)throw Error('Private EPUB read failed ('+r.status+').');
 return r.blob();
}
const scannedCoverUrls=[];
function clearScannedCovers(){
 for(const url of scannedCoverUrls)URL.revokeObjectURL(url);
 scannedCoverUrls.length=0;
 $('scan-cover-gallery').replaceChildren();
}
async function persistPrivateCover(item,blob,replace){
 const fd=new FormData();
 fd.set('novelId',String(item.novelId));fd.set('editionId',item.editionId);
 fd.set('replace',String(!!replace));
 fd.set('rightsConfirmed','true');fd.set('confirm','true');
 fd.set('image',new File([blob],'private-epub-cover.jpg',{type:'image/jpeg'}));
 return api('/api/admin/epub-insights/private-cover',{method:'POST',body:fd});
}
function displayScannedCover(item,blob){
 const host=$('scan-cover-gallery'),card=document.createElement('article');
 card.className='scan-cover-card';
 const title=document.createElement('strong');title.textContent='#'+item.novelId+' · '+item.filename;card.append(title);
 const img=document.createElement('img'),url=URL.createObjectURL(blob);
 scannedCoverUrls.push(url);img.src=url;img.alt='Embedded image preview for novel #'+item.novelId;card.append(img);
 const label=document.createElement('label'),check=document.createElement('input');
 check.type='checkbox';const words=document.createElement('span');
 words.textContent='I have permission to show this image to private members.';
 label.append(check,words);card.append(label);
 const save=document.createElement('button'),replace=document.createElement('button'),note=document.createElement('p');
 save.type='button';replace.type='button';
 save.textContent='Use as private cover';replace.textContent='Replace private cover';
 save.disabled=true;replace.disabled=true;
 check.addEventListener('change',()=>{save.disabled=!check.checked;replace.disabled=!check.checked});
 const submit=async force=>{
  if(!check.checked)return;
  if(!confirm((force?'Replace existing private cover':'Use cover privately')+
   ' for novel #'+item.novelId+'? This will not publish the image on the public site.'))return;
  save.disabled=true;replace.disabled=true;
  try{
   const result=await persistPrivateCover(item,blob,force);
   note.textContent=result.publicPublished?'Unexpected public status. Contact site owner.':'✓ Cover saved privately. Refresh the private catalogue.';
  }catch(e){note.textContent=e.message}
  finally{save.disabled=!check.checked;replace.disabled=!check.checked}
 };
 save.addEventListener('click',()=>submit(false));replace.addEventListener('click',()=>submit(true));
 note.textContent='Review image and rights before making it visible.';
 card.append(save,replace,note);host.append(card);
}

const scanResult=msg=>{$('scan-existing-result').textContent=msg};
$('stop-scan').addEventListener('click',()=>{scanStop=true;scanResult('Stopping after the current EPUB…')});
$('scan-existing').addEventListener('click',async()=>{
 if(scanBusy)return;
 if(!confirm('Inspect up to 8 already-stored EPUBs from the current results and save unapproved metadata review drafts? No public or private catalogue fields will be changed.'))return;
 scanBusy=true;scanStop=false;clearScannedCovers();
 $('scan-existing').disabled=true;$('stop-scan').disabled=false;
 const batch=records.filter(x=>x.editionId!=='none').slice(0,8);
 const examined=new Set(),stats={scanned:0,saved:0,skipped:0,errors:[]};
 try{
  for(let i=0;i<batch.length;i++){
   if(scanStop)break;
   const item=batch[i];const label='#'+item.novelId+' · '+item.filename;
   scanResult('Inspecting '+(i+1)+'/'+batch.length+': '+label+
    '\nReview drafts saved: '+stats.saved+' · Skipped: '+stats.skipped);
   if(examined.has(item.novelId)||item.size>15*1048576||item.size<100){
    stats.skipped++;continue
   }
   examined.add(item.novelId);
   try{
    const existing=await api('/api/admin/epub-insights/draft?id='+item.novelId);
    if(existing.draft){stats.skipped++;continue}
    const file=await storedEpubFile(item),d=await inspectBook(file);
    stats.scanned++;
    if(window.CoverExtractor){
     try{const cover=await CoverExtractor.detectCover(file);
      if(cover.image)displayScannedCover(item,cover.image);
     }catch(e){if(stats.errors.length<8)stats.errors.push(label+' (cover): '+e.message)}
    }
    const synopsis=String(d.synopsis||'').slice(0,2000),tags=d.tags||[];
    if(!synopsis&&!tags.length){stats.skipped++;continue}
    await api('/api/admin/epub-insights/draft',{
     method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({
      novelId:item.novelId,editionId:item.editionId,action:'draft',
      title:String(d.title||'').slice(0,210),synopsis,tags,genres:[],warnings:[],
      source:'EPUB package metadata',fieldSources:{
       ...(d.title?{title:'EPUB'}:{}),
       ...(synopsis?{synopsis:'EPUB'}:{}),
       ...(tags.length?{tags:'EPUB'}:{})
      }
     })
    });
    stats.saved++;
   }catch(error){
    if(stats.errors.length<8)stats.errors.push(label+': '+error.message)
   }
   await new Promise(resolve=>setTimeout(resolve,0));
  }
 }finally{
  scanBusy=false;$('scan-existing').disabled=false;$('stop-scan').disabled=true;
  scanResult('Done: '+stats.scanned+' EPUBs inspected; '+stats.saved+' unapproved review drafts saved; '+
   stats.skipped+' skipped. '+(stats.errors.length?'Issues:\n'+stats.errors.join('\n'):'No upload or public changes were made.')+
   '\nCovers found during this scan are previewed below for individual permission checks. Select a title to review its draft, approve it and apply metadata privately.');
 }
});

async function load(){
 try{
  const p=new URLSearchParams({q:$('search').value,offset:String(offset),limit:'30'});
  const v=await api('/api/admin/epub-insights/editions?'+p);
  records=v.items;total=v.total;
  $('range').textContent=total?(offset+1)+'–'+(offset+records.length)+' of '+total:'No stored EPUBs found';
  $('previous').disabled=offset===0;$('next').disabled=offset+records.length>=total;
  $('library-list').replaceChildren();
  for(const item of records){
   const b=document.createElement('button');b.className='item'+(selected?.novelId===item.novelId&&selected?.editionId===item.editionId?' active':'');
   const title=document.createElement('span'),small=document.createElement('small');title.textContent=item.filename;
   small.textContent='#'+item.novelId+' • '+(item.legacy?'Legacy EPUB':'Stored edition')+' • '+(item.size/1048576).toFixed(1)+' MiB';
   b.append(title,small);b.addEventListener('click',()=>choose(item));$('library-list').append(b);
  }
 }catch(e){setStatus(e.message,true)}
}
async function choose(item){
 resetCoverPreview();
 selected=item;source='not scanned';epubInspected=false;fieldSources={};
 $('selected-title').textContent=item.filename;$('selected-detail').textContent='Novel #'+item.novelId+' • '+(item.editionId==='none'?'No linked EPUB':'Private stored EPUB');
 $('inspect').disabled=item.editionId==='none';
 $('editor').hidden=false;$('title').value='';$('synopsis').value='';$('tags').value='';$('genres').value='';$('warnings').value='';
 $('rights').checked=false;$('nu-url').value='';$('apply').disabled=true;$('nu-source-paste').value='';$('nu-source-result').textContent='';
 $('origin').textContent='No EPUB text inspected yet.';
 await load();
 try{
  const v=await api('/api/admin/epub-insights/draft?id='+item.novelId);
  if(v.draft?.editionId===item.editionId){
   const d=v.draft;
   fieldSources=d.fieldSources&&typeof d.fieldSources==='object'?{...d.fieldSources}:{};
   $('title').value=d.title||'';$('synopsis').value=d.synopsis||'';
   $('tags').value=(d.tags||[]).join(', ');$('genres').value=(d.genres||[]).join(', ');
   $('warnings').value=(d.warnings||[]).join(', ');
   source=d.source||'saved review';
   $('origin').textContent=d.approved?'Previously approved draft for this edition':'Previously saved draft, not yet approved';
   $('apply').disabled=!d.approved;
  }
  setStatus(item.editionId==='none'?'No linked EPUB. Use captured Novel Updates metadata to fill missing fields.':'Inspect the linked EPUB first. Novel Updates can fill any fields it lacks.');
  // Most EPUBs are small. Inspect these immediately after selection so the
  // primary source is populated before editors use the Novel Updates fallback.
  // Large files still require an explicit click to avoid surprise downloads.
  if(item.editionId!=='none'&&Number(item.size)>0&&Number(item.size)<=15*1048576)
    $('inspect').click();
 }catch(e){setStatus(e.message,true)}
}
$('choose-without-epub').addEventListener('click',async()=>{
 const id=Number($('without-epub-id').value);
 if(!Number.isSafeInteger(id)||id<1)return setStatus('Enter a valid existing novel ID.',true);
 const btn=$('choose-without-epub');btn.disabled=true;
 try{
  const v=await api('/api/admin/epub-insights/has-epub?id='+id);
  if(v.hasEpub){
   setStatus('Novel #'+id+' has a linked EPUB. Choose it from Stored EPUBs and inspect it first. No Novel Updates overwrite was performed.',true);
   $('search').value=String(id);offset=0;await load();return;
  }
  await choose({novelId:id,editionId:'none',filename:'Novel #'+id+' (no EPUB)',size:0,legacy:false});
 }catch(e){setStatus(e.message,true)}finally{btn.disabled=false}
});
$('inspect').addEventListener('click',async()=>{
 if(!selected)return;
 const button=$('inspect');button.disabled=true;setStatus('Inspecting EPUB privately in your browser…');
 try{
  const base=selected.editionId==='legacy'?'/api/private/epub/file?id='+selected.novelId:
    '/api/private/edition/file?id='+selected.novelId+'&edition='+encodeURIComponent(selected.editionId);
  const r=await fetch(base,{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw Error('Unable to read stored EPUB ('+r.status+').');
  const file=await r.blob(),data=await inspectBook(file);
  epubInspected=true;
  await inspectCover(file);

  applyMissing('title',data.title,'EPUB');
  applyMissing('synopsis',data.synopsis,'EPUB');
  applyMissing('tags',data.tags,'EPUB');
  source='EPUB package metadata';
  $('origin').textContent='Embedded title: '+(data.title||'not found')+' • Author: '+(data.author||'not found')+
   ' • Existing description: '+(data.synopsis?'present':'missing')+' • Subject tags: '+data.tags.length;
  setStatus('Retrieved embedded EPUB metadata. Fields missing from the file are left blank.');
 }catch(e){setStatus(e.message,true)}
 finally{button.disabled=false}
});

function textFrom(root,selectors){
 for(const q of selectors){const n=root.querySelector(q);if(n){const text=n.textContent.replace(/\s+/g,' ').trim();if(text)return text}}
 return '';
}
function fromNuHtml(html){
 const doc=new DOMParser().parseFromString(html,'text/html');
 for(const x of doc.querySelectorAll('script,style,noscript,iframe'))x.remove();
 const title=textFrom(doc,['.seriestitlenu','#edit-title','.series-title']);
 const author=textFrom(doc,['#showauthors','.author-content','#seriesauthors']);
 const synopsis=textFrom(doc,['#editdescription','#seriesdescription','.series-description','#showdescription','.seriesdescription']);
 const terms=(selectors)=>{const out=[];for(const q of selectors)for(const n of doc.querySelectorAll(q)){
  const t=n.textContent.replace(/\s+/g,' ').trim();
  if(t&&t.length<=100&&!out.includes(t))out.push(t);
 }return out.slice(0,40)};
 const genres=terms(['#seriesgenre a','#showgenres a','.seriesgenre a']);
 const tags=terms(['#showtags a','#seriestags a','.seriestags a']);
 return {title,author,synopsis,genres,tags};
}
$('lookup-nu').addEventListener('click',async()=>{
 const address=$('nu-url').value.trim();
 if(!ensureEpubFirst())return;
 if(!/^https:\/\/www\.novelupdates\.com\/series\/[a-z0-9-]+\/?$/i.test(address))
  return setStatus('Enter the canonical Novel Updates URL (https://www.novelupdates.com/series/...).',true);
 const button=$('lookup-nu');button.disabled=true;$('nu-status').textContent='Retrieving existing Novel Updates metadata…';
 try{
  const res=await api('/api/admin/nu/lookup?url='+encodeURIComponent(address));
  const parsed=fromNuHtml(res.html);
  if(!parsed.title||(!parsed.synopsis&&!parsed.tags.length&&!parsed.genres.length))
   throw Error('No confirmed Novel Updates title and metadata found. The page may be blocked or its layout may have changed.');
  mergeNovelUpdates(parsed,'Novel Updates');
  $('origin').textContent='Source: '+address+' • Retrieved title: '+(parsed.title||'missing')+
   ' • Genres: '+parsed.genres.length+' • Tags: '+parsed.tags.length;
  $('nu-status').textContent='Retrieved from Novel Updates. Missing fields were left unchanged. Verify the title matches the selected EPUB.';
  setStatus('Existing source metadata retrieved. Review before approving privately.');
 }catch(err){$('nu-status').textContent=err.message;setStatus(err.message,true)}
 finally{button.disabled=false}
});
$('use-staged-nu').addEventListener('click',async()=>{
 if(!ensureEpubFirst())return;
 const address=$('nu-url').value.trim(),btn=$('use-staged-nu');btn.disabled=true;
 try{
  const response=await api('/api/admin/nu/staged-by-url?url='+encodeURIComponent(address));
  const title=String(response.metadata?.title||'');
  if(!confirm('Use staged metadata for "'+title+'" on novel #'+selected.novelId+'? Confirm these are the SAME novel.'))return;
  mergeNovelUpdates(response.metadata,'Novel Updates (staged)');
  $('nu-status').textContent='Existing staged metadata loaded for review. EPUB fields were preserved.';
 }catch(e){setStatus(e.message,true);$('nu-status').textContent=e.message}
 finally{btn.disabled=false}
});
$('nu-source-apply').addEventListener('click',()=>{
 if(!ensureEpubFirst())return;
 try{
  const raw=$('nu-source-paste').value.trim();
  if(!raw||raw.length>15000)throw Error('Paste the copied metadata JSON, up to 15,000 characters.');
  const data=JSON.parse(raw);
  if(data.source!=='novelupdates-browser-v1'||!data.novel||typeof data.novel!=='object')
   throw Error('This does not look like metadata from the Capture Novel Updates bookmark.');
  const novel=data.novel,url=new URL(String(novel.nuUrl||''));
  if(url.protocol!=='https:'||url.hostname!=='www.novelupdates.com'||!/^\/series\/[a-z0-9-]+\/?$/i.test(url.pathname))
   throw Error('The copied metadata has an invalid Novel Updates source URL.');
  const title=String(novel.title||'').trim();
  if(title.length<2)throw Error('The source title is missing.');
  const synopsis=String(novel.synopsis||'').trim();
  const tags=Array.isArray(novel.tags)?novel.tags.filter(x=>typeof x==='string').slice(0,35):[];
  const genres=Array.isArray(novel.genres)?novel.genres.filter(x=>typeof x==='string').slice(0,35):[];
  if(!synopsis&&!tags.length&&!genres.length)throw Error('No synopsis or tags were captured.');
  if(!confirm('Use retrieved metadata for '+title+' on novel #'+selected.novelId+'? Confirm these are the SAME novel. Changes are not saved until you approve them.'))return;
  mergeNovelUpdates({title,synopsis,tags,genres},'Novel Updates (browser capture)');
  $('nu-url').value=url.href;
  $('nu-source-result').textContent='Missing source fields filled for review; linked EPUB metadata preserved. Save, approve and apply privately.';
  $('apply').disabled=true;
  setStatus('Novel Updates source metadata filled for review. No database changes yet.');
 }catch(e){$('nu-source-result').textContent=e.message;setStatus(e.message,true)}
});
async function save(action){
 if(!selected)return;
 if(action==='approve'&&!$('rights').checked)return setStatus('Confirm the synopsis is original or authorized before approval.',true);
 const data={novelId:selected.novelId,editionId:selected.editionId,fieldSources,title:$('title').value,synopsis:$('synopsis').value,
  tags:unique($('tags').value),genres:unique($('genres').value),warnings:unique($('warnings').value),
  source,action,rightsConfirmed:action==='approve'&&$('rights').checked};
 try{await api('/api/admin/epub-insights/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  $('apply').disabled=action!=='approve';
  setStatus(action==='approve'?'Approved and saved privately. Click Apply to update the private catalogue; the public catalogue will not change.':'Saved as an unapproved private draft. No public changes were made.');
 }catch(e){setStatus(e.message,true)}
}
$('save').addEventListener('click',()=>save('draft'));$('approve').addEventListener('click',()=>save('approve'));
$('apply').addEventListener('click',async()=>{
 if(!selected||$('apply').disabled)return;
 if(!confirm('Apply the approved synopsis and tags to the PRIVATE entry for novel #'+selected.novelId+'? This overwrites existing private values for those fields but does not publish anything.'))return;
 const button=$('apply');button.disabled=true;
 try{
  const value=await api('/api/admin/epub-insights/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({novelId:selected.novelId,confirmApply:true})});
  setStatus(value.message||'Approved metadata applied privately. No public changes.');
 }catch(e){setStatus(e.message,true)}
 finally{button.disabled=false}
});

$('search-btn').addEventListener('click',()=>{offset=0;load()});$('search').addEventListener('keydown',e=>{if(e.key==='Enter'){offset=0;load()}});
$('previous').addEventListener('click',()=>{offset=Math.max(0,offset-30);load()});
$('next').addEventListener('click',()=>{offset+=30;load()});
load();
})();