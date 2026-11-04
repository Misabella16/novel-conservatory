(()=>{'use strict';
const $=id=>document.getElementById(id);
const root=$('results'),status=$('status');
const escNU=raw=>{
 try{
  const u=new URL(String(raw||'').trim());
  const match=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/.exec(u.pathname);
  if(u.protocol!=='https:'||u.hostname!=='www.novelupdates.com'||u.port||u.username||u.password||u.search||u.hash||!match)return null;
  return 'https://www.novelupdates.com/series/'+match[1]+'/';
 }catch{return null}
};
async function api(path,options){
 const r=await fetch(path,{credentials:'same-origin',cache:'no-store',...options}),value=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(value.error||'Request failed');
 return value;
}
const details=(parent,title,value)=>{
 if(!value)return;
 const row=document.createElement('div');row.className='row';
 const b=document.createElement('strong');b.textContent=title+': ';
 const body=document.createElement('span');body.textContent=value;
 row.append(b,body);parent.appendChild(row);
};
function link(parent,title,url){
 const a=document.createElement('a');a.href=url;a.textContent=title;a.target='_blank';a.rel='noopener noreferrer';
 parent.appendChild(a);return a;
}
function button(label,callback,style='alt'){
 const b=document.createElement('button');b.type='button';b.textContent=label;b.className=style;
 b.addEventListener('click',()=>callback(b));
 return b;
}
function parseNU(html,url){
 // Parsing text only does not execute third-party JavaScript.
 const doc=new DOMParser().parseFromString(html,'text/html');
 const first=selectors=>{
  for(const sel of selectors){const e=doc.querySelector(sel);if(e){const t=(e.textContent||'').replace(/\s+/g,' ').trim();if(t)return t}}
  return '';
 };
 const list=selectors=>{
  const seen=new Set(),out=[];
  for(const sel of selectors)for(const el of doc.querySelectorAll(sel)){
   const t=(el.textContent||'').replace(/\s+/g,' ').trim();
   if(t&&t.length<=100&&!seen.has(t.toLowerCase())){out.push(t);seen.add(t.toLowerCase())}
   if(out.length>=35)return out;
  }
  return out;
 };
 const title=first(['.seriestitlenu','#edit-title','.series-title']).slice(0,210);
 const synopsis=first(['#editdescription','#seriesdescription','.series-description','#showdescription','.seriesdescription']).slice(0,6000);
 const author=first(['#showauthors','#seriesauthors','.author-content']).slice(0,140);
 const originalTitle=first(['#editassociated','#seriesothernames','#showassociated','#seriesassociated']).slice(0,210);
 const genres=list(['#seriesgenre a','#showgenres a','.seriesgenre a']);
 const tags=list(['#showtags a','#seriestags a','.seriestags a']);
 const cover=doc.querySelector('#seriesimg img,.seriesimg img,.series-image img');
 let coverUrl='';
 try{
  if(cover){const u=new URL(cover.getAttribute('data-src')||cover.getAttribute('src')||'',url);
   if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port)coverUrl=u.href.slice(0,900)}
 }catch{}
 return {nuUrl:url,title,author,originalTitle,synopsis,genres,tags,coverUrl};
}
async function updateStatus(id,next){
 await api('/api/admin/site-feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,status:next})});
 await load();
}
async function fetchSource(item,url,panel,actions,trigger){
 trigger.disabled=true;panel.replaceChildren();panel.hidden=false;
 const message=document.createElement('p');message.className='small';message.textContent='Retrieving the existing Novel Updates page…';panel.appendChild(message);
 try{
  // The server fetches ONLY the validated Novel Updates host, with no redirects.
  const result=await api('/api/admin/nu/lookup?url='+encodeURIComponent(url));
  const novel=parseNU(result.html,url);
  if(!novel.title||(!novel.synopsis&&!novel.genres.length&&!novel.tags.length))
   throw Error('The source page did not contain enough readable metadata. Open the page yourself and use Browser Capture in staging.');
  panel.replaceChildren();
  const head=document.createElement('h3');head.textContent='Retrieved source details · Not yet published';panel.appendChild(head);
  details(panel,'Title',novel.title);
  details(panel,'Author',novel.author);
  details(panel,'Original title',novel.originalTitle);
  details(panel,'Genres',novel.genres.join(', '));
  details(panel,'Tags',novel.tags.join(', '));
  if(novel.synopsis){const title=document.createElement('strong');title.textContent='Original synopsis';panel.appendChild(title);const p=document.createElement('p');p.className='summary';p.textContent=novel.synopsis;panel.appendChild(p)}
  const stage=button('Save these fields as unpublished draft',async btn=>{
   if(!confirm('Stage the retrieved Novel Updates metadata as an unpublished draft? This does not publish a novel.'))return;
   btn.disabled=true;
   message.textContent='Saving source-only metadata…';
   try{
    const staged=await api('/api/admin/nu/stage-browser',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:'novelupdates-browser-v1',novel})});
    message.textContent='Saved “'+staged.title+'” to the private staging queue. Nothing was published.';
    stage.remove();
    const next=document.createElement('p');next.className='small';panel.appendChild(next);
    link(next,'Review and publish later in Novel Updates staging ↗','/admin/novel-updates.html');
   }catch(e){message.textContent=e.message;btn.disabled=false}
  },'');
  panel.appendChild(stage);panel.appendChild(message);
 }catch(e){
  message.textContent=e.message||'Direct retrieval failed.';
  const p=document.createElement('p');p.className='small';
  p.textContent='You can still review this link manually: ';
  link(p,'Open the Novel Updates series page ↗',url);p.append(' · ');
  link(p,'Browser-assisted capture instructions ↗','/admin/novel-updates.html');
  panel.appendChild(p);
 }finally{trigger.disabled=false}
}

async function approveExistingLink(item,bookId,title,url,trigger){
 if(!confirm('Approve this Novel Updates link for '+title+' (novel #'+bookId+')? This changes that book’s source URL, not its synopsis or tags.'))return;
 trigger.disabled=true;
 const send=async replaceExisting=>api('/api/admin/nu/apply-submitted-link',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({submissionId:item.id,confirm:true,replaceExisting})
 });
 try{
  let result;
  try{result=await send(false)}
  catch(err){
   if(!String(err.message||'').includes('already has a Novel Updates link'))throw err;
   if(!confirm('This novel already has a Novel Updates link. Replace its existing link with the submitted one?'))return;
   result=await send(true);
  }
  status.textContent='Approved the Novel Updates link for '+title+' (book #'+bookId+'). '+(result.privateSynced===false?'Public updated; private sync needs attention.':'The public and private catalogues are updated.');
  await load();
 }catch(err){status.textContent=err.message||'Could not approve the correction'}
 finally{trigger.disabled=false}
}
async function load(){
 root.replaceChildren();status.textContent='Loading link suggestions…';
 try{
  const {items=[]}=await api('/api/admin/site-feedback?status=pending');
  const requests=items.filter(x=>x.scope==='public'&&String(x.subject||'').startsWith('Novel Updates link: '));
  status.textContent=requests.length+' pending Novel Updates link'+(requests.length===1?'':'s')+'.';
  if(!requests.length){root.textContent='No pending Novel Updates links right now.';return}
  for(const item of requests){
   const extracted=/^Novel Updates series:\s*(https:\/\/[^\s]+)/m.exec(String(item.message||''));
   const bookMatch=/^Catalogue ID: ([1-9][0-9]*)\nCatalogue title: ([^\n]{1,180})/m.exec(String(item.message||''));
   const bookId=bookMatch?Number(bookMatch[1]):null,bookTitle=bookMatch?bookMatch[2]:'';
   const url=escNU(extracted?.[1]);
   const card=document.createElement('article');card.className='item';
   const head=document.createElement('div');head.className='item-head';
   const title=document.createElement('h2');title.textContent=String(item.subject||'').slice(0,180);head.appendChild(title);
   const meta=document.createElement('div');meta.className='meta';
   meta.textContent=(item.display_name||'Reader')+' · '+(item.created_at?new Date(item.created_at).toLocaleString():'Time unknown');
   head.appendChild(meta);card.appendChild(head);
   if(url){const p=document.createElement('p');link(p,url,url);card.appendChild(p)}
   else{const p=document.createElement('p');p.textContent='This entry has an invalid series URL and cannot be retrieved.';card.appendChild(p)}
   const note=String(item.message||'').split('\nReader note: ')[1];
   if(note)details(card,'Reader note',note.slice(0,1200));
   if(bookId)details(card,'Correction for existing novel','#'+bookId+' · '+bookTitle);
   else details(card,'Request type','Suggest a new Novel Updates series');
   if(item.reply_to)details(card,'Reply email',item.reply_to);
   const actions=document.createElement('div');actions.className='actions';
   const panel=document.createElement('section');panel.className='review';panel.hidden=true;
   if(url&&bookId)actions.appendChild(button('✓ Approve link for this novel',b=>approveExistingLink(item,bookId,bookTitle,url,b),''));
   if(url)actions.appendChild(button('Retrieve synopsis & tags',b=>fetchSource(item,url,panel,actions,b),''));
   actions.appendChild(button('Mark resolved',async b=>{
    if(!confirm('Mark this link suggestion as resolved? It will leave the pending queue, but will not automatically publish anything.'))return;
    b.disabled=true;try{await updateStatus(item.id,'resolved')}catch(e){status.textContent=e.message;b.disabled=false}
   }));
   actions.appendChild(button('Archive',async b=>{
    if(!confirm('Archive this link suggestion without publishing?'))return;
    b.disabled=true;try{await updateStatus(item.id,'archived')}catch(e){status.textContent=e.message;b.disabled=false}
   },'warn'));
   card.append(actions,panel);root.appendChild(card);
  }
 }catch(e){status.textContent=e.message||'Cannot load private link review queue';root.textContent='The owner must be signed in through Cloudflare Access.'}
}
$('refresh').addEventListener('click',load);
load();
})();