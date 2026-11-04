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
 $('rights').checked=false;$('nu-url').value='';
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
 const title=textFrom(doc,['.seriestitlenu','#edit-title','.series-title','h1']);
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
  if(!parsed.title&&!parsed.synopsis&&!parsed.tags.length&&!parsed.genres.length)
   throw Error('The retrieved page had no recognizable series metadata. Do not save empty fields; the layout may have changed.');
  if(parsed.title&&!$('title').value)$('title').value=parsed.title;
  if(parsed.synopsis)$('synopsis').value=parsed.synopsis.slice(0,2000);
  if(parsed.tags.length)$('tags').value=parsed.tags.join(', ');
  if(parsed.genres.length)$('genres').value=parsed.genres.join(', ');
  source='Novel Updates (retrieved '+new Date().toISOString().slice(0,10)+')';
  $('origin').textContent='Source: '+address+' • Retrieved title: '+(parsed.title||'missing')+
   ' • Genres: '+parsed.genres.length+' • Tags: '+parsed.tags.length;
  $('nu-status').textContent='Retrieved from Novel Updates. Missing fields were left unchanged. Verify the title matches the selected EPUB.';
  setStatus('Existing source metadata retrieved. Review before approving privately.');
 }catch(err){$('nu-status').textContent=err.message;setStatus(err.message,true)}
 finally{button.disabled=false}
});
async function save(action){
 if(!selected)return;
 if(action==='approve'&&!$('rights').checked)return setStatus('Confirm the synopsis is original or authorized before approval.',true);
 const data={novelId:selected.novelId,editionId:selected.editionId,title:$('title').value,synopsis:$('synopsis').value,
  tags:unique($('tags').value),genres:unique($('genres').value),warnings:unique($('warnings').value),
  source,action,rightsConfirmed:action==='approve'&&$('rights').checked};
 try{await api('/api/admin/epub-insights/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  setStatus(action==='approve'?'Approved and saved privately for editorial use. No public changes were made.':'Saved as an unapproved private draft. No public changes were made.');
 }catch(e){setStatus(e.message,true)}
}
$('save').addEventListener('click',()=>save('draft'));$('approve').addEventListener('click',()=>save('approve'));
$('search-btn').addEventListener('click',()=>{offset=0;load()});$('search').addEventListener('keydown',e=>{if(e.key==='Enter'){offset=0;load()}});
$('previous').addEventListener('click',()=>{offset=Math.max(0,offset-30);load()});
$('next').addEventListener('click',()=>{offset+=30;load()});
load();
})();