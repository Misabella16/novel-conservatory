// My Library Phase 2 UI: no sample records, no local storage for private data.
// All real writes go to the owner-authenticated, same-origin /api routes.
'use strict';
const state = {
  books:[], total:0, selectedId:null, detail:null, query:'', offset:0,
  busy:false, activeEdition:null, urls:[], refreshToken:0
};
const $ = s => document.querySelector(s);
const safe = x => String(x??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'' :'&#39;'}[ch]));
const safeId = x => /^[0-9a-f-]{36}$/i.test(x||'') ? x : '';
const statuses = {unread:'Want to read',reading:'Reading',read:'Read',paused:'Paused',dnf:'Did not finish'};
const label = (value,defaultText='Not set') => safe(value||defaultText);
const options = (values,value) => values.map(([id,text])=>'<option value="'+safe(id)+'" '+(id===value?'selected':'')+'>'+safe(text)+'</option>').join('');
const bookCover = (title,imgId='') => '<div class="book-cover"><b>'+safe(title)+'</b>'+(safeId(imgId)?'<img loading="lazy" src="/api/images/'+imgId+'" alt="Cover of '+safe(title)+'">':'')+'</div>';
const bookTags = tags => (tags||[]).map(t=>'<span class="badge">'+safe(t.label)+' <button class="tag-remove" type="button" data-remove-tag="'+safe(t.id)+'" aria-label="Remove '+safe(t.label)+'">×</button></span>').join('');
const isbnMaybe = s => s?'<span class="muted">ISBN '+safe(s)+'</span>':'';
function showMessage(msg,isError=false){
  const n=$('#notice');n.hidden=false;n.textContent=msg;n.classList.toggle('error',isError);
  n.scrollIntoView({block:'nearest',behavior:'smooth'});
}
async function api(path,{method='GET',data,raw,contentType}={}){
  const opts={method,credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'}};
  if(raw){opts.headers['content-type']=contentType;opts.body=raw;}
  else if(data!==undefined){opts.headers['content-type']='application/json';opts.body=JSON.stringify(data);}
  const response=await fetch(path,opts);
  let payload;
  try {payload=await response.json();}catch {payload={error:'The private server sent an unexpected response.'};}
  if(!response.ok) {
    const err=new Error(payload.error||'Request failed');
    err.status=response.status;err.payload=payload;throw err;
  }
  return payload;
}
function formValue(form,name){return (new FormData(form).get(name)||'').toString();}
function setBusy(button,busy){
  if(!button) return;
  if(busy) {button.dataset.oldText=button.textContent;button.disabled=true;button.textContent='Saving…';}
  else {button.disabled=false;button.textContent=button.dataset.oldText||'Save';}
}
async function perform(button,work,success='Saved'){
  if(button?.disabled) return;
  setBusy(button,true);
  try {await work();showMessage(success);}
  catch(e){showMessage(e.message||'Save failed',true);if(e.status===409&&state.selectedId) await selectBook(state.selectedId);}
  finally{setBusy(button,false);}
}
function currentCover(book) {
  const img=book?.editions?.flatMap(e=>e.images||[]).find(i=>i.display_cover);
  return img?.id||null;
}
function renderGrid(){
  const grid=$('#book-grid');
  const books=state.books;
  $('#count').textContent=state.total+' '+(state.total===1?'book':'books')+(state.query?' matching “'+state.query+'”':'');
  if(!books.length){
    grid.innerHTML='<div class="empty"><h3>'+(state.query?'No matching titles':'Your library is ready')+'</h3><p>'+(state.query?'Try another search.':'Add your first book, then give it editions, copies, tags and private notes.')+'</p></div>';
  } else {
    grid.innerHTML=books.map(b=>'<button class="book-card '+(state.selectedId===b.id?'selected':'')+'" type="button" data-select-book="'+safe(b.id)+'">'+
      bookCover(b.title,b.cover_id)+'<div class="book-data"><strong>'+safe(b.title)+'</strong><small>'+label(b.author,'Unknown author')+'</small><br><span class="badge">'+(statuses[b.reading_status]||'Unread')+'</span></div></button>').join('');
  }
  $('#load-more').hidden=state.books.length>=state.total;
}
async function listBooks({append=false}={}){
  const token=++state.refreshToken;
  const offset=append?state.books.length:0;
  const q=new URLSearchParams({q:state.query,offset:String(offset),limit:'60'});
  const result=await api('/api/books?'+q);
  if(token!==state.refreshToken) return;
  state.total=result.total ?? result.books?.length ?? 0;
  state.books=append?[...state.books,...(result.books||[])]:result.books||[];
  renderGrid();
  // Keep an open book's detail page visible even when a search or pagination
  // moves its card out of the current result window.
}
async function selectBook(id){
  if(!safeId(id)) return;
  const result=await api('/api/books/'+id);
  state.selectedId=id;state.detail=result.book;renderGrid();renderDetail();
}
function editionBlock(e){
  const imgCover=(e.images||[]).find(i=>i.display_cover);
  const copyRows=(e.copies||[]).map(c=>'<div class="copy-box"><details class="collapse">'+
    '<summary>'+safe(c.medium==='digital'?'Digital':'Physical')+' copy · '+safe(c.ownership)+
      (c.signature!=='unsigned'?' · '+safe(c.signature.replace(/_/g,' ')):'')+(c.is_arc?' · ARC':'')+'</summary>'+
    '<p class="copy-info">Location: '+safe([c.room,c.bookcase,c.shelf,c.shelf_position].filter(Boolean).join(' → ')||'Not assigned')+'</p>'+
    '<details class="collapse"><summary>Physical location & copy notes</summary><p class="detail-text">'+safe(c.notes||'No copy-specific notes yet.')+'</p></details>'+
    '<details class="collapse"><summary>Edit this copy</summary><form class="edit-form" data-form="edit-copy" data-id="'+safe(c.id)+'">'+
      '<div class="two-columns">'+
      '<label>Medium<select name="medium">'+options([['physical','Physical'],['digital','Digital']],c.medium)+'</select></label>'+
      '<label>Ownership<select name="ownership">'+options([['owned','Owned'],['preordered','Preordered'],['wishlist','Wishlist'],['borrowed','Borrowed'],['sold','Sold'],['donated','Donated']],c.ownership)+'</select></label>'+
      '<label>Signature<select name="signature">'+options([['unsigned','Unsigned'],['signed','Signed'],['personalized','Personalized'],['signed_bookplate','Signed bookplate']],c.signature)+'</select></label>'+
      '<label class="check"><input type="checkbox" name="is_arc" '+(c.is_arc?'checked':'')+'> ARC / advance reader copy</label>'+
      '<label>Room<input name="room" value="'+safe(c.room)+'"></label>'+
      '<label>Bookcase<input name="bookcase" value="'+safe(c.bookcase)+'"></label>'+
      '<label>Shelf<input name="shelf" value="'+safe(c.shelf)+'"></label>'+
      '<label>Position<input name="shelf_position" value="'+safe(c.shelf_position)+'"></label>'+
      '</div><label>Copy notes<textarea name="notes" rows="3">'+safe(c.notes)+'</textarea></label>'+
      '<div class="actions"><button class="btn mini" type="submit">Save copy</button></div></form></details>'+
    '</details></div>').join('');
  const thumbnails=(e.images||[]).filter(i=>safeId(i.id)).map(i=>'<div class="cover-thumb"><img loading="lazy" src="/api/images/'+safe(i.id)+'" alt="'+safe(i.role||'Edition image')+'">'+
    '<span>'+safe(i.role)+' '+(i.display_cover?'· Displayed':'')+'</span>'+
    (!i.display_cover?'<button class="btn mini subtle" type="button" data-display-cover="'+safe(i.id)+'" data-edition-id="'+safe(e.id)+'">Use cover</button>':'')+'</div>').join('');
  return '<div class="nested"><details class="collapse"><summary>'+safe(e.edition_name)+
    (e.is_special?' <span class="badge special">Special edition</span>':'')+' <span class="muted">('+e.copies.length+' copies)</span></summary>'+
    '<p class="muted">'+label(e.vendor||e.publisher,'Publisher not listed')+' · '+safe(e.format)+
    (e.isbn?' · '+isbnMaybe(e.isbn):'')+'</p>'+
    (e.details?'<p class="detail-text">'+safe(e.details)+'</p>':'')+
    '<div class="edition-actions"><button class="btn mini" type="button" data-add-copy="'+safe(e.id)+'">+ Add copy</button></div>'+
    '<details class="collapse"><summary>Edition information</summary><form class="edit-form" data-form="edit-edition" data-id="'+safe(e.id)+'">'+
      '<label>Edition name<input name="edition_name" value="'+safe(e.edition_name)+'" required></label>'+
      '<div class="two-columns"><label>Publisher<input name="publisher" value="'+safe(e.publisher)+'"></label><label>Vendor<input name="vendor" value="'+safe(e.vendor)+'"></label></div>'+
      '<label>ISBN<input name="isbn" value="'+safe(e.isbn)+'"></label>'+
      '<label>Format<select name="format">'+options([['hardcover','Hardcover'],['paperback','Paperback'],['ebook','Ebook'],['audiobook','Audiobook'],['other','Other']],e.format)+'</select></label>'+
      '<label class="check"><input type="checkbox" name="is_special" '+(e.is_special?'checked':'')+'> Special edition</label>'+
      '<label>Details<textarea name="details" rows="3">'+safe(e.details)+'</textarea></label>'+
      '<div class="actions"><button class="btn mini" type="submit">Save edition</button></div></form></details>'+
    '<details class="collapse"><summary>Edition covers '+(imgCover?'· Selected':'')+'</summary>'+
      '<p class="muted">Upload a cover from your collection. Automatic edition-cover retrieval is planned for Phase 5.</p>'+
      (thumbnails?'<div class="cover-thumbs">'+thumbnails+'</div>':'<p class="muted">No cover images yet.</p>')+
      '<label class="upload">Upload cover (JPG, PNG or WebP; max 8 MB)<input type="file" accept="image/jpeg,image/png,image/webp" data-upload-cover="'+safe(e.id)+'"></label></details>'+
    '<h4>My copies</h4>'+(copyRows||'<p class="muted">No owned copies recorded. Add one above.</p>')+
    '</details></div>';
}
function renderDetail(){
  const target=$('#book-detail'), b=state.detail;
  if(!b){target.innerHTML='<div class="empty"><h3>Choose a book</h3><p>Its synopsis, tags, editions, shelf locations and your private notes will appear here.</p></div>';return;}
  const editionContent=(b.editions||[]).map(editionBlock).join('');
  const genreTags=bookTags(b.tags), shelves=(b.shelves||[]).map(s=>'<span class="badge">'+safe(s.name)+
    '<button class="tag-remove" type="button" data-remove-shelf="'+safe(s.id)+'" aria-label="Remove shelf '+safe(s.name)+'">×</button></span>').join('');
  target.innerHTML='<div class="detail-head">'+bookCover(b.title,currentCover(b))+
    '<div><h2 class="detail-title">'+safe(b.title)+'</h2><div class="byline">'+label(b.author,'Unknown author')+'</div>'+
      '<div class="badges"><span class="badge">'+(statuses[b.reading_status]||'Unread')+'</span>'+
      (b.rating!==null&&b.rating!==undefined?'<span class="badge">'+safe(b.rating)+' ★</span>':'')+
      '</div></div></div>'+
    '<section class="detail-section"><h3>Synopsis</h3><p class="detail-text">'+safe(b.synopsis||'No synopsis added yet.')+'</p></section>'+
    '<section class="detail-section"><h3>Genres & Tags</h3><div class="tag-row">'+(genreTags||'<span class="muted">No tags yet.</span>')+'</div>'+
      '<form class="inline-form" data-form="add-tag"><input name="label" placeholder="Add tag" required maxlength="90" aria-label="New tag"><select name="kind" aria-label="Tag type"><option value="personal">My tag</option><option value="genre">Genre</option></select><button class="btn mini" type="submit">Add</button></form></section>'+
    '<section class="detail-section"><h3>My shelves</h3><div class="tag-row">'+(shelves||'<span class="muted">No personal shelves yet.</span>')+'</div>'+
      '<form class="inline-form" data-form="add-shelf"><input name="name" placeholder="Add reading shelf" required maxlength="100" aria-label="New shelf"><button class="btn mini" type="submit">Add shelf</button></form></section>'+
    '<div class="divider"></div>'+
    // Most important requirement: private notes are an always-visible, editable area ON the book page.
    '<section class="detail-section notes-panel"><h3>My Private Notes</h3><p>Your personal notes stay on this book page and are not shared with readers.</p>'+
      '<form data-form="notes"><label class="visually-hidden" for="book-notes">Private book notes</label>'+
      '<textarea id="book-notes" class="note-editor" name="private_notes" rows="6" maxlength="120000" placeholder="Thoughts, favorite moments, quotes, reminders, reading journal…">'+safe(b.private_notes)+'</textarea>'+
      '<div class="actions"><span class="small-status" id="notes-state">Only you can see these notes.</span><button class="btn mini" type="submit">Save notes</button></div></form></section>'+
    '<div class="divider"></div>'+
    '<details class="collapse"><summary>My Editions & Copies ('+(b.editions?.length||0)+' editions)</summary>'+
      '<div class="edition-actions"><button class="btn mini" type="button" id="add-edition">+ Add edition</button></div>'+
      (editionContent||'<p class="muted">Add a standard, digital, ARC or collector’s edition.</p>')+'</details>'+
    '<details class="collapse"><summary>My Review & Rating</summary>'+
      '<form class="edit-form" data-form="review"><label>Rating (0–5)<input type="number" step="0.5" min="0" max="5" name="rating" value="'+safe(b.rating??'')+'"></label>'+
      '<label>My review<textarea name="review" rows="5" maxlength="50000">'+safe(b.review)+'</textarea></label>'+
      '<div class="actions"><button class="btn mini" type="submit">Save review</button></div></form></details>'+
    '<details class="collapse"><summary>Edit book information</summary>'+
      '<form class="edit-form" data-form="edit-book"><label>Title<input name="title" value="'+safe(b.title)+'" required maxlength="300"></label>'+
      '<label>Author<input name="author" value="'+safe(b.author)+'" maxlength="400"></label>'+
      '<label>Synopsis<textarea name="synopsis" rows="5" maxlength="25000">'+safe(b.synopsis)+'</textarea></label>'+
      '<label>Reading status<select name="reading_status">'+options(Object.entries(statuses),b.reading_status)+'</select></label>'+
      '<div class="actions"><button class="btn mini" type="submit">Save book</button></div></form></details>';
}
async function refreshCurrent({list=true}={}){
  if(list) await listBooks();
  if(state.selectedId) await selectBook(state.selectedId);
}
function showDialog(id){
  const dlg=$('#'+id);
  if(typeof dlg.showModal==='function') dlg.showModal(); else dlg.setAttribute('open','');
}
async function submitForm(form,button){
  const mode=form.dataset.form, bookId=state.selectedId, detail=state.detail;
  if(!bookId||!detail) return;
  if(mode==='notes') return perform(button,async()=>{
    const newValue=formValue(form,'private_notes');
    const r=await api('/api/books/'+bookId,{method:'PATCH',data:{private_notes:newValue,expected_updated_at:detail.updated_at}});
    state.detail={...detail,...r.item};
    $('#notes-state').textContent='Saved just now';
    await listBooks();
  },'Book notes saved');
  if(mode==='review') return perform(button,async()=>{
    await api('/api/books/'+bookId,{method:'PATCH',data:{review:formValue(form,'review'),rating:formValue(form,'rating')===''?null:Number(formValue(form,'rating')),expected_updated_at:detail.updated_at}});
    await refreshCurrent();
  },'Your review is saved');
  if(mode==='edit-book') return perform(button,async()=>{
    await api('/api/books/'+bookId,{method:'PATCH',data:{title:formValue(form,'title'),author:formValue(form,'author'),synopsis:formValue(form,'synopsis'),reading_status:formValue(form,'reading_status'),expected_updated_at:detail.updated_at}});
    await refreshCurrent();
  },'Book information updated');
  if(mode==='add-tag') return perform(button,async()=>{
    await api('/api/books/'+bookId+'/tags',{method:'POST',data:{label:formValue(form,'label'),kind:formValue(form,'kind')}});
    await selectBook(bookId);
  },'Tag added');
  if(mode==='add-shelf') return perform(button,async()=>{
    await api('/api/books/'+bookId+'/shelves',{method:'POST',data:{name:formValue(form,'name')}});
    await selectBook(bookId);
  },'Shelf added');
  if(mode==='edit-edition'){
    const eid=form.dataset.id;
    const edition=detail.editions.find(e=>e.id===eid);
    if(!edition) return;
    return perform(button,async()=>{
      await api('/api/editions/'+eid,{method:'PATCH',data:{edition_name:formValue(form,'edition_name'),publisher:formValue(form,'publisher'),
        vendor:formValue(form,'vendor'),isbn:formValue(form,'isbn'),format:formValue(form,'format'),
        is_special:new FormData(form).has('is_special'),details:formValue(form,'details'),expected_updated_at:edition.updated_at}});
      await selectBook(bookId);
    },'Edition updated');
  }
  if(mode==='edit-copy'){
    const copy=detail.editions.flatMap(e=>e.copies).find(c=>c.id===form.dataset.id);
    if(!copy) return;
    return perform(button,async()=>{
      await api('/api/copies/'+copy.id,{method:'PATCH',data:{
        medium:formValue(form,'medium'),ownership:formValue(form,'ownership'),signature:formValue(form,'signature'),
        is_arc:new FormData(form).has('is_arc'),room:formValue(form,'room'),bookcase:formValue(form,'bookcase'),
        shelf:formValue(form,'shelf'),shelf_position:formValue(form,'shelf_position'),notes:formValue(form,'notes'),
        expected_updated_at:copy.updated_at
      }});
      await selectBook(bookId);
    },'Copy and location saved');
  }
}
document.addEventListener('DOMContentLoaded',async()=>{
  document.querySelectorAll('[data-tab]').forEach(tab=>tab.addEventListener('click',()=>{
    document.querySelectorAll('[data-tab]').forEach(t=>{t.classList.toggle('active',t===tab);t.setAttribute('aria-current',t===tab?'page':'false');});
    document.querySelectorAll('.tab-panel').forEach(p=>{p.hidden=p.id!==tab.dataset.tab;p.classList.toggle('active',p.id===tab.dataset.tab);});
  }));
  $('#add-book').addEventListener('click',()=>showDialog('add-book-dialog'));
  $('#refresh').addEventListener('click',async()=>{try{await refreshCurrent();showMessage('Library refreshed')}catch(e){showMessage(e.message,true)}});
  $('#load-more').addEventListener('click',async()=>{try{await listBooks({append:true})}catch(e){showMessage(e.message,true)}});
  $('#search').addEventListener('input',()=>{
    state.query=$('#search').value.trim();
    clearTimeout(window.bookQueryTimer);
    window.bookQueryTimer=setTimeout(()=>listBooks().catch(e=>showMessage(e.message,true)),250);
  });
  $('#book-grid').addEventListener('click',async e=>{
    const item=e.target.closest('[data-select-book]');
    if(!item) return;
    try{await selectBook(item.dataset.selectBook)}catch(err){showMessage(err.message,true)}
  });
  $('#book-detail').addEventListener('submit',e=>{
    const form=e.target.closest('[data-form]');
    if(!form) return;
    e.preventDefault();submitForm(form,e.submitter).catch(err=>showMessage(err.message,true));
  });
  $('#book-detail').addEventListener('click',async e=>{
    const btn=e.target.closest('button');
    if(!btn) return;
    if(btn.id==='add-edition') return showDialog('add-edition-dialog');
    if(btn.dataset.addCopy){state.activeEdition=btn.dataset.addCopy;return showDialog('add-copy-dialog');}
    if(btn.dataset.removeTag){
      if(!confirm('Remove this tag from the book?')) return;
      await perform(btn,async()=>{await api('/api/books/'+state.selectedId+'/tags/'+btn.dataset.removeTag,{method:'DELETE'});await selectBook(state.selectedId)},'Tag removed');
    }
    if(btn.dataset.removeShelf){
      if(!confirm('Remove this shelf from the book?')) return;
      await perform(btn,async()=>{await api('/api/books/'+state.selectedId+'/shelves/'+btn.dataset.removeShelf,{method:'DELETE'});await selectBook(state.selectedId)},'Shelf removed');
    }
    if(btn.dataset.displayCover){
      await perform(btn,async()=>{await api('/api/editions/'+btn.dataset.editionId+'/display-cover',{method:'PATCH',data:{image_id:btn.dataset.displayCover}});await selectBook(state.selectedId)},'Display cover updated');
    }
  });
  $('#book-detail').addEventListener('change',async e=>{
    const field=e.target.closest('[data-upload-cover]');
    if(!field||!field.files?.length) return;
    const file=field.files[0],eid=field.dataset.uploadCover;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8*1024*1024){showMessage('Please select a JPG, PNG or WebP cover smaller than 8 MB',true);return;}
    field.disabled=true;
    try{await api('/api/editions/'+eid+'/cover',{method:'POST',raw:file,contentType:file.type});await selectBook(state.selectedId);showMessage('Private edition cover uploaded');}
    catch(err){showMessage(err.message,true);}
    finally{field.disabled=false;}
  });
  document.querySelectorAll('[data-close-dialog]').forEach(btn=>btn.addEventListener('click',()=>btn.closest('dialog').close()));
  $('#add-book-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const form=e.target,btn=e.submitter;
    await perform(btn,async()=>{
      const result=await api('/api/books',{method:'POST',data:{title:formValue(form,'title'),author:formValue(form,'author'),
        synopsis:formValue(form,'synopsis'),reading_status:formValue(form,'reading_status'),private_notes:formValue(form,'private_notes')}});
      form.reset();$('#add-book-dialog').close();await listBooks();await selectBook(result.book.id);
    },'Book added');
  });
  $('#add-edition-form').addEventListener('submit',async e=>{
    e.preventDefault();const form=e.target,btn=e.submitter;
    await perform(btn,async()=>{
      await api('/api/books/'+state.selectedId+'/editions',{method:'POST',data:{
        edition_name:formValue(form,'edition_name'),publisher:formValue(form,'publisher'),
        vendor:formValue(form,'vendor'),isbn:formValue(form,'isbn'),format:formValue(form,'format'),
        is_special:new FormData(form).has('is_special'),details:formValue(form,'details')
      }});
      form.reset();$('#add-edition-dialog').close();await selectBook(state.selectedId);
    },'Edition added');
  });
  $('#add-copy-form').addEventListener('submit',async e=>{
    e.preventDefault();const form=e.target,btn=e.submitter;
    await perform(btn,async()=>{
      await api('/api/editions/'+state.activeEdition+'/copies',{method:'POST',data:{
        medium:formValue(form,'medium'),ownership:formValue(form,'ownership'),signature:formValue(form,'signature'),
        is_arc:new FormData(form).has('is_arc'),room:formValue(form,'room'),
        bookcase:formValue(form,'bookcase'),shelf:formValue(form,'shelf'),
        shelf_position:formValue(form,'shelf_position'),notes:formValue(form,'notes')
      }});
      form.reset();$('#add-copy-dialog').close();await selectBook(state.selectedId);
    },'Copy added');
  });
  $('#photo-files').addEventListener('change',e=>{
    state.urls.forEach(u=>URL.revokeObjectURL(u));state.urls=[];
    const photos=Array.from(e.target.files||[]).slice(0,50).filter(file=>['image/png','image/jpeg','image/webp'].includes(file.type));
    $('#photo-preview').innerHTML=photos.map(file=>{
      const url=URL.createObjectURL(file);state.urls.push(url);
      return '<figure><img src="'+safe(url)+'" alt="Local shelf photo preview"><figcaption>'+safe(file.name)+'</figcaption></figure>';
    }).join('');
  });
  try {
    await api('/api/session');
    $('#connection-status').textContent='Owner session verified · Private library connected';
    await listBooks();
    if(state.books.length) await selectBook(state.books[0].id);
  }catch(err){
    $('#connection-status').textContent='Setup required · Private library is not connected';
    $('#book-grid').innerHTML='<div class="empty"><h3>Private setup required</h3><p>Configure a separate Cloudflare Access application and My Library D1 database before editing your library.</p></div>';
    showMessage('Private library is unavailable: '+err.message,true);
    $('#add-book').disabled=true;$('#refresh').disabled=true;
  }
});
