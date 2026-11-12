/* Inline editorial controls for the PRIVATE novel detail drawer.
 * The public catalogue never loads this script. All saves reuse the existing
 * role-gated /api/admin/novel and /api/admin/upload endpoints.
 */
(function(root){
 'use strict';
 const $=id=>root.document.getElementById(id);
 const text=(v,max)=>String(v??'').trim().slice(0,max);
 const list=value=>{
  const output=[],seen=new Set();
  for(const line of String(value||'').split(/[,\n;]+/)){
   const item=text(line,75).normalize('NFKC');
   if(!item||seen.has(item.toLocaleLowerCase()))continue;
   seen.add(item.toLocaleLowerCase());output.push(item);
   if(output.length>=100)break;
  }
  return output;
 };
 const e=(name,cls,txt)=>{
  const node=root.document.createElement(name);
  if(cls)node.className=cls;
  if(txt!==undefined)node.textContent=String(txt);
  return node;
 };
 function makeField(label,value,tag='input',max=240){
  const wrap=e('label','novel-inline-field');
  wrap.append(e('span','',label));
  const input=e(tag);
  if(tag==='textarea'){input.rows=label==='Synopsis'?6:3;}
  else input.type='text';
  input.maxLength=max;input.value=String(value||'');
  wrap.append(input);
  return {wrap,input};
 }
 const editorLink=id=>Number(id)>=100000?
  '/admin/add-novels.html?novel='+encodeURIComponent(id):
  '/admin/?book='+encodeURIComponent(id);
 const canEdit=()=>root.novelConservatoryCanEdit===true;
 async function post(path,data,type='application/json'){
  const response=await root.fetch(path,{
   method:'POST',credentials:'same-origin',
   headers:{'Content-Type':type},
   body:type==='application/json'?JSON.stringify(data):data
  });
  let result;
  try{result=await response.json();}catch{result={};}
  if(!response.ok)throw Error(result.error||'Could not save changes ('+response.status+')');
  return result;
 }
 function status(node,message,bad=false){
  node.textContent=message;
  node.setAttribute('data-error',String(bad));
 }
 function renderInfo(book,onUpdate){
  const slot=$('novel-inline-info-slot');
  if(!slot||!canEdit())return;
  slot.replaceChildren();
  const shell=e('section','novel-inline-editor');
  const toggle=e('button','novel-inline-toggle','✎ Edit novel information · collapse');
  toggle.type='button';toggle.setAttribute('aria-expanded','true');
  const form=e('form','novel-inline-fields');
  form.hidden=false;
  const heading=e('h3','', 'Edit this novel here');
  const hint=e('p','novel-editor-help',
   'Update title, author, synopsis, genres, and tags without leaving the novel page. Private editor changes do not automatically publish private EPUBs or covers.');
  form.append(heading,hint);
  const title=makeField('Title',book.title);
  const original=makeField('Original title',book.originalTitle);
  const author=makeField('Author',book.author);
  const synopsis=makeField('Synopsis',book.synopsis,'textarea',2000);
  const genres=makeField('Genres, separated by commas or new lines',(book.genres||[]).join('\n'),'textarea',2500);
  const tags=makeField('Tags and tropes, separated by commas or new lines',(book.tags||[]).join('\n'),'textarea',2500);
  const warnings=makeField('Content warnings, separated by commas or new lines',(book.contentWarnings||[]).join('\n'),'textarea',2500);
  title.input.required=true;title.input.maxLength=240;
  author.input.maxLength=240;
  form.append(title.wrap,original.wrap,author.wrap,synopsis.wrap,genres.wrap,tags.wrap,warnings.wrap);
  const action=e('div','novel-editor-actions');
  const save=e('button','novel-editor-save','Save novel information');
  save.type='submit';
  const full=e('a','novel-editor-full','Full editor ↗');
  full.href=editorLink(book.id);
  const feedback=e('p','novel-editor-status','');
  feedback.setAttribute('role','status');
  action.append(save,full);
  form.append(action,feedback);
  shell.append(toggle,form);slot.append(shell);
  toggle.addEventListener('click',()=>{
   form.hidden=!form.hidden;
   toggle.setAttribute('aria-expanded',String(!form.hidden));
   toggle.textContent=form.hidden?'✎ Edit novel information · expand':'✎ Edit novel information · collapse';
   if(!form.hidden)title.input.focus();
  });
  form.addEventListener('submit',async event=>{
   event.preventDefault();
   if(!canEdit()){status(feedback,'Your editorial permission is not active.',true);return;}
   if(Number(book.id)>=100000){root.location.href=editorLink(book.id);return;}
   const newTitle=text(title.input.value,240);
   if(!newTitle){status(feedback,'A title is required.',true);return;}
   const patch={};
   const textual=[
    ['title',newTitle],['originalTitle',text(original.input.value,240)],
    ['author',text(author.input.value,240)],
    ['synopsis',text(synopsis.input.value,2000)]
   ];
   for(const [key,value] of textual){
    if(value!==String(book[key]||''))patch[key]=value;
   }
   for(const [key,value] of [
    ['genres',genres.input.value],['tags',tags.input.value],
    ['contentWarnings',warnings.input.value]
   ]){
    // Critical: other imports may supply more than the admin limit of 24.
    // Never truncate those tags as a side effect of editing a title.
    const old=Array.isArray(book[key])?book[key]:[];
    if(value===old.join('\n'))continue;
    const revised=list(value);
    if(revised.length>24){
     status(feedback,'This editor accepts up to 24 '+key+
      ' per save. Please reduce the list or use the full editor.',true);
     return;
    }
    if(JSON.stringify(revised)!==JSON.stringify(old))patch[key]=revised;
   }
   if(!Object.keys(patch).length){
    status(feedback,'No changes to save.');
    return;
   }
   save.disabled=true;status(feedback,'Saving your editorial changes…');
   try{
    const result=await post('/api/admin/novel',{id:Number(book.id),patch});
    Object.assign(book,result.patch||patch);
    onUpdate?.(book,'Novel information saved.');
   }catch(error){status(feedback,error.message,true);}
   finally{save.disabled=false;}
  });
  if(Number(book.id)>=100000){
   form.replaceChildren(e('p','novel-editor-help',
    'This novel uses the additional-novels editor, so its existing record must be updated there.'));
   form.append(full);
  }
 }
 function renderCover(book,onUpdate){
  const slot=$('novel-inline-cover-slot');
  if(!slot||!canEdit())return;
  const cover=$('drawer-content')?.querySelector('.detail-head .detail-cover');
  if(!cover)return;
  const trigger=e('button','novel-cover-edit-trigger','✎ Edit cover');
  trigger.id='novel-cover-edit-trigger';
  trigger.type='button';
  trigger.setAttribute('aria-expanded','false');
  trigger.setAttribute('aria-controls','novel-cover-editor');
  trigger.setAttribute('aria-label','Edit cover for '+book.title);
  trigger.title='Tap this cover to edit it';
  cover.append(trigger);
  slot.replaceChildren();
  const panel=e('section','novel-cover-editor');
  panel.id='novel-cover-editor';
  panel.hidden=true;
  const heading=e('h3','','Change this cover');
  const hint=e('p','novel-editor-help',
   'Choose an image file or paste a direct HTTPS image URL. Changes remain private until separately published. Private EPUB files are never changed.');
  panel.append(heading,hint);
  const imageUrl=makeField('Paste a direct cover image URL',book.cover?.startsWith('https://')?book.cover:'');
  imageUrl.input.type='url';
  imageUrl.input.placeholder='https://publisher.example/cover.jpg';
  imageUrl.input.inputMode='url';
  const photo=makeField('Or choose an image from your phone','','input');
  photo.input.type='file';photo.input.accept='image/jpeg,image/png,image/webp,image/gif';
  photo.input.removeAttribute('maxlength');
  const rights=e('label','novel-cover-rights');
  const check=e('input');check.type='checkbox';check.checked=false;
  rights.append(check,e('span','',
   'I checked that I may display this image publicly (optional; unchecked keeps it a private reference).'));
  const actions=e('div','novel-editor-actions');
  const save=e('button','novel-editor-save','Save cover');
  save.type='button';
  const cancel=e('button','novel-editor-cancel','Cancel');
  cancel.type='button';
  actions.append(save,cancel);
  const feedback=e('p','novel-editor-status','');
  feedback.setAttribute('role','status');
  panel.append(imageUrl.wrap,photo.wrap,rights,actions,feedback);
  slot.append(panel);
  const toggle=force=>{
   const open=typeof force==='boolean'?force:panel.hidden;
   panel.hidden=!open;
   trigger.setAttribute('aria-expanded',String(open));
   trigger.setAttribute('aria-label',open?'Close cover editor':'Edit this novel cover');
   if(open)panel.scrollIntoView?.({block:'nearest',behavior:'smooth'});
  };
  trigger.addEventListener('click',()=>toggle());
  cover.addEventListener('click',event=>{
   if(event.target===trigger)return;
   toggle();
  });
  cancel.addEventListener('click',()=>toggle(false));
  photo.input.addEventListener('change',()=>{
   const selected=photo.input.files?.[0];
   if(selected){
    imageUrl.input.value='';
    status(feedback,'Photo selected. Press Save cover to upload it.');
   }
  });
  imageUrl.input.addEventListener('input',()=>{
   if(imageUrl.input.value.trim())photo.input.value='';
  });
  save.addEventListener('click',async()=>{
   if(!canEdit()){status(feedback,'Editor permission required.',true);return;}
   if(Number(book.id)>=100000){
    root.location.href=editorLink(book.id);return;
   }
   const image=photo.input.files?.[0];
   const rawUrl=text(imageUrl.input.value,1500);
   if(!image&&!rawUrl){status(feedback,'Choose a photo or paste an image URL.',true);return;}
   let newCover='';
   if(rawUrl){
    let parsed;
    try{parsed=new URL(rawUrl);}catch{}
    if(parsed?.protocol!=='https:'||parsed.username||parsed.password){
     status(feedback,'Use a valid direct HTTPS image URL.',true);return;
    }
    newCover=parsed.href;
   }else{
    if(!['image/jpeg','image/png','image/webp','image/gif'].includes(image.type)||
      image.size<100||image.size>6000000){
      status(feedback,'Choose a JPEG, PNG, WebP, or GIF smaller than 6 MB.',true);return;
    }
   }
   save.disabled=true;status(feedback,'Saving cover…');
   try{
    if(image){
     const upload=await post('/api/admin/upload',image,image.type);
     if(!/^\/media\/[a-f0-9-]{36}\.(png|jpe?g|webp|gif)$/.test(upload.url||'')){
      throw Error('Cover uploaded but the returned image path could not be verified.');
     }
     newCover=upload.url;
    }
    const result=await post('/api/admin/novel',{
     id:Number(book.id),
     patch:{cover:newCover,coverRights:!!check.checked}
    });
    Object.assign(book,result.patch||{cover:newCover,coverRights:!!check.checked});
    onUpdate?.(book,'Cover saved privately.');
   }catch(error){status(feedback,error.message,true);}
   finally{save.disabled=false;}
  });
  if(Number(book.id)>=100000){
   panel.replaceChildren(heading,e('p','novel-editor-help',
    'This added novel has its own editor. Open that editor to update its cover.'));
   const full=e('a','novel-editor-full','Open full cover editor ↗');full.href=editorLink(book.id);
   panel.append(full);
  }
 }
 function mount(book,onUpdate){
  if(!canEdit()||!book||!Number.isSafeInteger(Number(book.id)))return;
  renderInfo(book,onUpdate);
  renderCover(book,onUpdate);
 }
 root.ConservatoryQuickEdit={mount,parseLabels:list,editorLink};
})(window);
