/* Novel Conservatory · Novel Updates bulk collector (runner part).
 *
 * This file is NOT loaded by the private site. /admin/nu-bulk.html joins it
 * with /novel/nu-source.js and a list of novels to build one script that the
 * owner pastes into the developer console of a novelupdates.com tab they have
 * opened normally (after passing any "verify you are human" check
 * themselves).
 *
 * Rules it keeps:
 *  - Only runs on www.novelupdates.com; only requests /series/<slug>/ pages
 *    on that same site, one at a time, several seconds apart.
 *  - Stops immediately on any challenge, 403, 429 or 503. It never retries
 *    around, solves or skips a check: the person handles it, then pastes the
 *    script again to resume.
 *  - Reads only the series page's public metadata through the same parser as
 *    the novel page (ConservatoryNUSource.parseHtml). No cookies, tokens or
 *    page HTML leave the tab; the result is a JSON file the person downloads
 *    and uploads to /admin/nu-bulk.html themselves.
 */
(async function runNovelConservatoryCollector(LIST, DELAY_MS){
 'use strict';
 const KEY='novelConservatoryNUBulk';
 const FORMAT='novel-conservatory-nu-bulk-v1';
 if(location.hostname!=='www.novelupdates.com'){
  alert('Open https://www.novelupdates.com/ in this tab first, then paste the script again.');
  return;
 }
 if(!window.ConservatoryNUSource||typeof window.ConservatoryNUSource.parseHtml!=='function'){
  alert('The script was not pasted completely. Copy it again from the Novel Conservatory page.');
  return;
 }
 if(window.__ncNUBulkRunning){alert('The collector is already running in this tab.');return;}
 window.__ncNUBulkRunning=true;

 let store={};
 try{store=JSON.parse(localStorage.getItem(KEY)||'{}')||{}}catch{store={}}
 if(!store.items||typeof store.items!=='object')store.items={};
 let saveWarned=false;
 const save=()=>{
  try{localStorage.setItem(KEY,JSON.stringify(store));return true}
  catch(e){
   if(!saveWarned){saveWarned=true;console.warn('[NC] Could not save progress in this browser',e)}
   return false;
  }
 };

 // ---- small status panel -------------------------------------------------
 const old=document.getElementById('nc-nu-bulk');if(old)old.remove();
 const box=document.createElement('div');
 box.id='nc-nu-bulk';
 box.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#285345;color:#fff;'+
  'font:13px/1.45 system-ui,sans-serif;padding:12px 14px;border-radius:12px;box-shadow:0 8px 28px #0007;max-width:330px';
 const title=document.createElement('strong');title.textContent='Novel Conservatory · NU collector';
 const line=document.createElement('div');line.style.margin='6px 0 9px';line.textContent='Starting…';
 const mk=(label,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=label;
  b.style.cssText='margin:0 6px 0 0;padding:4px 8px;border-radius:6px;border:0;cursor:pointer';b.onclick=fn;return b};
 let stop=false;
 const pauseBtn=mk('Pause',()=>{stop=true;status('Pausing after this page…')});
 const dlBtn=mk('Download file',()=>download());
 const resetBtn=mk('Start over',()=>{
  if(!confirm('Forget everything collected in this browser so far?'))return;
  stop=true;store={items:{}};try{localStorage.removeItem(KEY)}catch{}
  status('Cleared. Paste the script again to start over.');
 });
 box.append(title,line,pauseBtn,dlBtn,resetBtn);
 document.body.appendChild(box);
 function status(text){line.textContent=text}

 function download(){
  const items=LIST.filter(b=>store.items[b.id]).map(b=>({id:b.id,title:b.title,nuUrl:b.nuUrl,...store.items[b.id]}));
  const blob=new Blob([JSON.stringify({format:FORMAT,collectedAt:new Date().toISOString(),requested:LIST.length,items})],
   {type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='nu-bulk-'+new Date().toISOString().slice(0,10)+'.json';
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),10000);
 }

 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const isChallenge=html=>/<title>\s*(?:Just a moment|Attention Required)/i.test(html)||
  /challenge-platform|cf-turnstile|verify you are human/i.test(html.slice(0,20000));
 const done=()=>LIST.filter(b=>store.items[b.id]&&store.items[b.id].capture).length;
 // Failed pages are retried on the next run; collected ones are kept.
 const todo=LIST.filter(b=>!store.items[b.id]||!store.items[b.id].capture);
 status(done()+' of '+LIST.length+' collected. '+todo.length+' to go (about '+
  Math.ceil(todo.length*(DELAY_MS+1000)/60000)+' min).');

 let emptyStreak=0,halted='';
 for(const book of todo){
  if(stop)break;
  let path;
  try{path=new URL(book.nuUrl).pathname}catch{path=''}
  if(!/^\/series\/[a-z0-9][a-z0-9-]{0,190}\/$/i.test(path)){
   store.items[book.id]={error:'Not a Novel Updates series link'};save();continue;
  }
  let res,html='';
  try{
   res=await fetch(path,{credentials:'same-origin',headers:{Accept:'text/html'},redirect:'follow'});
   html=await res.text();
  }catch(e){halted='Network error at “'+book.title+'”.';break;}
  if([403,429,503].includes(res.status)||isChallenge(html)){
   halted='Novel Updates asked for a check (or is slowing requests).';
   break;
  }
  if(!res.ok){
   store.items[book.id]={error:'HTTP '+res.status};
  }else{
   const capture=window.ConservatoryNUSource.parseHtml(html,book.nuUrl);
   if(capture){store.items[book.id]={capture};emptyStreak=0}
   else{store.items[book.id]={error:'No metadata found on the page'};emptyStreak++}
  }
  save();
  status(done()+' of '+LIST.length+' collected · last: '+book.title);
  console.log('[NC]',done()+'/'+LIST.length,book.title,store.items[book.id]);
  if(emptyStreak>=5){
   halted='5 pages in a row had no metadata. Novel Updates may have changed its page layout.';
   break;
  }
  await sleep(DELAY_MS+Math.random()*1500);
 }
 window.__ncNUBulkRunning=false;

 const n=done();
 const failed=LIST.filter(b=>store.items[b.id]&&store.items[b.id].error).length;
 if(halted){
  status(halted+' Paused at '+n+' of '+LIST.length+'. Reload the page, complete any check yourself, wait a minute, '+
   'then paste the script again to resume. Or click Download file to use what you have.');
 }else if(stop){
  status('Paused at '+n+' of '+LIST.length+'. Paste the script again to resume, or click Download file.');
 }else{
  status('Finished: '+n+' collected'+(failed?', '+failed+' failed (they are listed in the file)':'')+
   '. Downloading the file…'+(saveWarned?' (Progress could not be saved in this browser.)':''));
  download();
 }
})
