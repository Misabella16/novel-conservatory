(function(){
"use strict";
/* Captures fields visible in a Novel Updates browser tab, never cookies or page source. */
function captureNovelUpdates(){
 const host=location.hostname.toLowerCase(),match=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/i.exec(location.pathname);
 if(host!=="www.novelupdates.com"||!match){alert("Open a specific novel's Novel Updates series page first.");return}
 const get=(selectors)=>{for(const q of selectors){const e=document.querySelector(q);if(e){const v=(e.innerText||e.textContent||"").trim();if(v)return v}}return""};
 const list=(selectors)=>{const out=[];for(const q of selectors){for(const el of document.querySelectorAll(q)){const v=(el.innerText||el.textContent||"").trim().replace(/\s+/g," ");if(v&&v.length<=100&&!out.includes(v))out.push(v)}}return out.slice(0,35)};
 const url="https://www.novelupdates.com/series/"+match[1].toLowerCase()+"/";
 const title=get([".seriestitlenu","#edit-title",".series-title"]).slice(0,210);
 const synopsis=get(["#editdescription","#seriesdescription",".series-description","#showdescription",".seriesdescription"]).slice(0,6000);
 const author=get(["#showauthors","#seriesauthors",".author-content"]).slice(0,140);
 const originalTitle=get(["#editassociated","#seriesothernames","#showassociated","#seriesassociated"]).slice(0,210);
 const genres=list(["#seriesgenre a","#showgenres a",".seriesgenre a"]);
 const tags=list(["#showtags a","#seriestags a",".seriestags a"]);
 const cover=document.querySelector("#seriesimg img,.seriesimg img,.series-image img");
 const coverUrl=cover?(cover.getAttribute("data-src")||cover.getAttribute("src")||""):"";
 if(!title||(!synopsis&&!genres.length&&!tags.length)){
  alert("No complete series metadata was found. Wait for the page to finish loading, then try again. Nothing was copied.");return;
 }
 const payload=JSON.stringify({source:"novelupdates-browser-v1",novel:{nuUrl:url,title,author,originalTitle,synopsis,genres,tags,coverUrl:coverUrl?new URL(coverUrl,location.href).href:""}});
 const fallback=()=>window.prompt("Copy the entire metadata text, then paste it into Novel Conservatory's Browser Import box:",payload);
 if(navigator.clipboard&&navigator.clipboard.writeText){
  navigator.clipboard.writeText(payload).then(()=>alert("Novel Updates metadata copied. Return to Novel Conservatory, paste it into Browser Import and review it before staging.")).catch(fallback);
 }else{const t=document.createElement("textarea");t.value=payload;t.style.position="fixed";t.style.opacity="0";document.body.appendChild(t);t.select();
  const ok=document.execCommand&&document.execCommand("copy");t.remove();if(ok)alert("Novel Updates metadata copied! Return to Novel Conservatory's Browser Import.");else fallback()}
}
const $=id=>document.getElementById(id),link=$("nu-capture-bookmarklet"),copy=$("nu-copy-bookmarklet");
const href="javascript:("+captureNovelUpdates.toString()+")()";
link.href=href;
copy.addEventListener("click",async()=>{
 try{await navigator.clipboard.writeText(href);$("nu-browser-status").textContent="Bookmarklet code copied. Create a bookmark named Capture Novel Updates, then paste this into its URL/address field."}
 catch{$("nu-browser-status").textContent="Clipboard unavailable. On a computer, drag the Capture Novel Updates link to your bookmarks bar."}
});
const out=()=>({source:"novelupdates-browser-v1",novel:{
 nuUrl:$("nu-import-url").value.trim(),title:$("nu-import-title").value.trim(),author:$("nu-import-author").value.trim(),
 originalTitle:$("nu-import-original").value.trim(),synopsis:$("nu-import-synopsis").value.trim(),
 genres:$("nu-import-genres").value.split(",").map(x=>x.trim()).filter(Boolean),
 tags:$("nu-import-tags").value.split(",").map(x=>x.trim()).filter(Boolean),
 coverUrl:$("nu-import-cover").value.trim()
}});
const status=(msg)=>{$("nu-browser-status").textContent=msg};
$("nu-review-capture").addEventListener("click",()=>{
 try{
  const input=$("nu-import-json").value.trim();
  if(!input||input.length>15000)throw Error("Paste the copied JSON metadata (up to 15,000 characters).");
  const json=JSON.parse(input);
  if(json.source!=="novelupdates-browser-v1"||!json.novel||typeof json.novel!=="object")throw Error("This isn't a Novel Conservatory capture. Use the Capture Novel Updates bookmarklet.");
  const item=json.novel,u=new URL(item.nuUrl||"");
  if(u.protocol!=="https:"||u.hostname!=="www.novelupdates.com"||!/^\/series\/[a-z0-9-]+\/?$/i.test(u.pathname))throw Error("The captured page URL is not a valid Novel Updates series.");
  if(typeof item.title!=="string"||!item.title.trim())throw Error("Missing series title. Nothing was imported.");
  for(const [key,field] of Object.entries({nuUrl:"nu-import-url",title:"nu-import-title",author:"nu-import-author",originalTitle:"nu-import-original",synopsis:"nu-import-synopsis",coverUrl:"nu-import-cover"})){
   $(field).value=typeof item[key]==="string"?item[key]:"";
  }
  for(const k of ["tags","genres"])$("nu-import-"+k).value=Array.isArray(item[k])?item[k].join(", "):"";
  $("nu-capture-review").hidden=false;$("nu-stage-capture").disabled=false;
  status("Captured from "+u.pathname+". Review actual source fields, then save directly into the correct novel. Changes are undoable, and matching entries will not be duplicated.");
 }catch(err){$("nu-capture-review").hidden=true;$("nu-stage-capture").disabled=true;status(err.message)}
});
let selectedTargetId=null,lastUndoId=null,latestTarget=null;
const shorten=value=>{
 const raw=Array.isArray(value)?value.join(', '):String(value??'');
 return raw.length>250?raw.slice(0,250)+'…':raw;
};
function renderConflicts(conflicts,target){
 const panel=$("nu-conflict-panel"),host=$("nu-conflict-fields");
 host.replaceChildren();latestTarget=target;
 const values=(conflicts||[]).filter(c=>c&&c.field&&String(c.current)!==String(c.incoming));
 panel.hidden=!values.length;
 for(const item of values){
  const row=document.createElement('div');row.className='nu-conflict';
  const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.value=item.field;
  const words=document.createElement('span');
  words.textContent=item.field+': current “'+shorten(item.current)+'”; source “'+shorten(item.incoming)+'”. Use source instead.';
  label.append(check,words);row.append(label);host.append(row);
 }
}
function saveResult(result){
 $("nu-choice").hidden=true;
 if(!result.ok)return status(result.message||'No change was saved');
 const created=result.created?'Created new novel':'Updated existing novel';
 status(created+' #'+result.id+'. '+(result.changed?.length?'Merged: '+result.changed.join(', ')+'. ':'')+
  (result.conflicts?.length?'Existing conflicting values were preserved until you choose them below. ':'')+
  'You can Undo from this page or the full change history.'+
  (result.privateSynced===false?' Private catalogue synchronization needs review.':''));
 lastUndoId=result.eventId||null;
 $("nu-undo-last").hidden=!lastUndoId;
 $("nu-undo-last").disabled=!lastUndoId;
 renderConflicts(result.conflicts,result.id);
 $("q").value=String(result.id);
 $("state").value='all';
 $("find").click();
}
async function syncCaptured(options={}){
 const data=out();
 if(!data.novel.title||(!data.novel.synopsis&&!data.novel.tags.length&&!data.novel.genres.length))
  return status("Nothing usable found in the Novel Updates page. No catalogue changes were made.");
 const button=$("nu-stage-capture");button.disabled=true;
 try{
  const r=await fetch('/api/admin/nu/sync-capture',{
   method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
   body:JSON.stringify({capture:data,targetId:options.targetId??selectedTargetId,
    confirmDifferent:!!options.confirmDifferent,preferSourceFields:options.preferSourceFields||[]})
  });
  const result=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(result.error||'Could not save the source information');
  if(result.needsChoice){
   const select=$("nu-choice-select");select.replaceChildren();
   const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Choose the correct existing novel';select.append(placeholder);
   for(const candidate of result.candidates||[]){
    const option=document.createElement('option');option.value=String(candidate.id);
    option.textContent='#'+candidate.id+' · '+candidate.title+' ('+candidate.matchedBy+')';select.append(option);
   }
   $("nu-choice").hidden=false;
   status('Several matching novels were found. Choose the correct existing book before saving. No new duplicate was created.');
   return;
  }
  if(result.needsIdentityConfirmation){
   if(!confirm('This catalogue record does not match the captured Novel Updates title or URL. Are you certain they are the same novel?'))
    return status('No changes saved.');
   return syncCaptured({...options,targetId:result.selected||options.targetId,confirmDifferent:true});
  }
  saveResult(result);
 }catch(err){status(err.message)}
 finally{button.disabled=false}
}
$("nu-stage-capture").addEventListener("click",()=>syncCaptured());
$("nu-choice-confirm").addEventListener("click",()=>{
 const id=Number($("nu-choice-select").value);
 if(!Number.isSafeInteger(id)||id<1)return status('Select one of the matching novels.');
 selectedTargetId=id;
 syncCaptured({targetId:id});
});
$("nu-save-conflicts").addEventListener("click",()=>{
 if(!latestTarget)return;
 const fields=[...$("nu-conflict-fields").querySelectorAll('input:checked')].map(x=>x.value);
 if(!fields.length)return status('Select at least one field to replace.');
 selectedTargetId=latestTarget;
 syncCaptured({targetId:latestTarget,preferSourceFields:fields});
});
$("nu-undo-last").addEventListener("click",async()=>{
 if(!lastUndoId)return;
 const button=$("nu-undo-last");button.disabled=true;
 try{
  const response=await fetch('/api/admin/nu/undo',{method:'POST',credentials:'same-origin',
   headers:{'content-type':'application/json'},body:JSON.stringify({eventId:lastUndoId})});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(result.error||'Could not undo change');
  status('↶ Restored the previous catalogue state for novel #'+result.targetId+
   '. The record can be edited again. '+(result.privateSynced===false?'Newer private edits need manual review.':''));
  lastUndoId=null;latestTarget=null;selectedTargetId=null;
  button.hidden=true;
  $("nu-conflict-panel").hidden=true;
  $("find").click();
 }catch(error){status('Undo stopped: '+error.message);button.disabled=false}
});
})();