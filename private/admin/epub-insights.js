(()=>{'use strict';
const $=id=>document.getElementById(id),api=async(url,options)=>{const r=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Request failed');return j};
let records=[],offset=0,total=0,selected=null,source='not scanned';
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
 selected=item;source='not scanned';
 $('selected-title').textContent=item.filename;$('selected-detail').textContent='Novel #'+item.novelId+' • Private stored EPUB';
 $('editor').hidden=false;$('title').value='';$('synopsis').value='';$('tags').value='';$('genres').value='';$('warnings').value='';
 $('rights').checked=false;$('nu-url').value='';$('apply').disabled=true;$('publish-public').disabled=true;$('nu-source-paste').value='';$('nu-source-result').textContent='';
 $('origin').textContent='No EPUB text inspected yet.';
 await load();
 try{
  const v=await api('/api/admin/epub-insights/draft?id='+item.novelId);
  if(v.draft?.editionId===item.editionId){
   const d=v.draft;
   $('title').value=d.title||'';$('synopsis').value=d.synopsis||'';
   $('tags').value=(d.tags||[]).join(', ');$('genres').value=(d.genres||[]).join(', ');
   $('warnings').value=(d.warnings||[]).join(', ');
   source=d.source||'saved review';
   $('origin').textContent=d.approved?'Previously approved draft for this edition':'Previously saved draft, not yet approved';
   $('apply').disabled=!d.approved;$('publish-public').disabled=!d.approved;
  }
  setStatus('Ready to inspect this stored EPUB. Review changes before saving.');
 }catch(e){setStatus(e.message,true)}
}
$('inspect').addEventListener('click',async()=>{
 if(!selected)return;
 const button=$('inspect');button.disabled=true;setStatus('Inspecting EPUB privately in your browser…');
 try{
  const base=selected.editionId==='legacy'?'/api/private/epub/file?id='+selected.novelId:
    '/api/private/edition/file?id='+selected.novelId+'&edition='+encodeURIComponent(selected.editionId);
  const r=await fetch(base,{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw Error('Unable to read stored EPUB ('+r.status+').');
  const file=await r.blob(),data=await inspectBook(file);
  if(data.title&&!$('title').value)$('title').value=data.title;
  if(data.synopsis&&!$('synopsis').value)$('synopsis').value=short(data.synopsis);
  if(data.tags.length&&!$('tags').value)$('tags').value=data.tags.join(', ');
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
 if(!/^https:\/\/www\.novelupdates\.com\/series\/[a-z0-9-]+\/?$/i.test(address))
  return setStatus('Enter the canonical Novel Updates URL (https://www.novelupdates.com/series/...).',true);
 const button=$('lookup-nu');button.disabled=true;$('nu-status').textContent='Retrieving existing Novel Updates metadata…';
 try{
  const res=await api('/api/admin/nu/lookup?url='+encodeURIComponent(address));
  const parsed=fromNuHtml(res.html);
  if(!parsed.title||(!parsed.synopsis&&!parsed.tags.length&&!parsed.genres.length))
   throw Error('No confirmed Novel Updates title and metadata found. The page may be blocked or its layout may have changed.');
  if(parsed.title&&!$('title').value)$('title').value=parsed.title;
  if(parsed.synopsis&&!$('synopsis').value.trim())$('synopsis').value=parsed.synopsis.slice(0,2000);
  if(parsed.tags.length&&!$('tags').value.trim())$('tags').value=parsed.tags.join(', ');
  if(parsed.genres.length&&!$('genres').value.trim())$('genres').value=parsed.genres.join(', ');
  source=source.includes('EPUB package')?'EPUB package; Novel Updates fallback':'Novel Updates (retrieved '+new Date().toISOString().slice(0,10)+')';
  $('origin').textContent='Source: '+address+' • Retrieved title: '+(parsed.title||'missing')+
   ' • Genres: '+parsed.genres.length+' • Tags: '+parsed.tags.length;
  $('nu-status').textContent='Retrieved from Novel Updates. Missing fields were left unchanged. Verify the title matches the selected EPUB.';
  setStatus('Existing source metadata retrieved. Review before approving privately.');
 }catch(err){$('nu-status').textContent=err.message;setStatus(err.message,true)}
 finally{button.disabled=false}
});
$('nu-source-apply').addEventListener('click',()=>{
 if(!selected)return setStatus('Select a stored EPUB before using copied metadata.',true);
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
  if(!confirm('Use the retrieved metadata for '+title+' on stored EPUB #'+selected.novelId+'? Confirm this is the SAME novel. Changes are not saved until you approve them.'))return;
  $('title').value=title.slice(0,210);
  if(synopsis&&!$('synopsis').value.trim())$('synopsis').value=synopsis.slice(0,2000);
  if(tags.length&&!$('tags').value.trim())$('tags').value=tags.join(', ');
  if(genres.length&&!$('genres').value.trim())$('genres').value=genres.join(', ');
  source=source.includes('EPUB package')?'EPUB package; Novel Updates fallback':'Novel Updates: '+url.origin+url.pathname;
  $('origin').textContent='Retrieved source for '+title+': '+url.origin+url.pathname;
  $('nu-source-result').textContent='Retrieved fields filled for review. Choose Save as review draft, then Approve and Apply privately.';
  $('apply').disabled=true;
  setStatus('Novel Updates source metadata filled for review. No database changes yet.');
 }catch(e){$('nu-source-result').textContent=e.message;setStatus(e.message,true)}
});
async function save(action){
 if(!selected)return;
 if(action==='approve'&&!$('rights').checked)return setStatus('Confirm the synopsis is original or authorized before approval.',true);
 const data={novelId:selected.novelId,editionId:selected.editionId,title:$('title').value,synopsis:$('synopsis').value,
  tags:unique($('tags').value),genres:unique($('genres').value),warnings:unique($('warnings').value),
  source,action,rightsConfirmed:action==='approve'&&$('rights').checked};
 try{await api('/api/admin/epub-insights/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  $('apply').disabled=action!=='approve';$('publish-public').disabled=action!=='approve';
  setStatus(action==='approve'?'Approved and saved privately. Click Apply to update the private catalogue; the public catalogue will not change.':'Saved as an unapproved private draft. No public changes were made.');
 }catch(e){setStatus(e.message,true)}
}
$('save').addEventListener('click',()=>save('draft'));$('approve').addEventListener('click',()=>save('approve'));
$('publish-public').addEventListener('click',async()=>{
 if(!selected||$('publish-public').disabled)return;
 if(!confirm('Publish this APPROVED synopsis, genres and tags to the PUBLIC catalogue for novel #'+selected.novelId+'? This does not publish or reveal any EPUB, and updates existing public metadata.'))return;
 const button=$('publish-public');button.disabled=true;
 try{
  const result=await api('/api/admin/epub-insights/publish-public',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({novelId:selected.novelId,confirmPublish:true})});
  setStatus(result.message||'Approved metadata published to public catalogue. No private EPUB files were shared.');
 }catch(e){setStatus(e.message,true)}finally{button.disabled=false}
});
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