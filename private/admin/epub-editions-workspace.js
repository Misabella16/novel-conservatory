/* Inline EPUB edition browser within the EPUB admin tab.
   All files remain behind the private reading API. */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
const input=$('epub-edition-quick-find'),button=$('epub-edition-quick-show');
if(!input||!button)return;
const result=$('epub-edition-quick-results'),list=$('epub-edition-quick-choices');
let books=[],loaded=false;
const json=async(path)=>{
 const r=await fetch(path,{credentials:'same-origin',cache:'no-store'});
 const j=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(j.error||'Request failed ('+r.status+')');
 return j;
};
async function loadBooks(){
 if(loaded)return;
 const [catalogue,content]=await Promise.all([json('/api/catalogue'),json('/api/content')]);
 books=[...(Array.isArray(catalogue)?catalogue:catalogue.books||[]),...(content.additional||[])];
 const known=new Set();books=books.filter(book=>{
  const id=Number(book.id);if(!Number.isSafeInteger(id)||known.has(id))return false;
  known.add(id);return true;
 });
 const fragment=document.createDocumentFragment();
 for(const book of books){
  const o=document.createElement('option');o.value='#'+book.id+' · '+book.title;
  fragment.append(o);
 }
 list.replaceChildren(fragment);loaded=true;
}
const findId=()=>{
 const value=input.value.trim();
 const m=/^#?(\d{1,11})(?:\D|$)/.exec(value);
 if(m)return Number(m[1]);
 const key=value.toLocaleLowerCase();
 return books.find(book=>String(book.title||'').toLocaleLowerCase()===key)?.id||null;
};
function link(parent,title,path){
 const a=document.createElement('a');a.href=path;a.textContent=title;
 a.style.cssText='display:inline-block;margin:5px 10px 5px 0;font-weight:600';
 parent.append(a);
}
async function show(){
 button.disabled=true;result.textContent='Checking your stored editions…';
 try{
  await loadBooks();
  const id=findId();
  if(!id)throw Error('Select an existing title or enter its #ID.');
  const data=await json('/api/private/edition/list?id='+encodeURIComponent(id));
  const editions=Array.isArray(data.editions)?data.editions:[];
  result.replaceChildren();
  const h=document.createElement('p'),strong=document.createElement('strong');
  strong.textContent=editions.length+' saved EPUB edition'+(editions.length===1?'':'s')+' for novel #'+id;
  h.append(strong);result.append(h);
  for(const edition of editions){
   const p=document.createElement('p');
   p.style.cssText='padding:8px 0;border-bottom:1px solid #e2e8e3;margin:0';
   p.textContent=(edition.label||edition.filename||'Translation edition')+
    (edition.translator?' · '+edition.translator:'')+
    ' · '+(edition.filename||'EPUB')+' ';
   link(p,'Read privately','/read/?id='+id+'&edition='+encodeURIComponent(edition.id));
   result.append(p);
  }
  if(!editions.length){
   const p=document.createElement('p');p.textContent='No EPUB editions are attached to this novel yet.';
   result.append(p);
  }
  link(result,'Browse or remove editions','/admin/editions.html?novel='+id+'#stored-editions');
  link(result,'View extracted covers','/admin/epub-cover-library.html?novel='+id);
 }catch(error){result.textContent=error.message||'Could not load editions.'}
 finally{button.disabled=false}
}
button.addEventListener('click',show);
input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();show()}});
input.addEventListener('focus',()=>{loadBooks().catch(()=>{})},{once:true});
})();
