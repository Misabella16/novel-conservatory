(()=>{'use strict';
const $=id=>document.getElementById(id),api=async(url,options)=>{const r=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Request failed');return j};
let records=[],offset=0,total=0,selected=null,excerpt='',source='not scanned';
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
 const manifest=new Map();
 for(const node of byName(packageDoc,'item')){
  const id=node.getAttribute('id'),href=node.getAttribute('href');
  if(id&&href)manifest.set(id,{file:pathOf(root,href),type:node.getAttribute('media-type')||''});
 }
 let parts=[],found=0;
 for(const item of byName(packageDoc,'itemref')){
  if(found>=9)break;
  const f=manifest.get(item.getAttribute('idref'));if(!f||!f.file||!zip.file(f.file))continue;
  if(!/xhtml|html/.test(f.type)&&!/\.x?html$/i.test(f.file))continue;
  try{
   const content=await zip.file(f.file).async('text');
   if(content.length>850000)continue;
   const doc=parser.parseFromString(content,'text/html');
   doc.querySelectorAll('script,style,nav,svg,head').forEach(el=>el.remove());
   const cleaned=(doc.body?.textContent||'').replace(/\s+/g,' ').trim();
   if(cleaned.length>=170){parts.push(cleaned.slice(0,1900));found++}
  }catch{}
 }
 return {...data,excerpt:parts.join('\n\n').slice(0,12500),filesSampled:found};
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
 selected=item;excerpt='';source='not scanned';
 $('selected-title').textContent=item.filename;$('selected-detail').textContent='Novel #'+item.novelId+' • Private stored EPUB';
 $('editor').hidden=false;$('title').value='';$('synopsis').value='';$('tags').value='';$('genres').value='';$('warnings').value='';
 $('consent').checked=false;$('rights').checked=false;$('generate').disabled=true;
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
  excerpt=data.excerpt;source='EPUB package + opening chapter sample';
  $('generate').disabled=excerpt.length<300;
  $('origin').textContent='Embedded title: '+(data.title||'not found')+' • Author: '+(data.author||'not found')+
   ' • Sampled chapters: '+data.filesSampled+' • Excerpt characters: '+excerpt.length;
  setStatus('Inspected locally. Embedded metadata filled where fields were blank.'+(excerpt.length<300?' Not enough chapter text for AI drafting.':' AI drafting is available with explicit consent.'));
 }catch(e){setStatus(e.message,true)}
 finally{button.disabled=false}
});
$('generate').addEventListener('click',async()=>{
 if(!selected||excerpt.length<300)return;
 if(!$('consent').checked)return setStatus('Consent is required before sending an excerpt to Workers AI.',true);
 const b=$('generate');b.disabled=true;setStatus('Generating a provisional draft from selected EPUB excerpts…');
 try{
  const v=await api('/api/admin/epub-insights/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
   novelId:selected.novelId,excerpt,title:$('title').value,consent:true
  })});
  const d=v.draft;$('synopsis').value=d.synopsis||$('synopsis').value;$('tags').value=(d.tags||[]).join(', ');
  $('genres').value=(d.genres||[]).join(', ');$('warnings').value=(d.warnings||[]).join(', ');
  source='AI-assisted draft from private EPUB excerpts';
  $('origin').textContent='AI draft from '+v.excerptChars+' characters. Excerpts may omit critical plot information.';
  setStatus('AI draft ready for review. Verify names, tropes and warnings before approving.');
 }catch(e){setStatus(e.message,true)}finally{b.disabled=false}
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