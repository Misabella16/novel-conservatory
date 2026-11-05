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

const IMPORT_FIELDS=[
 ['synopsis','Synopsis'],
 ['genres','Genres'],
 ['tags','Story tags'],
 ['author','Author'],
 ['originalTitle','Original title']
];
const shortValue=(v,max=650)=>Array.isArray(v)?v.join(', '):String(v||'').slice(0,max);
function paragraph(parent,textValue,cls='small'){
 const p=document.createElement('p');p.className=cls;p.textContent=textValue;parent.appendChild(p);return p;
}
function renderSourceDetails(parent,meta,url){
 details(parent,'Original NU title',meta.title||'Unknown');
 details(parent,'Source author',meta.author);
 details(parent,'Original title',meta.originalTitle);
 details(parent,'Genres',shortValue(meta.genres));
 details(parent,'Tags',shortValue(meta.tags));
 if(meta.coverUrl){
  try{
   const sourceCover=new URL(meta.coverUrl);
   if(sourceCover.protocol==='https:'&&!sourceCover.username&&!sourceCover.password){
    const linkRow=document.createElement('p');linkRow.className='small';
    link(linkRow,'View cover referenced on Novel Updates ↗',sourceCover.href);parent.appendChild(linkRow);
    paragraph(parent,'Cover reference only: verify the original artist, image permission and credit through the separate cover-image review workflow before publishing artwork.','small');
   }
  }catch{}
 }
 if(meta.synopsis){const title=document.createElement('strong');title.textContent='Retrieved synopsis';parent.appendChild(title);
  paragraph(parent,String(meta.synopsis).slice(0,6000),'summary')}
 paragraph(parent,'Metadata source: '+url,'small');
}
async function showStaged(item,url,bookId,bookTitle,panel){
 const response=await api('/api/admin/nu/staged-by-url?url='+encodeURIComponent(url));
 const meta=response.metadata;
 if(!meta||typeof meta!=='object'||!meta.title)throw Error('The captured source has no title');
 panel.replaceChildren();
 const head=document.createElement('h3');head.textContent='Source metadata retrieved · not yet applied';panel.appendChild(head);
 renderSourceDetails(panel,meta,url);
 if(!bookId){
  paragraph(panel,'This suggestion is for a new series. The Novel Updates information has been staged privately and must still be reviewed and published through the main NU staging dashboard.');
  link(panel,'Review staged series ↗','/admin/novel-updates.html');
  return;
 }
 const notice=paragraph(panel,'Destination: '+bookTitle+' · Catalogue #'+bookId+'. Compare its identity with the Novel Updates source title above. Import defaults to filling missing metadata only.','small');
 notice.classList.add('source-destination');
 const form=document.createElement('div');form.className='import-fields';
 const title=document.createElement('h4');title.textContent='Choose which source fields to import';form.appendChild(title);
 const choices=[];
 for(const [key,label] of IMPORT_FIELDS){
  const value=meta[key],available=Array.isArray(value)?value.length>0:!!String(value||'').trim();
  const box=document.createElement('label');box.className='import-check';
  const input=document.createElement('input');input.type='checkbox';input.checked=available;input.disabled=!available;
  const labelSpan=document.createElement('span');labelSpan.textContent=label+(available?' · '+shortValue(value,90):' (missing at source)');
  box.append(input,labelSpan);form.appendChild(box);choices.push([key,input]);
 }
 const label=document.createElement('label');label.className='import-check';
 const replace=document.createElement('input');replace.type='checkbox';
 const words=document.createElement('span');words.textContent='Replace existing metadata for checked fields (normally, only blanks are filled)';
 label.append(replace,words);form.appendChild(label);
 paragraph(form,'Title, cover art, translator links and translation status will not be overwritten. A source URL alone does not prove the synopsis and tags are available.','small');
 const buttonRow=document.createElement('div');buttonRow.className='actions';
 const apply=button('✓ Review & import selected fields',async btn=>{
  const fields=choices.filter(([,el])=>el.checked).map(([name])=>name);
  if(!fields.length){paragraph(form,'Select at least one field.','small');return}
  const sourceTitle=String(meta.title||''),matched=sourceTitle.trim().toLocaleLowerCase()===String(bookTitle||'').trim().toLocaleLowerCase();
  const identification=matched?'':'\nWarning: the source title differs from the catalogue title. Confirm that they are the same work.';
  if(!confirm('Import retrieved Novel Updates information into '+bookTitle+' (#'+bookId+')?'+identification+
    '\n\nFields: '+fields.join(', ')+(replace.checked?'\nExisting metadata in those fields WILL be replaced.':'\nOnly fields currently missing data will be filled.')+
    '\n\nThis will update the public catalogue after confirmation.'))return;
  btn.disabled=true;
  const send=async replaceExisting=>api('/api/admin/nu/import-submitted-metadata',{
   method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({submissionId:item.id,confirm:true,fields,replaceFields:replace.checked,replaceExisting})
  });
  try{
   let result;
   try{result=await send(false)}catch(error){
    if(!String(error.message||'').includes('already has a Novel Updates link'))throw error;
    if(!confirm('This novel already has a different Novel Updates link. Replace that link as part of the metadata import?'))return;
    result=await send(true);
   }
   await load();
   status.textContent='Imported source metadata into '+bookTitle+' (#'+bookId+'). Applied: '+(result.appliedFields||[]).join(', ')+
    '. Skipped: '+(result.skipped||[]).join('; ')+(result.privateSynced===false?'. Public updated; private sync needs review.':'. Shared catalogue updated.');
  }catch(error){paragraph(form,'Import failed: '+error.message,'small')}
  finally{btn.disabled=false}
 },'');
 buttonRow.appendChild(apply);
 form.appendChild(buttonRow);panel.appendChild(form);
}
function showCaptureFallback(item,url,bookId,bookTitle,panel,why){
 const box=document.createElement('section');box.className='capture-fallback';
 paragraph(box,why,'small');
 paragraph(box,'Novel Updates may block server requests (403 / 429). Open the series page in your own browser, use the existing Capture Novel Updates bookmarklet, and paste the copied JSON below. Never copy cookies or account data.');
 const p=document.createElement('p');
 link(p,'Open original NU page ↗',url);p.append(' · ');link(p,'Get Capture Novel Updates bookmarklet ↗','/admin/novel-updates.html');
 box.appendChild(p);
 const label=document.createElement('label');label.textContent='Paste browser-captured Novel Updates JSON';
 const textarea=document.createElement('textarea');textarea.rows=4;textarea.maxLength=15000;
 textarea.placeholder='{"source":"novelupdates-browser-v1","novel":{...}}';label.appendChild(textarea);box.appendChild(label);
 const row=document.createElement('div');row.className='actions';
 row.appendChild(button('Use captured metadata',async btn=>{
  btn.disabled=true;
  try{
   const obj=JSON.parse(textarea.value.trim());
   if(obj.source!=='novelupdates-browser-v1'||typeof obj.novel!=='object'||!obj.novel)
    throw Error('Use the Capture Novel Updates bookmarklet JSON.');
   const captured=escNU(obj.novel.nuUrl);
   if(!captured||captured!==url)throw Error('Captured source must match the submitted Novel Updates URL.');
   await api('/api/admin/nu/stage-browser',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(obj)});
   await showStaged(item,url,bookId,bookTitle,panel);
  }catch(error){paragraph(box,'Could not stage captured metadata: '+error.message,'small')}
  finally{btn.disabled=false}
 },''));
 row.appendChild(button('Load previously captured metadata',async btn=>{
  btn.disabled=true;
  try{await showStaged(item,url,bookId,bookTitle,panel)}
  catch(error){paragraph(box,'No usable staged metadata yet: '+error.message,'small')}
  finally{btn.disabled=false}
 }));
 box.appendChild(row);panel.appendChild(box);
}
async function fetchSource(item,url,panel,actions,trigger,bookId,bookTitle){
 trigger.disabled=true;panel.replaceChildren();panel.hidden=false;
 paragraph(panel,'Retrieving the original Novel Updates synopsis, genres and tags…','small');
 try{
  const result=await api('/api/admin/nu/lookup?url='+encodeURIComponent(url));
  const novel=parseNU(result.html,url);
  if(!novel.title||(!novel.synopsis&&!novel.genres.length&&!novel.tags.length))
   throw Error('The source page did not contain enough readable metadata.');
  try{
   await api('/api/admin/nu/stage-browser',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({source:'novelupdates-browser-v1',novel})
   });
  }catch(error){
   // Published/locked drafts cannot be replaced; show their existing source
   // data if it is already available.
   await showStaged(item,url,bookId,bookTitle,panel);
   paragraph(panel,'The previous source capture is protected; its staged version was used.','small');
   return;
  }
  await showStaged(item,url,bookId,bookTitle,panel);
 }catch(error){
  try{
   await showStaged(item,url,bookId,bookTitle,panel);
   paragraph(panel,'The direct lookup was unavailable; showing previously captured Novel Updates data.','small');
  }catch{
   panel.replaceChildren();showCaptureFallback(item,url,bookId,bookTitle,panel,
    'Automatic retrieval was unavailable: '+(error.message||'Source did not respond')+'. No metadata has been invented or published.');
  }
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
   if(url)actions.appendChild(button('Retrieve & preview NU metadata',b=>fetchSource(item,url,panel,actions,b,bookId,bookTitle),''));
   if(url)actions.appendChild(button('Load staged / browser-captured NU data',async b=>{b.disabled=true;panel.hidden=false;try{await showStaged(item,url,bookId,bookTitle,panel)}catch(err){panel.replaceChildren();showCaptureFallback(item,url,bookId,bookTitle,panel,'No captured source information is available yet. '+err.message)}finally{b.disabled=false}}));
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