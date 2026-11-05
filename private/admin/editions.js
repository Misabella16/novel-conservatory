(()=>{'use strict';
const $=id=>document.getElementById(id),MATCH=window.ConservatoryEPUBMatch,norm=MATCH.norm;
let books=[],titleMap=new Map(),files=[],rows=[],inventory=new Map(),busy=false,stop=false,approved=false;
const fmt=n=>n>=1073741824?(n/1073741824).toFixed(2)+' GiB':(n/1048576).toFixed(1)+' MiB';
const text=(t,err=false)=>{$('status').textContent=t;$('status').className='topmsg'+(err?' error':'')};
const bookLabel=b=>`${b.title} (#${b.id})`;
const json=async(r)=>{const j=await r.json().catch(()=>({error:'Unexpected server response'}));if(!r.ok)throw Error(j.error||`Request failed (${r.status})`);return j};
function idFor(x){const s=String(x||'').trim(),found=/\(#(\d+)\)$/.exec(s);if(found&&books.some(b=>b.id===+found[1]))return +found[1];if(/^#\d+$/.test(s)&&books.some(b=>b.id===+s.slice(1)))return +s.slice(1);const matches=titleMap.get(norm(s))||[];return matches.length===1?matches[0]:null;}
function addBook(b){
 if(books.some(x=>Number(x.id)===Number(b.id)))return;
 books.push(b);
 for(const name of [b.title,b.originalTitle]){
  const k=norm(name);if(!k)continue;const existing=titleMap.get(k)||[];
  if(!existing.includes(b.id))existing.push(b.id);
  titleMap.set(k,existing);
 }
 const o=document.createElement('option');o.value=bookLabel(b);$('novel-choices').append(o);
}
async function ensureBook(r){
 if(r.bookId)return r.bookId;
 if(r.matchKind!=='new'||!r.newTitle)throw Error(r.reason||'Choose a title for this EPUB');
 const b=MATCH.createPayload({title:r.newTitle},r.meta||{});
 // The server checks all 962 original novels and added records again,
 // so a simultaneous submission cannot silently create an extra copy.
 const j=await json(await fetch('/api/admin/additional/create',{method:'POST',
  credentials:'same-origin',headers:{'content-type':'application/json'},
  body:JSON.stringify({...b,publish:false})}));
 if(!j.id)throw Error(j.error||'Could not create a private novel');
 r.bookId=Number(j.id);r.wasCreatedPrivate=!j.reused;
 r.matchKind='matched';r.reason=j.reused?'Matched an existing novel on save':'Created a private catalogue entry';
 addBook({id:r.bookId,title:r.newTitle,author:r.meta?.author||'',originalTitle:''});
 return r.bookId;
}
async function init(){try{
 const me=await json(await fetch('/api/me',{cache:'no-store'}));if(me.role!=='owner')throw Error('Only the library owner can upload EPUBs.');
 approved=true;
 const [cat,content,inventoryData]=await Promise.all([json(await fetch('/api/catalogue',{cache:'no-store'})),json(await fetch('/api/content',{cache:'no-store'})),json(await fetch('/api/private/edition/inventory',{cache:'no-store'}))]);
 const list=Array.isArray(cat)?cat:(cat.books||[]),edits=new Map((content.edits||[]).map(x=>[x.id,x.patch]));
 books=list.map(b=>({...b,...(edits.get(b.id)||{})}));
 for(const b of books){for(const name of [b.title,b.originalTitle]){const k=norm(name);if(!k)continue;const v=titleMap.get(k)||[];if(!v.includes(b.id))v.push(b.id);titleMap.set(k,v);}const o=document.createElement('option');o.value=bookLabel(b);$('novel-choices').append(o);}
 for(const e of inventoryData.editions||[]){const x=inventory.get(e.id)||[];x.push(e);inventory.set(e.id,x);}
 text(`Ready. ${books.length} existing novels, ${inventoryData.editions?.length||0} newer EPUB editions on record.`);
}catch(e){text(e.message,true)}}
$('files').addEventListener('change',()=>{$('folder').value='';files=Array.from($('files').files);text(`${files.length} selected. Click Review & match files.`)});
$('folder').addEventListener('change',()=>{$('files').value='';files=Array.from($('folder').files).filter(f=>/\.epub$/i.test(f.name));text(`${files.length} EPUBs selected from folder.`)});
function rowState(r){if(r.done)return 'Uploaded';if(r.error)return r.error;if(!r.bookId&&r.matchKind==='ambiguous')return r.reason||'Choose a matching novel';if(!r.bookId&&r.matchKind==='new')return 'Ready · create private novel';if(!r.bookId)return 'No reliable title';const other=rows.find(x=>x!==r&&x.bookId===r.bookId&&x.file.name===r.file.name&&x.file.size===r.file.size);if(other&&rows.indexOf(other)<rows.indexOf(r))return 'Duplicate in batch';if($('skip').checked&&(inventory.get(r.bookId)||[]).some(x=>x.filename===r.file.name&&x.bytes===r.file.size))return 'Already uploaded (skip)';return 'Ready';}
function draw(){const parent=$('rows');parent.replaceChildren();let ready=0,done=0;
 for(const r of rows){const tr=document.createElement('tr'),a=document.createElement('td'),b=document.createElement('td'),c=document.createElement('td'),d=document.createElement('td');
  const bold=document.createElement('strong');bold.textContent=r.file.name;a.append(bold);const sub=document.createElement('small');sub.style.display='block';sub.textContent=fmt(r.file.size)+(r.detected?' · title: '+r.detected:'');a.append(sub);
  const title=document.createElement('input');title.setAttribute('list','novel-choices');title.value=r.bookId?bookLabel(books.find(x=>x.id===r.bookId)):r.newTitle||'';
  title.placeholder='Auto-matched or new novel title';
  title.setAttribute('aria-label','Novel for '+r.file.name);
  title.addEventListener('change',()=>{
   const id=idFor(title.value);
   if(id){r.bookId=id;r.matchKind='matched';r.reason='Selected existing novel'}
   else if(r.matchKind==='new'&&title.value.trim().length>2){
    r.newTitle=title.value.trim().slice(0,210);
    r.reason='New private novel: '+r.newTitle;
   }else if(!id){r.bookId=null;r.matchKind='ambiguous';r.reason='Choose an existing title or correct the EPUB metadata'}
   draw();
  });b.append(title);
  if(r.matchKind==='new'){const note=document.createElement('small');note.textContent='Will create privately when uploading';note.style.display='block';b.append(note)}
  const label=document.createElement('input');label.value=r.label;label.placeholder='e.g., Fan translation v2';label.setAttribute('aria-label','Edition label');label.addEventListener('input',()=>{r.label=label.value});c.append(label);
  const trans=document.createElement('input');trans.value=r.translator;trans.placeholder='Translator / group';trans.setAttribute('aria-label','Translator');trans.style.marginTop='5px';trans.addEventListener('input',()=>{r.translator=trans.value});c.append(trans);
  const status=rowState(r);d.textContent=status;d.className=r.done?'done':r.error?'error':status==='Ready'?'done':'pending';if(status==='Ready'||status==='Ready · create private novel')ready++;if(r.done)done++;
  tr.append(a,b,c,d);parent.append(tr);
 }
 $('counts').textContent=`${rows.length} selected · ${ready} ready · ${done} uploaded`; $('start').disabled=!approved||busy||!ready;}
$('scan').addEventListener('click',async()=>{if(busy||!approved)return;if(files.length>5000)return text('Limit 5,000 EPUBs in one browser selection. Import more in another batch.',true);
 busy=true;$('scan').disabled=true;rows=[];text(`Inspecting ${files.length} file(s)…`);try{
  for(let i=0;i<files.length;i++){const file=files[i];if(!/\.epub$/i.test(file.name))continue;
    const meta=await MATCH.inspect(file),match=MATCH.resolve(file,meta,books);
    const suffix=file.name.replace(/\.epub$/i,'').split(/\s+[-–—]\s+/).slice(1).join(' - ');
    rows.push({file,detected:meta.title,meta,matchKind:match.kind,bookId:match.bookId,
      newTitle:match.kind==='new'?match.title:'',reason:match.reason,
      label:suffix||'Translation edition',translator:suffix||meta.author||'',
      done:false,error:file.size>2147483648?'Exceeds 2 GiB':file.size<100?'File is too small':''});
    if(i%10===0){$('counts').textContent=`Inspected ${i+1} of ${files.length}`;await new Promise(resolve=>setTimeout(resolve,0));}
  }
  text(`Matched EPUB titles automatically. ${rows.filter(r=>r.matchKind==='new').length} missing books will be created privately; ${rows.filter(r=>r.matchKind==='ambiguous').length} ambiguous titles need a choice.`);
 }catch(e){text(e.message,true)}finally{busy=false;$('scan').disabled=false;draw()}});
$('skip').addEventListener('change',draw);
async function uploadEdition(r,onProgress){
 const key=`conservatory-mpu:${r.bookId}:${r.file.name}:${r.file.size}`;let sessionId=localStorage.getItem(key)||'',completed=new Set(),partSize=8*1048576;
 if(sessionId){try{const info=await json(await fetch('/api/private/edition/resume?session='+encodeURIComponent(sessionId),{cache:'no-store'}));if(info.session.novel_id!==r.bookId||info.session.bytes!==r.file.size||info.session.filename!==r.file.name)throw Error('Changed match');completed=new Set(info.uploadedParts||[]);partSize=info.partSize;}catch{sessionId='';localStorage.removeItem(key);}}
 if(!sessionId){const j=await json(await fetch('/api/private/edition/start',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({novelId:r.bookId,size:r.file.size,filename:r.file.name,label:r.label||'Translation edition',translator:r.translator,language:'English'})}));sessionId=j.sessionId;partSize=j.partSize;localStorage.setItem(key,sessionId);}
 const total=Math.ceil(r.file.size/partSize);
 for(let n=1;n<=total;n++){if(completed.has(n)){onProgress(n/total);continue;}
   const chunk=r.file.slice((n-1)*partSize,Math.min(n*partSize,r.file.size));let err;
   for(let attempt=0;attempt<3;attempt++){try{await json(await fetch('/api/private/edition/part?session='+sessionId+'&part='+n,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/octet-stream'},body:chunk}));err=null;break;}catch(e){err=e;await new Promise(res=>setTimeout(res,400*(attempt+1)))}}
   if(err)throw err;onProgress(n/total);
 }
 const result=await json(await fetch('/api/private/edition/finish?session='+sessionId,{method:'POST',credentials:'same-origin'}));localStorage.removeItem(key);return result.edition;
}

async function tryAutoCover(r){
  if(!window.CoverExtractor)return {published:false,detail:'Cover extractor unavailable'};
  const result=await CoverExtractor.detectCover(r.file);
  if(!result.image)return {published:false,detail:result.reason||'No cover found'};
  const data=new FormData();data.set('novel_id',String(r.bookId));data.set('source',r.file.name.slice(0,125));data.set('image',new File([result.image],'epub-cover.jpg',{type:'image/jpeg'}));
  // Never publish artwork from a private-only, automatically created novel.
  const endpoint=r.wasCreatedPrivate?'/api/admin/additional/auto-cover':'/api/admin/epub-artwork/auto';
  const response=await fetch(endpoint,{method:'POST',body:data,credentials:'same-origin'});
  const j=await response.json().catch(()=>({}));if(!response.ok)return {published:false,detail:j.error||'Cover publishing failed'};
  return {published:!!j.published,detail:j.published?(j.privateSynced?'Cover published':'Cover published; check private catalogue synchronization'):j.skipped?'Cover saved as alternative (existing cover retained)':'Cover stored'};
}
$('start').addEventListener('click',async()=>{if(busy||!approved)return;const work=rows.filter(r=>['Ready','Ready · create private novel'].includes(rowState(r)));if(!work.length)return;
 
 busy=true;stop=false;$('start').disabled=true;$('scan').disabled=true;$('stop').disabled=false;let success=0,failed=0,covers=0,coverNotes=[];
 for(let i=0;i<work.length;i++){if(stop)break;const r=work[i];if(!['Ready','Ready · create private novel'].includes(rowState(r)))continue;
  text(`Uploading ${i+1}/${work.length}: ${r.file.name}`);
  try{await ensureBook(r);if(rowState(r)!=='Ready')continue;const entry=await uploadEdition(r,p=>{$('progress').value=Math.round((i+p)/work.length*100);$('counts').textContent=`File ${i+1}/${work.length}: ${Math.round(p*100)}% · ${success} saved · ${failed} failed`;});
   r.done=true;const x=inventory.get(r.bookId)||[];x.push({filename:r.file.name,bytes:r.file.size,editionId:entry.id});inventory.set(r.bookId,x);success++;
   try{const art=await tryAutoCover(r);if(art.published)covers++;else if(coverNotes.length<12)coverNotes.push(r.file.name+': '+art.detail)}catch(e){if(coverNotes.length<12)coverNotes.push(r.file.name+': '+e.message)}
  }catch(e){r.error=String(e.message||e).slice(0,180);failed++;}
  draw();
 }
 busy=false;$('scan').disabled=false;$('stop').disabled=true;
 text(`${success} EPUB editions uploaded to private storage; ${failed} failed; ${covers} covers processed. ${coverNotes.length?'Other covers retained, unavailable, or skipped: '+coverNotes.slice(0,3).join('; '):''} ${stop?'Paused after current file. Re-select files to resume.':''}`,failed>0);draw();
});
$('stop').addEventListener('click',()=>{stop=true;text('Stopping after the current EPUB finishes…')});
$('lookup-btn').addEventListener('click',async()=>{const id=idFor($('lookup').value);if(!id)return text('Choose an existing novel.',true);try{
 const data=await json(await fetch('/api/private/edition/list?id='+id,{cache:'no-store'}));const box=$('editions');box.replaceChildren();if(!data.editions.length){box.textContent='No private editions stored.';return;}
 for(const e of data.editions){const p=document.createElement('p'),link=document.createElement('a');link.href='/read/?id='+id+'&edition='+encodeURIComponent(e.id);link.textContent=e.label+(e.translator?' · '+e.translator:'')+' · '+e.filename+' ('+fmt(e.size)+')';p.append(link);
 if(!e.legacy){const del=document.createElement('button');del.textContent='Remove edition';del.className='secondary';del.style.marginLeft='12px';del.addEventListener('click',async()=>{if(!confirm('Permanently delete '+e.filename+' from private storage?'))return;del.disabled=true;try{await json(await fetch('/api/private/edition/remove',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({novelId:id,editionId:e.id})}));p.remove();inventory.set(id,(inventory.get(id)||[]).filter(x=>x.editionId!==e.id));text('Deleted edition. Other translations are unchanged.')}catch(err){text(err.message,true);del.disabled=false}});p.append(del)}box.append(p)}
 }catch(e){text(e.message,true)}});
init();})();
