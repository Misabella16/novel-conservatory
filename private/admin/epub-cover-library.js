/* Private EPUB cover candidate library.
 * Extraction and private selection never write to COMMUNITY_DB or a public R2
 * bucket. Public sync is always owner-initiated with credit and rights. */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
let books=[],active=null,candidates=[],prepared=null,lastPrivateUndoId=null,lastPublicUndoId=null,owner=false;
const status=(id,message,error=false)=>{
 const el=$(id);el.textContent=message;el.style.color=error?'#a42e2b':'';
};
const api=async(url,options={})=>{
 const response=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||'Request failed ('+response.status+')');
 return data;
};
const post=(url,body)=>api(url,{
 method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
});
const currentId=()=>{
 const v=$('book').value.trim();
 const m=/^#?(\d{1,11})(?:\D|$)/.exec(v);
 if(m)return Number(m[1]);
 const low=v.toLocaleLowerCase();
 return books.find(x=>String(x.title||'').toLocaleLowerCase()===low)?.id||null;
};
function fileLabel(item){
 const edition=$('edition').querySelector('option[value="'+item.editionId+'"]');
 return edition?.textContent||item.source||'EPUB edition';
}
async function renderHistory(){
 const host=$('public-history');host.replaceChildren();
 $('undo-public').disabled=!lastPublicUndoId;
 if(!active)return;
 try{
  const result=await api('/api/admin/epub-cover-library/public-history?id='+encodeURIComponent(active));
  for(const item of result.history||[]){
   const line=document.createElement('p');line.textContent=
    (item.undoneAt?'Reverted: ':'Published: ')+item.createdAt+' · ';
   if(!item.undoneAt){
    const btn=document.createElement('button');btn.type='button';btn.className='secondary';
    btn.style.padding='5px 9px';btn.textContent='Undo this public cover sync';
    btn.addEventListener('click',()=>undoPublic(item.id));
    line.append(btn);
   }
   host.append(line);
  }
 }catch(e){host.textContent='Public sync history unavailable: '+e.message}
}
async function undoPublic(eventId){
 if(!eventId)return;
 const button=$('undo-public');button.disabled=true;
 status('public-status','Reversing the selected public cover change…');
 try{
  const changed=await post('/api/admin/epub-cover-library/undo-public',{eventId});
  if(lastPublicUndoId===eventId)lastPublicUndoId=null;
  status('public-status',changed.publicImageRetired?
   'Public cover reverted; the public image copy was retired. Your private candidates and EPUBs are unchanged.':
   'Public cover metadata reverted. Public image cleanup may need attention.');
  await renderHistory();
 }catch(error){status('public-status',error.message,true)}
 finally{button.disabled=!lastPublicUndoId}
}
async function refresh(){
 if(!active)return;
 const data=await api('/api/admin/epub-cover-library/list?id='+encodeURIComponent(active));
 candidates=data.candidates||[];
 const host=$('gallery');host.replaceChildren();
 if(!candidates.length){
  host.textContent='No extracted covers saved yet. Open “Enrich ALL stored EPUBs” to scan files already uploaded, or add a cover image below.';
 }else for(const item of candidates){
  const card=document.createElement('article');card.className='item';
  const selected=data.selectedCandidateId===item.id||data.selectedCover===item.url;
  if(selected)card.classList.add('selected');
  const img=document.createElement('img');img.src=item.url;img.alt='Extracted private cover from '+(item.source||'EPUB');
  img.loading='lazy';img.referrerPolicy='no-referrer';card.append(img);
  if(selected){
   const marked=document.createElement('p');marked.className='badge';marked.textContent='✓ Current private cover';
   card.append(marked);
  }
  const info=document.createElement('div');info.className='source';
  info.textContent=(item.source||'Extracted cover')+' · '+(fileLabel(item)||'');
  card.append(info);
  const choose=document.createElement('button');choose.type='button';choose.className='secondary';
  choose.textContent=selected?'Selected privately':'Use as my private cover';choose.disabled=selected;
  choose.addEventListener('click',async()=>{
   choose.disabled=true;
   try{
    const result=await post('/api/admin/epub-cover-library/select',{candidateId:item.id});
    lastPrivateUndoId=result.eventId||null;
    $('undo-private').disabled=!lastPrivateUndoId;
    status('status','Private cover set for novel #'+active+'. Nothing was published.');
    await refresh();
   }catch(error){status('status',error.message,true);choose.disabled=false}
  });
  card.append(choose);
  const share=document.createElement('button');share.className='secondary';share.type='button';
  share.textContent=prepared?.id===item.id?'Prepared for public sync':'Prepare public sync';
  share.addEventListener('click',()=>{
   prepared=item;$('publish-target').textContent='Selected: '+(item.source||'EPUB cover')+
    ' · novel #'+active+'. Public display requires confirmation and credit below.';
   $('publish').disabled=false;status('public-status','Private file remains private until you click Publish.');
   // Refresh just the button labels without discarding typed credit.
   for(const btn of host.querySelectorAll('[data-prepared-id]'))
    btn.textContent=btn.dataset.preparedId===item.id?'Prepared for public sync':'Prepare public sync';
  });
  share.dataset.preparedId=item.id;card.append(share);
  host.append(card);
 }
 await renderHistory();
}
async function show(){
 $('load').disabled=true;
 status('status','Loading the private cover gallery…');
 try{
  const id=currentId();
  if(!Number.isSafeInteger(id)||id<1||!books.some(x=>Number(x.id)===id))
   throw Error('Choose a novel from the list, or enter its #ID.');
  active=id;prepared=null;$('publish').disabled=true;
  $('publish-target').textContent='No cover chosen for public syncing.';
  lastPrivateUndoId=null;$('undo-private').disabled=true;
  const files=await api('/api/private/edition/list?id='+encodeURIComponent(id));
  const select=$('edition');select.replaceChildren();
  for(const item of files.editions||[]){
   const o=document.createElement('option');o.value=item.id;
   o.textContent=(item.label||'Translation edition')+' · '+(item.filename||'EPUB');
   select.append(o);
  }
  if(!select.options.length){
   const o=document.createElement('option');o.value='';o.textContent='No linked EPUB editions';select.append(o);
  }
  await refresh();
  status('status','Showing private cover candidates for novel #'+id+
   '. The EPUBs and candidate covers remain privately stored.');
 }catch(error){status('status',error.message,true)}
 finally{$('load').disabled=false}
}
async function optimizedJpeg(blob){
 const bitmap=await createImageBitmap(blob);
 try{
  const scale=Math.min(1,1800/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));
  canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext('2d');if(!ctx)throw Error('Image processing unavailable');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  for(const quality of [.84,.70,.53]){
   const result=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
   if(result&&result.size>=80&&result.size<=2800000)return result;
  }
  throw Error('Image is still larger than 2.8 MB after conversion');
 }finally{bitmap.close?.()}
}
async function saveCandidate(blob,source){
 if(!active)throw Error('Choose a novel first');
 const editionId=$('edition').value;
 if(!editionId)throw Error('Choose the edition to which this cover belongs');
 const image=await optimizedJpeg(blob);
 const form=new FormData();
 form.set('novelId',String(active));form.set('editionId',editionId);
 form.set('source',source.slice(0,160));
 form.set('image',new File([image],'extracted-cover.jpg',{type:'image/jpeg'}));
 const result=await api('/api/admin/epub-cover-library/upload',{method:'POST',body:form});
 status('upload-status',result.saved?'Saved a new private candidate. Nothing was published.':
  'That image already exists for this EPUB edition. No duplicate copy was needed.');
 await refresh();
}
$('image').addEventListener('change',async()=>{
 const file=$('image').files[0];
 if(!file)return;
 status('upload-status','Optimizing image for the private gallery…');
 try{await saveCandidate(file,file.name)}catch(error){status('upload-status',error.message,true)}
 finally{$('image').value=''}
});
$('epub').addEventListener('change',async()=>{
 const file=$('epub').files[0];
 if(!file)return;
 status('upload-status','Extracting a cover from the selected EPUB…');
 try{
  if(!window.CoverExtractor)throw Error('EPUB cover extractor was not loaded');
  const result=await CoverExtractor.detectCover(file);
  if(!result.image)throw Error(result.reason||'No embedded cover detected');
  await saveCandidate(result.image,file.name);
 }catch(error){status('upload-status',error.message,true)}
 finally{$('epub').value=''}
});
$('publish').addEventListener('click',async()=>{
 if(!prepared||!active)return;
 if(!$('rights').checked||$('artist-credit').value.trim().length<3)
  return status('public-status','Confirm public display permission and enter accurate artist/source credit.',true);
 const candidate=prepared;
 // A deliberate second confirmation prevents accidental publication.
 if(!confirm('Publish this approved JPEG cover to the PUBLIC Novel Conservatory? EPUB files remain private.'))return;
 const button=$('publish');button.disabled=true;
 status('public-status','Copying only the approved JPEG to public-safe artwork storage…');
 try{
  const result=await post('/api/admin/epub-cover-library/publish',{
   candidateId:candidate.id,artistCredit:$('artist-credit').value.trim(),rightsConfirmed:true
  });
  lastPublicUndoId=result.eventId;
  $('undo-public').disabled=!lastPublicUndoId;
  status('public-status','Cover published to the public catalogue for novel #'+result.novelId+
   '. Private EPUBs, artwork candidates, and other novels were not changed.');
  await renderHistory();
 }catch(error){status('public-status',error.message,true)}
 finally{button.disabled=false}
});
$('undo-public').addEventListener('click',()=>undoPublic(lastPublicUndoId));
$('undo-private').addEventListener('click',async()=>{
 if(!lastPrivateUndoId)return;
 const button=$('undo-private');button.disabled=true;
 try{
  await post('/api/admin/epub/undo-metadata',{eventId:lastPrivateUndoId});
  lastPrivateUndoId=null;
  await refresh();status('status','Private cover selection was undone. All extracted candidates remain saved.');
 }catch(error){status('status',error.message,true);button.disabled=false}
});
$('load').addEventListener('click',show);
$('book').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();show()}});
(async()=>{
 try{
  const me=await api('/api/me');
  if(me.role!=='owner')throw Error('The private cover gallery requires the library owner account.');
  owner=true;
  const [cat,content]=await Promise.all([api('/api/catalogue'),api('/api/content')]);
  const seen=new Set();
  books=[...(Array.isArray(cat)?cat:cat.books||[]),...(content.additional||[])].filter(x=>{
   const id=Number(x.id);if(!Number.isSafeInteger(id)||seen.has(id))return false;
   seen.add(id);return true;
  });
  for(const book of books){
   const option=document.createElement('option');
   option.value='#'+book.id+' · '+book.title;$('catalogue').append(option);
  }
  const target=Number(new URLSearchParams(location.search).get('novel'));
  if(Number.isSafeInteger(target)&&target>0&&books.some(x=>x.id===target)){
   $('book').value='#'+target;await show();
  }else status('status','Ready. Choose one of '+books.length+' catalogue novels.');
 }catch(error){status('status',error.message,true)}
})();
})();
