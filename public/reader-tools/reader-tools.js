'use strict';
// This bookmarklet reads ONLY series fields visible in the current NU tab.
// No passwords, sessions or EPUBs are accessed or sent by the bookmarklet.
function captureNUTags(){
 const host=location.hostname.toLowerCase();
 const path=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/i.exec(location.pathname);
 if(!['www.novelupdates.com','novelupdates.com'].includes(host)||!path){
  alert('Open a specific Novel Updates series page first.');return;
 }
 const get=selectors=>{for(const selector of selectors){
  const node=document.querySelector(selector);
  const result=(node?.innerText||node?.textContent||'').trim();
  if(result)return result;
 }return ''};
 const list=selectors=>{
  const out=[];
  for(const selector of selectors)for(const node of document.querySelectorAll(selector)){
   const value=(node.innerText||node.textContent||'').trim().replace(/\s+/g,' ');
   if(value&&value.length<=70&&!out.includes(value))out.push(value);
  }
  return out.slice(0,35);
 };
 const capture={source:'novelupdates-reader-tags-v1',novel:{
  nuUrl:'https://www.novelupdates.com/series/'+path[1].toLowerCase()+'/',
  title:get(['.seriestitlenu','#edit-title','.series-title']).slice(0,210),
  author:get(['#showauthors','#seriesauthors','.author-content']).slice(0,140),
  genres:list(['#seriesgenre a','#showgenres a','.seriesgenre a']),
  tags:list(['#showtags a','#seriestags a','.seriestags a'])
 }};
 if(!capture.novel.title||(!capture.novel.tags.length&&!capture.novel.genres.length)){
  alert('This page is not fully loaded or the expected tags could not be read. Nothing copied.');return;
 }
 const json=JSON.stringify(capture);
 const fallback=()=>window.prompt('Copy this metadata then paste it into public Novel Conservatory Reader Tools:',json);
 if(navigator.clipboard?.writeText){
  navigator.clipboard.writeText(json).then(()=>alert('Tags copied! Return to public Novel Conservatory Reader Tools and paste.')).catch(fallback);
 }else fallback();
}
const $=id=>document.getElementById(id);
const bookmarklet='javascript:('+captureNUTags.toString()+')()';
$('bookmarklet').href=bookmarklet;
$('copy-bookmarklet').addEventListener('click',async()=>{
 try{await navigator.clipboard.writeText(bookmarklet);
  $('status').textContent='Bookmarklet code copied. Create a bookmark and paste this code into its URL field.';}
 catch{$('status').textContent='Clipboard blocked. Drag the Capture NU tags link to your bookmarks bar.';}
});
const escapeText=text=>String(text||'').trim().slice(0,210);
const canonical=text=>String(text||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const safeTags=text=>[...new Map(String(text||'').split(/[,\n;]/)
 .map(t=>t.trim()).filter(t=>t&&t.length<=70).map(t=>[t.toLowerCase(),t])).values()].slice(0,10);
let novels=[],selected=null,turnstileId=null,captchaReady=false,captured=null,siteKey='';
function say(text){$('status').textContent=text;}
function selectNovel(book){
 selected=book;$('matched').hidden=false;
 $('matched').textContent='Selected public novel #'+book.id+' · '+book.title;
 $('submit').disabled=!captchaReady;$('community-link').hidden=false;
 $('community-link').href='/community/?book='+encodeURIComponent(book.id)+
  '&title='+encodeURIComponent(book.title)+'&action=tags';
 $('results').replaceChildren();
}
function find(){
 const query=canonical($('search').value),results=$('results');results.replaceChildren();
 if(!query||query.length<2)return;
 const matches=novels.filter(book=>canonical(book.title).includes(query)||
  String(book.id)===query||canonical(book.author).includes(query)).slice(0,20);
 if(!matches.length){const p=document.createElement('p');p.textContent='No matching public novel. Check the spelling or ask for a new-novel entry.';results.append(p);}
 for(const novel of matches){
  const button=document.createElement('button');
  button.type='button';button.textContent=novel.title+' (#'+novel.id+')'+(novel.author?' · '+novel.author:'');
  button.addEventListener('click',()=>selectNovel(novel));results.append(button);
 }
}
$('search').addEventListener('input',find);
function reviewCapture(){
 try{
  const input=$('capture-json').value.trim();
  if(!input||input.length>16000)throw Error('Paste the copied JSON (maximum 16,000 characters).');
  const data=JSON.parse(input);
  if(data?.source!=='novelupdates-reader-tags-v1'||!data.novel||
   !/^https:\/\/www\.novelupdates\.com\/series\/[a-z0-9-]+\/$/.test(data.novel.nuUrl||''))
   throw Error('This is not a supported Novel Updates bookmarklet capture.');
  captured=data.novel;
  const tags=[...new Set([...(Array.isArray(captured.tags)?captured.tags:[]),
   ...(Array.isArray(captured.genres)?captured.genres:[])])]
   .filter(t=>typeof t==='string'&&t.trim().length<=70).slice(0,10);
  $('tags').value=tags.join(', ');
  $('capture-preview').textContent='Captured '+escapeText(captured.title)+
   ' · '+tags.length+' tags and genres. Check every tag before submitting.';
  $('search').value=captured.title||'';find();
  if(captured.author)$('note').value='Reader-supplied from '+captured.nuUrl+'; attributed author: '+captured.author;
  say('Select the exact matching published novel below, check the tags, and submit.');
 }catch(error){say('Capture rejected: '+error.message);}
}
$('review-capture').addEventListener('click',reviewCapture);
$('capture-json').addEventListener('paste',()=>{
 // Pasting inside the novel page immediately pre-fills tag proposals.
 setTimeout(()=>{if($('capture-json').value.trim())reviewCapture();},0);
});
async function loadTurnstile(){
 const script=document.createElement('script');
 script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
 script.async=true;
 script.onload=()=>{
  if(!window.turnstile){say('Anti-spam challenge unavailable.');return;}
  turnstileId=window.turnstile.render('#turnstile',{sitekey:siteKey,theme:'light'});
  captchaReady=true;$('submit').disabled=!selected;
 };
 document.head.append(script);
}
async function init(){
 try{
  const [a,b,c]=await Promise.all([
   fetch('/catalogue-submission-index.json',{cache:'no-store'}),
   fetch('/api/additional/books',{cache:'no-store'}),
   fetch('/api/community/config',{cache:'no-store'})
  ]);
  if(!a.ok||!b.ok||!c.ok)throw Error('Public catalogue or contribution service unavailable.');
  const seed=await a.json(),extra=await b.json(),config=await c.json();
  if(!config.enabled||!config.siteKey)throw Error('Public contributions need Cloudflare Turnstile configured.');
  novels=[
   ...(Array.isArray(seed)?seed:seed.items||[]),
   ...(extra.novels||[]).map(book=>({id:book.id,title:book.title,author:book.author}))
  ].filter(book=>Number.isSafeInteger(Number(book.id))&&book.title);
  const seen=new Set();novels=novels.filter(book=>{
   const id=Number(book.id);if(seen.has(id))return false;seen.add(id);
   return id<=962||id>=100000;
  });
  siteKey=config.siteKey;
  const query=new URLSearchParams(location.search);
  if(query.get('title')){$('search').value=query.get('title').slice(0,210);find();}
  const requested=Number(query.get('book'));
  const found=novels.find(book=>Number(book.id)===requested);
  if(found)selectNovel(found);
  if(query.get('embedded')==='1'){
   document.body.classList.add('embedded');
   // The surrounding detail page already identifies the target novel.
   $('search').value=found?.title||'';
  }
  await loadTurnstile();
  say('Ready. No admin login required. Choose a novel and submit reader tags.');
 }catch(error){say(error.message);}
}
$('submit').addEventListener('click',async()=>{
 if(!selected||!captchaReady)return say('Select an existing published novel and complete the security check.');
 const tags=safeTags($('tags').value),name=$('display-name').value.trim();
 if(!tags.length)return say('Enter at least one tag (up to ten).');
 if(name.length<2||name.length>64)return say('Use a display name between 2 and 64 characters.');
 const token=window.turnstile?.getResponse(turnstileId)||'';
 if(!token)return say('Complete the anti-spam challenge.');
 const fd=new FormData();
 fd.set('novel_id',String(selected.id));fd.set('kind','tags');fd.set('display_name',name);
 fd.set('tags',tags.join(', '));fd.set('body',$('note').value.slice(0,2200));
 fd.set('turnstile',token);
 $('submit').disabled=true;
 try{
  const response=await fetch('/api/community/submit',{method:'POST',body:fd,credentials:'same-origin'});
  const result=await response.json();
  if(!response.ok||!result.ok)throw Error(result.error||'Submission rejected');
  say(result.status==='approved'?
   'Reader tags published for '+selected.title+'. They are separate from editorial tags; no private metadata was changed.':
   'Contribution received for review.');
  $('tags').value='';
 }catch(error){say(error.message);}
 finally{
  window.turnstile?.reset(turnstileId);
  $('submit').disabled=!selected;
 }
});
init();