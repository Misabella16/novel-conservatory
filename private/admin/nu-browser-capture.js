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
  status("Captured from "+u.pathname+". Review the title, synopsis, genres and tags below. Saving creates an unpublished draft only.");
 }catch(err){$("nu-capture-review").hidden=true;$("nu-stage-capture").disabled=true;status(err.message)}
});
$("nu-stage-capture").addEventListener("click",async()=>{
 const data=out();
 if(!data.novel.title||(!data.novel.synopsis&&!data.novel.tags.length&&!data.novel.genres.length))return status("Nothing usable found. Check the source page before saving.");
 if(!confirm("Save this retrieved Novel Updates metadata as an UNPUBLISHED draft?"))return;
 const button=$("nu-stage-capture");button.disabled=true;
 try{
  const response=await fetch("/api/admin/nu/stage-browser",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(result.error||"Could not stage metadata");
  status("Saved “"+result.title+"” privately. No public changes were made. Find the novel in the Unpublished list below.");
  $("q").value=result.title;$("state").value="draft";$("find").click();
 }catch(err){status(err.message)}finally{button.disabled=false}
});
})();