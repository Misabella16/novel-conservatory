/* One durable novel URL per canonical ID. All data comes from signed-in,
 * private Access-protected endpoints; private EPUB bytes are never embedded. */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
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
  const [cat,content]=await Promise.all([json('/api/catalogue'),json('/api/content')]);
  const list=Array.isArray(cat)?cat:cat.books||[];
  const base=list.find(x=>Number(x.id)===id);
  if(!base)throw Error('This novel is not currently visible in the private catalogue.');
  const patch=(content.edits||[]).find(x=>Number(x.id)===id)?.patch||{};
  const additional=(content.additional||[]).find(x=>Number(x.id)===id)||{};
  const d={...base,...additional,...patch};
  document.title=(d.title||'Novel')+' · Novel Conservatory';
  $('title').textContent=d.title||'Untitled novel';
  $('catalogue-id').textContent='Novel Conservatory · catalogue #'+id;
  $('original').textContent=d.originalTitle||'';
  $('author').textContent=d.author?'By '+d.author:'Author not yet listed';
  $('synopsis').textContent=d.synopsis||'This novel does not have a synopsis yet. EPUB and Novel Updates metadata can fill missing information.';
  $('source-info').textContent=d.metadataSource?'Metadata source: '+d.metadataSource:'';
  chips($('genres'),d.genres);chips($('tags'),d.tags);
  const src=cleanUrl(d.cover||'');
  if(src){
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