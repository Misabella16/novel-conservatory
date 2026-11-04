'use strict';
const $=id=>document.getElementById(id);
let books=[],edits={},items=[],editable=false,stopAfter=false,working=false;
const byId=new Map(),byName=new Map();
const matchHints={
  aftersecretlygettingpregnantwiththemarshalsbaby:'After Secretly Getting Pregnant With the Marshal’s Baby (ABO)',
  hecamefromthetomb:'He Came From the Grave (possibly a different title)',
  specialcaseinvestigationteam:'Special Case Investigation Team I or II; check which volume',
  thelittlekingnextdoor:'Little Wang Next Door (possible alternate title)',
  transmigratingtoancienttimestobeamerchant:'Traveling Through Ancient Times To Be a Merchant'
};
const enc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function norm(x){return String(x??'').normalize('NFKD').toLowerCase().replace(/[’‘]/g,"'").replace(/[^a-z0-9]+/g,'');}
function note(s){$('feed').textContent=s;}
function status(s,ok=false){$('auth').textContent=s;$('auth').className=ok?'ok':'banner';}
function bookTitle(b){return edits[b.id]?.title||b.title;}
function addBookIndexes(){byName.clear();byId.clear();$('book-options').replaceChildren();for(const b of books){byId.set(Number(b.id),b);const keys=new Set([norm(b.title),norm(bookTitle(b))]);for(const key of keys){if(!byName.has(key))byName.set(key,[]);byName.get(key).push(b)}const opt=document.createElement('option');opt.value=`${b.id} · ${bookTitle(b)}`;$('book-options').append(opt);}}
function classify(raw){let u;try{u=new URL(raw)}catch{return {type:'unsupported',reason:'Invalid URL'}};
 if(u.protocol!=='https:')return {type:'unsupported',reason:'Not HTTPS'};
 if(/(^|\.)(docs\.google\.com|drive\.google\.com)$/i.test(u.hostname))return {type:'unsupported',reason:'Google Docs require manual review; not importable into translation links'};
 const p=u.pathname.toLowerCase();
 if(/\/(series|novel|novels|work|books|chapter)\//.test(p)|| /\/p\/(?!homepage)[^/]+\.html$/.test(p)|| /ninetysevenkoi\.wordpress\.com\/law\/?$/.test(u.href)|| /rainbow-reads\.com\/i-fell-in-love-after-becoming-a-ghost\/?$/.test(u.href))return{type:'readUrl',reason:'Story-specific page'};
 return {type:'siteUrl',reason: /\/(user|author|translator)\//.test(p)?'Translator profile':'General translator site or index'};
}
function suggestedName(url,book){const u=new URL(url),seg=u.pathname.split('/').filter(Boolean);const ix=seg.findIndex(x=>['user','author','translator'].includes(x.toLowerCase()));if(ix!==-1&&seg[ix+1])return decodeURIComponent(seg[ix+1]).replace(/[-_]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
 const legacy=String(book?.translator||'').split(';').map(x=>x.trim()).filter(Boolean);
 if(classify(url).type==='readUrl')return u.hostname.replace(/^www\./,'')+' (credit unconfirmed)';
 if(legacy.length===1)return legacy[0];
 return u.hostname.replace(/^www\./,'');
}
function makeItem(r,opts={}){const match=byName.get(norm(r.title))||[];let b=match.length===1?match[0]:null;const category=classify(r.url);let warning=opts.warning||'';
 if(match.length>1)warning+=' Ambiguous catalogue title.';
 if(!b&&matchHints[norm(r.title)])warning+=' Possible catalogue title: '+matchHints[norm(r.title)]+'.';
 if(category.type==='readUrl')warning+=' Translator credit on story page needs confirmation.';
 if(category.type==='siteUrl'&&b&&/\/(user|author|translator)\//i.test(new URL(r.url).pathname)){
  const profile=suggestedName(r.url,b),current=String(b.translator||'').split(/[;,]/).map(x=>norm(x)).filter(Boolean);
  if(current.length&&!current.includes(norm(profile)))warning+=' Profile name differs from original catalogue credit; verify before importing.';
 }
 if(/^(Start Over on Easy Mode|The #1 Pretty Boy of the Immortal Path)$/i.test(r.title))warning+=' This title-to-link association is unclear in the original list.';
 return {id:items.length+1,title:r.title,url:r.url,bookId:b?.id||null,bookQuery:b?`${b.id} · ${bookTitle(b)}`:'',name:suggestedName(r.url,b),category,warning:warning.trim(),selected:false,source:opts.source||'Curated links from supplied CG relocation directory'};
}
function keyFor(i){return norm(i.title)+'\t'+i.url.replace(/\/$/,'').toLowerCase();}
function addCandidates(rows,opts={}){const keys=new Set(items.map(keyFor));let added=0;
 for(const r of rows){const u=String(r.url||'').trim(),t=String(r.title||'').trim();if(!u||!t)continue;const i=makeItem({title:t,url:u},{warning:r.warning||'',source:opts.source});const key=keyFor(i);if(keys.has(key))continue;keys.add(key);items.push(i);added++;}
 items.forEach((i,n)=>i.id=n+1);render();return added;
}
function counts(){const matched=items.filter(x=>x.bookId),unmatched=items.filter(x=>!x.bookId);$('total').textContent=items.length;$('matches').textContent=matched.length;$('unmatched').textContent=unmatched.length;$('chosen').textContent=items.filter(x=>x.selected).length;}
function show(i){const type=i.category.type==='readUrl'?'Direct novel link':i.category.type==='siteUrl'?'Translator/index site':'Unsupported link';
 const issue=i.warning||(i.bookId?'':'No unique title match');const severity=i.warning||!i.bookId||i.category.type==='unsupported'?'warn':'good';
 const style=`<span class="pill ${severity}">${enc(issue? 'Review required':'Title matched')}</span>`;
 return `<tr data-row="${i.id}"><td><input aria-label="Include ${enc(i.title)}" data-checkbox="${i.id}" type="checkbox" ${i.selected?'checked':''} ${i.category.type==='unsupported'?'disabled':''}></td>
 <td class="titlecell"><strong>${enc(i.title)}</strong><div class="small sub">${style}</div><input type="text" list="book-options" data-book="${i.id}" value="${enc(i.bookQuery)}" placeholder="Search catalogue title or ID"></td>
 <td class="urlcell"><label class="small">Link type <select data-kind="${i.id}" aria-label="Link type for ${enc(i.title)}"><option value="siteUrl" ${i.category.type==='siteUrl'?'selected':''}>Translator website</option><option value="readUrl" ${i.category.type==='readUrl'?'selected':''}>Direct novel page</option></select></label><label class="small">URL <input type="text" data-url="${i.id}" value="${enc(i.url)}" aria-label="Link for ${enc(i.title)}"></label><div class="small"><a href="${enc(i.url)}" rel="noopener noreferrer" target="_blank">Open supplied URL</a></div></td>
 <td class="namecell"><input type="text" data-name="${i.id}" value="${enc(i.name)}" aria-label="Translator name for ${enc(i.title)}"></td>
 <td class="small">${enc(i.warning||i.category.reason)}${i.bookId?'':' · Match a title before importing'}</td></tr>`;}
function render(){counts();const f=$('filter').value,q=norm($('query').value);let view=items.filter(x=>{
 if(f==='matched'&&!x.bookId)return false;if(f==='unmatched'&&x.bookId)return false;
 if(f==='review'&&x.bookId&&!x.warning&&x.category.type!=='unsupported')return false;
 if(f==='selected'&&!x.selected)return false;
 return !q||norm(x.title+' '+x.url+' '+x.name).includes(q);
 });$('rows').innerHTML=view.map(show).join('')||'<tr><td colspan="5">No candidates match this filter.</td></tr>';
 for(const el of document.querySelectorAll('[data-checkbox]'))el.addEventListener('change',e=>{items.find(i=>i.id===Number(el.dataset.checkbox)).selected=e.target.checked;counts();updateApply()});
 for(const el of document.querySelectorAll('[data-name]'))el.addEventListener('change',()=>{const i=items.find(i=>i.id===Number(el.dataset.name));i.name=el.value.trim();counts()});
 for(const el of document.querySelectorAll('[data-kind]'))el.addEventListener('change',()=>{const i=items.find(i=>i.id===Number(el.dataset.kind));i.category.type=el.value;i.category.reason='Manually assigned link type';render();});
 for(const el of document.querySelectorAll('[data-url]'))el.addEventListener('change',()=>{const i=items.find(i=>i.id===Number(el.dataset.url));const changed=el.value.trim();const classified=classify(changed);i.url=changed;i.category=classified;i.warning=(i.warning?i.warning+' ':'')+'URL edited; double-check target.';if(classified.type==='unsupported'){i.selected=false;i.warning+=' Invalid or unsupported URL.';}render();});
 for(const el of document.querySelectorAll('[data-book]'))el.addEventListener('change',()=>{const i=items.find(i=>i.id===Number(el.dataset.book));i.bookQuery=el.value;const m=el.value.match(/^(\d+)\s*·\s*/);let b=m?byId.get(Number(m[1])):null;if(!b){const a=byName.get(norm(el.value))||[];b=a.length===1?a[0]:null;}i.bookId=b?.id||null;i.bookQuery=b?`${b.id} · ${bookTitle(b)}`:el.value;render()});
 $('list-note').textContent=`Showing ${view.length} of ${items.length} candidates. Only items you select are imported.`;updateApply();}
function updateApply(){$('apply').disabled=working||!editable||!$('ack').checked||!items.some(x=>x.selected&&x.bookId&&x.name&&x.category.type!=='unsupported');}
async function loadStatusNotes(){const r=await fetch('/admin/cg-relocation-status-notes.json',{cache:'no-store'});if(!r.ok)return;const d=await r.json();$('status-count').textContent=`(${d.notes.length} source notes)`;const table=document.createElement('table');const head=document.createElement('tr');for(const label of ['Novel','Historical note']){const th=document.createElement('th');th.textContent=label;head.append(th)}table.append(head);for(const n of d.notes){const tr=document.createElement('tr');for(const text of [n.title,n.note]){const td=document.createElement('td');td.textContent=text;tr.append(td)}table.append(tr)}$('status-notes').append(table);}
async function loadSeed(){const r=await fetch('/admin/cg-relocation-seed.json',{cache:'no-store'});if(!r.ok)throw Error('Could not load the supplied link directory');const data=await r.json();items=[];addCandidates(data.links,{source:data.source});note('The supplied CG relocation links are loaded for review. No records have been changed.');}
function parsePlainText(txt){const lines=txt.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);const out=[],flags=[],pending=[];let started=!lines.includes('#');
 for(const l of lines){if(l==='#'){started=true;continue;}if(!started)continue;
 if(/^[A-Z]$/.test(l)) {pending.length=0;continue;}
 if(/^https?:\/\//i.test(l)){
  const url=l.split(/\s+/)[0];if(pending.length){for(const p of pending){out.push({title:p,url,warning:pending.length>1?`This link follows ${pending.length} titles. Confirm it applies to this one.`:''})}}
  pending.length=0;continue;
 }
 if(/^(?:won['’]t be re-uploaded|dropped|new translator has translation online|updated around november)$/i.test(l)){
  if(pending.length)flags.push({title:pending[pending.length-1],note:l});continue;
 }
 if(l.length<3||/^(?:the links mentioned|please note|if you see any|this document|check out the discord|are you a translator)/i.test(l))continue;
 pending.push(l);
 }
 return {out,flags};
}
async function adminPost(id,patch){const response=await fetch('/api/admin/novel',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({id,patch:{translations:patch}})});const j=await response.json().catch(()=>({error:'Server did not return JSON'}));if(!response.ok)throw Error(j.error||'Failed to save novel #'+id);return j.patch;}
function legacyEditions(b){if(Array.isArray(b.translations))return b.translations.map(x=>({...x}));const names=String(b.translator||'').split(/\s*;\s*/).map(x=>x.trim()).filter(Boolean);return names.map(x=>({name:x,label:'',language:'English',status:['completed','ongoing','incomplete','dropped','licensed'].includes(b.translation)?b.translation:'unconfirmed',readUrl:'',siteUrl:names.length===1?b.translatorUrl||'':'',notes:''}));}
function assemble(b,related){const original=byId.get(Number(b.id));const value={...original,...(edits[b.id]||{})};const result=legacyEditions(value);const added=[];const duplicate=[];const bad=[];
 for(const i of related){if(!i.name||i.category.type==='unsupported'){bad.push(i.title);continue;}
 const field=i.category.type,url=i.url;let index=result.findIndex(e=>e[field]&&e[field].replace(/\/$/,'').toLowerCase()===url.replace(/\/$/,'').toLowerCase());
 if(index!==-1){duplicate.push(i.title);continue;}
 const nameNorm=norm(i.name);
 index=result.findIndex(e=>norm(e.name)===nameNorm&&!e[field]);
 if(index===-1&&i.category.type==='siteUrl'&&result.length===1&&!result[0][field]&&!/\/(user|author|translator)\//i.test(new URL(url).pathname))index=0;
 if(index===-1){if(result.length>=12){bad.push(i.title+' (12-edition limit)');continue;}index=result.length;result.push({name:i.name,label:'CG relocation listing',language:'English',status:'unconfirmed',readUrl:'',siteUrl:'',notes:''});}
 result[index][field]=url;
 const provenance='Historic CG relocation list; link not live-verified.';
 const old=result[index].notes||'';result[index].notes=(old.includes(provenance)?old:(old?[old,provenance].join(' · '):provenance)).slice(0,280);
 added.push(i.title);
 }
 return {translations:result,added,duplicate,bad};
}
async function apply(){if(working||!editable||!$('ack').checked)return;const chosen=items.filter(x=>x.selected&&x.bookId&&x.name&&x.category.type!=='unsupported');if(!chosen.length)return;
 const groups=new Map();for(const i of chosen){if(!groups.has(i.bookId))groups.set(i.bookId,[]);groups.get(i.bookId).push(i);}
 stopAfter=false;working=true;$('stop').disabled=false;$('progress').style.display='block';let finished=0,changed=0,duplicate=0,failures=[];updateApply();
 for(const [id,related] of groups){if(stopAfter)break;const result=assemble({id},related);duplicate+=result.duplicate.length;if(result.bad.length)failures.push(`#${id}: ${result.bad.join(', ')}`);
 if(result.added.length){try{const patch=await adminPost(id,result.translations);edits[id]={...(edits[id]||{}),...patch};changed++;for(const item of related){if(result.added.includes(item.title)){item.selected=false;item.warning='Saved; original link still needs live verification.';}}}catch(e){failures.push(`#${id}: ${e.message}`);}}
 finished++;$('progress').value=Math.round(100*finished/groups.size);note(`Processed ${finished} of ${groups.size} novels. Saved ${changed} novels; skipped ${duplicate} links already present.${failures.length?'\n'+failures.slice(-3).join('\n'):''}`);
 }
 working=false;$('stop').disabled=true;render();note(`Completed ${finished} of ${groups.size} novels. Updated ${changed} novels. Skipped ${duplicate} duplicate URLs. ${failures.length} warnings/errors.${failures.length?'\n'+failures.slice(0,12).join('\n'):''}\nHistorical links have not been checked for current availability.`);
}
function exportCSV(){const fields=['Title from source','Matched novel id','Matched novel title','Translator/group','Type','URL','Selected','Review required','Source'];const quote=x=>'"'+String(x??'').replace(/"/g,'""')+'"';const lines=[fields,...items.map(i=>[i.title,i.bookId,byId.get(i.bookId)?.title||'',i.name,i.category.type,i.url,i.selected?'yes':'no',i.warning||(!i.bookId?'No exact match':''),i.source])];const blob=new Blob(['\ufeff'+lines.map(row=>row.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download='Novel_Conservatory_CG_Translator_Link_Review.csv';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
$('filter').addEventListener('change',render);$('query').addEventListener('input',render);$('ack').addEventListener('change',updateApply);
$('load-seed').addEventListener('click',()=>loadSeed().catch(e=>note(e.message)));
$('select-exact').addEventListener('click',()=>{for(const i of items)i.selected=!!(i.bookId&&!i.warning&&i.category.type!=='unsupported');render();});
$('clear-checks').addEventListener('click',()=>{for(const i of items)i.selected=false;render()});
$('export').addEventListener('click',exportCSV);
$('parse').addEventListener('click',()=>{const {out,flags}=parsePlainText($('raw').value);const n=addCandidates(out,{source:'Pasted full historical CG directory'});$('parse-note').textContent=`Added ${n} new link-to-title candidates from ${out.length} parsed associations. ${flags.length} discontinuation/status notes detected; these are not automatically treated as the novel's translation status. Review group assignments before selecting. No books changed.`;});
$('upload-txt').addEventListener('change',async e=>{const f=e.target.files[0];if(f){$('raw').value=await f.text();$('parse').click();}});
$('apply').addEventListener('click',apply);$('stop').addEventListener('click',()=>{stopAfter=true;note('Stopping after the current novel is saved.');});
(async()=>{try{const r=await fetch('/api/me',{cache:'no-store'});if(!r.ok)throw Error('Access denied');const j=await r.json();if(!['owner','editor'].includes(j.role))throw Error('Editor permission is required');if(!j.configured)throw Error('Cloudflare D1 is not connected; no changes can be saved');editable=true;status(`Signed in as ${j.email} · ${j.role}. Nothing changes without your confirmation.`,true);
 books=await (await fetch('/admin/catalogue.json',{cache:'no-store'})).json();addBookIndexes();const content=await fetch('/api/content',{cache:'no-store'});if(!content.ok)throw Error('Could not load current edits');for(const e of (await content.json()).edits||[])edits[e.id]=e.patch;addBookIndexes();await loadSeed();await loadStatusNotes();}catch(e){status(`Cannot use translator editor: ${e.message}`,false);}})();
