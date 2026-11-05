(()=>{
'use strict';
// Shared entry point, separate permissions: Editors may add catalogue metadata;
// the Owner alone may attach EPUBs to R2. All other uploaded EPUBs stay in
// the private, moderated submissions inbox and never auto-publish.
const $=id=>document.getElementById(id);
const tabSubmit=$('tab-submit-epub'),tabEntry=$('tab-add-entry');
const sections={submit:$('submit-panel'),entry:$('editor-panel')};
let role='reader',catalogue=new Map(),catalogueLoaded=false,busy=false;
const show=(message,error=false)=>{
 const node=$('entry-status');node.textContent=message;
 node.classList.toggle('error',!!error);
};
const trim=(id)=>$(id).value.trim();
async function req(url,opts){
 const res=await fetch(url,{credentials:'same-origin',cache:'no-store',...opts});
 const data=await res.json().catch(()=>({}));
 if(!res.ok){const error=Error(data.error||'Request failed ('+res.status+')');error.data=data;throw error}
 return data;
}
function selectTab(which,updateHash=true){
 if(which==='entry'&&!['owner','editor'].includes(role))return;
 sections.submit.hidden=which!=='submit';
 sections.entry.hidden=which!=='entry';
 tabSubmit.setAttribute('aria-selected',String(which==='submit'));
 tabEntry.setAttribute('aria-selected',String(which==='entry'));
 if(updateHash)history.replaceState(null,'',location.pathname+(which==='entry'?'?tab=entry':'')+location.hash);
 if(which==='entry'&&!catalogueLoaded)loadCatalogue();
}
tabSubmit.addEventListener('click',()=>selectTab('submit'));
tabEntry.addEventListener('click',()=>selectTab('entry'));
function mode(){
 const existing=$('entry-action').value==='existing';
 $('create-fields').hidden=existing;
 $('existing-fields').hidden=!existing;
 $('entry-title').required=!existing;
 $('entry-existing').required=existing;
 $('entry-publish').disabled=existing;
 $('entry-submit').textContent=existing?'Attach / submit EPUBs':'Save novel entry'+(role==='owner'?' & attach EPUBs':'');
}
$('entry-action').addEventListener('change',mode);
function bookId(){
 const raw=trim('entry-existing'),match=/^#?(\d+)(?:\s|$)/.exec(raw);
 let record=match?catalogue.get(Number(match[1])):null;
 if(!record){
  const matches=[...catalogue.values()].filter(x=>x.title.toLocaleLowerCase()===raw.toLocaleLowerCase());
  if(matches.length===1)record=matches[0];
 }
 return record||null;
}
async function loadCatalogue(){
 try{
  const [base,additional]=await Promise.all([
   req('/admin/catalogue.json'),
   req('/api/additional/books')
  ]);
  if(!Array.isArray(base))throw Error('Cannot load the core catalogue.');
  catalogue.clear();
  for(const b of [...base,...(additional.novels||[])]){
   const id=Number(b.id);if(!Number.isSafeInteger(id)||id<1)continue;
   catalogue.set(id,{id,title:String(b.title||'Untitled')});
  }
  const dl=$('entry-book-list');dl.replaceChildren();
  const sorted=[...catalogue.values()].sort((a,b)=>a.title.localeCompare(b.title));
  for(const b of sorted){const opt=document.createElement('option');opt.value='#'+b.id+' · '+b.title;dl.appendChild(opt)}
  catalogueLoaded=true;
  const prefill=new URLSearchParams(location.search).get('novel');
  if(prefill&&/^[1-9]\d*$/.test(prefill)&&catalogue.has(Number(prefill))){
   $('entry-action').value='existing';$('entry-existing').value='#'+prefill+' · '+catalogue.get(Number(prefill)).title;mode();
  }
 }catch(e){show('Could not load existing novels: '+e.message,true)}
}
function payload(){
 return {
  title:trim('entry-title'),originalTitle:trim('entry-original'),author:trim('entry-author'),
  translator:trim('entry-translator'),nuUrl:trim('entry-nu-url'),translatorUrl:trim('entry-translator-url'),
  translation:trim('entry-translation'),genres:trim('entry-genres'),tags:trim('entry-tags'),
  synopsis:trim('entry-synopsis'),metadataSource:'Private editorial form · source-only',
  language:'English',novelOrigin:'Other source'
 };
}
function checkFile(file,owner){
 if(!/\.epub$/i.test(file.name)||file.size<100)throw Error('Choose a valid .epub file.');
 if(owner&&file.size>2147483648)throw Error(file.name+' exceeds the 2 GiB direct-upload limit.');
 if(!owner&&file.size>15*1024*1024)throw Error(file.name+' exceeds the 15 MB private submission limit.');
}
async function ownerUpload(file,id,label,translator,onProgress){
 const begin=await req('/api/private/edition/start',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({novelId:id,size:file.size,filename:file.name,label,translator,language:'English'})
 });
 const parts=Math.ceil(file.size/begin.partSize);let finished=false;
 try{
  for(let p=1;p<=parts;p++){
   const chunk=file.slice((p-1)*begin.partSize,Math.min(p*begin.partSize,file.size));
   await req('/api/private/edition/part?session='+encodeURIComponent(begin.sessionId)+'&part='+p,{
    method:'POST',headers:{'content-type':'application/octet-stream'},body:chunk
   });
   onProgress(p/parts);
  }
  await req('/api/private/edition/finish?session='+encodeURIComponent(begin.sessionId),{method:'POST'});
  finished=true;
 }finally{
  if(!finished)await req('/api/private/edition/abort?session='+encodeURIComponent(begin.sessionId),{method:'POST'}).catch(()=>{});
 }
}
async function submitForReview(file,id,title,translator){
 // File sharing is deliberately restricted to the existing moderated inbox.
 // Use the same explicit rights confirmation as the ordinary Submit EPUB form.
 if(!$('entry-rights').checked)throw Error('Confirm your permission to submit these EPUB files for review.');
 return req('/api/epub-submissions/upload',{
  method:'POST',
  headers:{
   'content-type':'application/epub+zip',
   'x-epub-rights':'yes',
   'x-epub-filename':encodeURIComponent(file.name),
   'x-epub-title':encodeURIComponent(title),
   'x-epub-notes':encodeURIComponent('Edition submitted with novel #'+id+(translator?' · Translator: '+translator:'')),
   'x-epub-novel-id':String(id)
  },body:file
 });
}
$('editor-form').addEventListener('submit',async e=>{
 e.preventDefault();
 if(busy||!['owner','editor'].includes(role))return;
 const create=$('entry-action').value==='new';
 const files=[...$('entry-files').files];
 try{
  if(create){
   if(trim('entry-title').length<2)throw Error('Enter the novel title (at least 2 characters).');
  }else if(!bookId())throw Error('Select an existing novel from the suggestions.');
  if(!create&&!files.length)throw Error('Choose at least one EPUB to attach.');
  for(const file of files)checkFile(file,role==='owner');
  if(role==='editor'&&files.length&&!$('entry-rights').checked){
   throw Error('Check the EPUB rights confirmation in this form before submitting.');
  }
  // Saving the entry is the editor's action; no separate confirmation or
  // moderation is required. Saved changes appear immediately, with Undo in
  // catalogue history. EPUB submissions retain their separate file permissions.
  busy=true;$('entry-submit').disabled=true;
  let id, title;
  if(create){
   show('Creating the catalogue entry…');
   const result=await req('/api/admin/additional/create',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({...payload(),publish:$('entry-publish').checked})
   });
   id=result.id;title=trim('entry-title');
   catalogue.set(id,{id,title});
   show((result.reused?'Found existing novel #':'Created novel #')+id+'. '+
    (result.notUpdated?'Its current metadata and publication state were kept. Edit the existing entry if needed. ':
     result.reused?'Compatible fields were combined, existing synopsis retained, and Undo is available. ':'')+
    (files.length?'Now processing EPUB editions…':'No EPUBs were selected.'));
  }else{
   const book=bookId();id=book.id;title=book.title;
  }
  const issues=[];let successes=0;
  const progress=$('entry-progress');
  progress.hidden=files.length===0;progress.value=0;
  for(let i=0;i<files.length;i++){
   const file=files[i];
   try{
    if(role==='owner'){
     await ownerUpload(file,id,trim('entry-edition-label')||'Translation edition',trim('entry-edition-translator'),
      fraction=>{progress.value=100*(i+fraction)/files.length});
    }else{
     await submitForReview(file,id,title,trim('entry-edition-translator'));
     progress.value=100*(i+1)/files.length;
    }
    successes++;
   }catch(error){issues.push(file.name+': '+error.message)}
   show('Novel #'+id+'. '+(i+1)+'/'+files.length+' EPUB files processed. '+successes+' succeeded, '+issues.length+' failed.');
  }
  const output=['Novel #'+id+(create?' saved or reused':' selected')+'.'];
  if(files.length)output.push(role==='owner'?successes+' EPUB(s) stored privately.':successes+' EPUB(s) sent for owner review.');
  if(issues.length)output.push('Issues:\n'+issues.join('\n'));
  if(role==='owner'&&successes)output.push('Newly uploaded EPUB editions start unverified.');
  show(output.join('\n'),issues.length>0);
  if(!issues.length){$('entry-files').value='';$('entry-action').value='existing';$('entry-existing').value='#'+id+' · '+title;mode();}
 }catch(err){
  const found=err.data?.candidates||[];
  const links=found.length?' Existing record(s): '+found.map(v=>'#'+v.id+' '+v.title).join('; ')+'. Use Advanced novel management or Merge duplicates to resolve them.':'';
  show((err.message||'Could not save your entry.')+links,true)
 }
 finally{busy=false;$('entry-submit').disabled=false}
});
async function init(){
 try{
  const me=await req('/api/me');
  role=me.role;
  if(role==='owner'||role==='editor'){
   tabEntry.hidden=false;
   $('entry-bulk-link').hidden=role!=='owner';
   $('entry-review-link').hidden=role!=='owner';
   $('entry-rights-label').hidden=role==='owner';
   $('entry-upload-hint').textContent=role==='owner'
    ?'Attach one or more EPUB editions directly to the private library. New files start unverified.'
    :'You can create catalogue entries. EPUB files are sent to the private owner review queue; they are not attached or published automatically. Confirm your right to submit the EPUBs using the checkbox below.';
   mode();
   const query=new URLSearchParams(location.search);
   if(query.get('tab')==='entry'||query.has('novel'))selectTab('entry',false);
  }
 }catch(err){
  tabEntry.hidden=true;
  console.warn('Could not verify editorial role for unified EPUB submission page.',err);
 }
}
init();
})();