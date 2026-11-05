/* Consolidated dashboard: four workspaces, one existing editor and inline NU tools.
   Reuses original admin controls and APIs; permissions stay on the server. */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
const shell=$('admin-workspace-shell');
if(!shell)return;
const areas=['novels','epubs','community','site'];
let active='novels';
function role(){
 try{return currentRole}catch{return 'reader'}
}
function ownerOnly(){
 const enabled=role()==='owner';
 for(const el of document.querySelectorAll('[data-owner-only]'))el.hidden=!enabled;
}
function setWorkspace(name,{updateHash=true,scroll=true}={}){
 if(!areas.includes(name))name='novels';
 active=name;shell.dataset.workspace=name;
 for(const area of areas){
  $('workspace-'+area).classList.toggle('hidden',area!==name);
  const button=document.querySelector('[data-workspace-target="'+area+'"]');
  button?.setAttribute('aria-selected',String(area===name));
 }
 // Keep the existing editor's dynamic fields, saves, and team/readers controls.
 if(typeof openTab==='function'){
  if(name==='site')openTab('home');
  else openTab('book');
 }
 ownerOnly();
 if(updateHash)history.replaceState(null,'',location.pathname+location.search+'#'+name);
 if(scroll)window.scrollTo({top:0,behavior:'auto'});
}
for(const button of document.querySelectorAll('[data-workspace-target]')){
 button.addEventListener('click',()=>setWorkspace(button.dataset.workspaceTarget));
}
for(const button of document.querySelectorAll('[data-existing-pane]')){
 button.addEventListener('click',()=>{
  if(button.hasAttribute('data-owner-only')&&role()!=='owner')return;
  const pane=button.dataset.existingPane;
  if(!['home','team','readers'].includes(pane))return;
  if(pane==='readers'&&active==='epubs'){
   setWorkspace('site',{scroll:false});
  }
  if(typeof openTab==='function')openTab(pane);
  for(const e of document.querySelectorAll('[data-existing-pane]')){
   e.setAttribute('aria-selected',String(e.dataset.existingPane===pane));
  }
  $(pane+'-page')?.scrollIntoView({behavior:'smooth',block:'start'});
 });
}
window.addEventListener('hashchange',()=>{
 const hash=location.hash.slice(1);
 if(areas.includes(hash))setWorkspace(hash,{updateHash:false,scroll:false});
});
const starting=location.hash.slice(1);
setWorkspace(areas.includes(starting)?starting:'novels',{updateHash:false,scroll:false});
fetch('/api/me',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(u=>{
 if(u){shell.dataset.role=u.role||'reader';ownerOnly()}
}).catch(()=>{});

// Novel Updates field belongs directly to whichever book is selected.
const nu=$('nu'),state=$('nu-inline-status'),open=$('nu-open-inline');
const status=(message,error=false)=>{
 state.textContent=message;
 state.style.background=error?'#fff0e8':'#e5f1e7';
 state.style.color=error?'#8f3b24':'#275d48';
};
const series=value=>{
 try{
  const u=new URL(value);
  const match=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/i.exec(u.pathname);
  if(u.protocol!=='https:'||!['novelupdates.com','www.novelupdates.com'].includes(u.hostname)
     ||!match||u.username||u.password||u.search||u.hash)return '';
  return 'https://www.novelupdates.com/series/'+match[1].toLowerCase()+'/';
 }catch{return ''}
};
function bookID(){
 try{
  return Number.isSafeInteger(Number(selected))&&Number(selected)>0?Number(selected):null;
 }catch{return null}
}
function updateOpenLink(){
 const url=series(nu.value.trim());
 open.hidden=!url;
 if(url)open.href=url;else open.removeAttribute('href');
}
nu.addEventListener('input',updateOpenLink);
const heading=$('selected-heading');
if(heading)new MutationObserver(()=>{
 updateOpenLink();
 const id=bookID();
 if(id)status('Editing novel #'+id+'. Paste a series URL, then save it without approval.');
}).observe(heading,{childList:true,subtree:true,characterData:true});
async function json(path,options={}){
 const response=await fetch(path,{cache:'no-store',credentials:'same-origin',...options});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||'The request failed ('+response.status+')');
 return data;
}
async function reloadSelected(id){
 try{
  const j=await json('/api/content');
  for(const row of j.edits||[])if(Number(row.id)===id)edits[id]=row.patch;
  if(bookID()===id&&typeof selectBook==='function')selectBook(id);
 }catch{
  status('Change saved. Refresh this page if the edited fields have not updated.');
 }
}
$('nu-save-inline').addEventListener('click',async()=>{
 const id=bookID(),value=series(nu.value.trim());
 if(!id)return status('Choose a novel in the book list first.',true);
 if(!value)return status('Paste a valid Novel Updates series URL, not a search or homepage link.',true);
 const b=$('nu-save-inline');b.disabled=true;
 status('Saving the Novel Updates link to novel #'+id+'…');
 try{
  const result=await json('/api/admin/nu/link-inline',{
   method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,nuUrl:value})
  });
  status(result.alreadyUpToDate?'This Novel Updates link is already saved.':
   'Saved to novel #'+id+'. The change is reversible in Duplicates & Undo.');
  await reloadSelected(id);updateOpenLink();
 }catch(err){status(err.message,true)}
 finally{b.disabled=false}
});
$('nu-import-inline').addEventListener('click',async()=>{
 const id=bookID();if(!id)return status('Choose the novel you want to update first.',true);
 let capture;try{
  capture=JSON.parse($('nu-paste-inline').value.trim());
  if(capture?.source!=='novelupdates-browser-v1'||!capture.novel||typeof capture.novel!=='object')
   throw Error('Paste JSON copied using the Capture Novel Updates bookmarklet.');
  const incoming=series(capture.novel.nuUrl);
  if(!incoming||!String(capture.novel.title||'').trim())throw Error('The capture needs a series URL and title.');
  const current=series(nu.value.trim());
  if(current&&current!==incoming)
   throw Error('The captured series URL differs from this book’s link. Correct the link before importing.');
  if(!current)nu.value=incoming;
  updateOpenLink();
 }catch(err){return status(err.message||'Could not read the Novel Updates capture.',true)}
 const button=$('nu-import-inline');button.disabled=true;
 status('Matching the captured metadata to selected novel #'+id+'…');
 try{
  const result=await json('/api/admin/nu/sync-capture',{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({capture,targetId:id})
  });
  if(result.needsChoice||result.needsIdentityConfirmation)
   return status(result.message||'The captured series could not safely be matched to this novel. Open Duplicates & Undo to compare the identities.',true);
  if(!result.ok)return status(result.message||'Nothing was saved.',true);
  const fields=Array.isArray(result.changed)?result.changed:[];
  status('Saved Novel Updates metadata to novel #'+id+'. '+
    (fields.length?'Filled: '+fields.join(', ')+'. ':'Existing values were preserved. ')+
    'Undo is available in Duplicates & Undo.'+
    (result.privateSynced===false?' Private catalogue sync needs attention.':''));
  await reloadSelected(id);
 }catch(err){status(err.message,true)}
 finally{button.disabled=false}
});
updateOpenLink();
})();