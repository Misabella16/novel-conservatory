/* The Fic Annex web reader. Scripted EPUB content remains disabled. */
'use strict';
const el=id=>document.getElementById(id);
const params=new URLSearchParams(location.search);
const id=params.get('id');
const validId=/^[1-9][0-9]{0,9}$/.test(id||'')&&Number(id)>=1;
let epubBook=null,rendition=null,toc=[],lastCfi='',readingSize=110,currentTheme='cream';
const safe=x=>String(x??'');
const prefKey='conservatory-reader-prefs';
const editionParam=params.get('edition')||'legacy';
let activeEdition=params.get('edition')||'legacy';
const positionKey=()=>`conservatory-position-${id}-${activeEdition}`;
function message(text){el('reading-status').textContent=text;}
function error(text){el('loading').classList.add('hidden');el('error-message').textContent=text;el('error-message').classList.remove('hidden');message('Unable to open this EPUB');}
function rememberPrefs(){try{localStorage.setItem(prefKey,JSON.stringify({theme:el('theme').value,size:+el('font-size').value,font:el('font-family').value,width:el('reading-width').value}))}catch{}}
function loadPrefs(){try{const p=JSON.parse(localStorage.getItem(prefKey)||'{}');if(['cream','light','dark'].includes(p.theme))el('theme').value=p.theme;if(Number.isInteger(p.size)&&p.size>=80&&p.size<=180)el('font-size').value=p.size;if(['Georgia, serif','system-ui, sans-serif'].includes(p.font))el('font-family').value=p.font;if(['500','660','860'].includes(p.width))el('reading-width').value=p.width}catch{}}
function setTheme(){currentTheme=el('theme').value;document.body.dataset.theme=currentTheme;const colors=currentTheme==='dark'?{fg:'#e9eee8',bg:'#1f2927',link:'#b5d8bc'}:currentTheme==='light'?{fg:'#26313a',bg:'#ffffff',link:'#355e84'}:{fg:'#283c34',bg:'#fffdf8',link:'#235b51'};
if(rendition){rendition.themes.default({'body':{'color':`${colors.fg} !important`,'background':`${colors.bg} !important`,'font-family':`${el('font-family').value} !important`,'font-size':`${el('font-size').value}% !important`,'line-height':'1.75 !important'},'a':{'color':`${colors.link} !important`}});rendition.themes.font(el('font-family').value);rendition.themes.fontSize(el('font-size').value+'%');}
el('font-size-output').value=el('font-size').value+'%';document.documentElement.style.setProperty('--reading-width',el('reading-width').value+'px');rememberPrefs();}
function chapterIndex(){const current=rendition?.currentLocation()?.start?.href;if(!current)return -1;return toc.findIndex(t=>t.href?.split('#')[0]===current.split('#')[0]);}
function updateChapter(loc){const href=loc?.start?.href;if(!href)return;const i=toc.findIndex(t=>t.href?.split('#')[0]===href.split('#')[0]);if(i>=0){el('chapter-menu').value=String(i);el('chapter-position').textContent=toc[i].label||`Chapter ${i+1}`}else{el('chapter-position').textContent='Reading…'}
const cfi=loc?.start?.cfi;if(cfi){lastCfi=cfi;try{localStorage.setItem(positionKey(),cfi)}catch{}}}
function addNav(list,depth=0){for(const item of list||[]){toc.push({label:'  '.repeat(depth)+(item.label||'Chapter'),href:item.href||''});if(item.subitems?.length)addNav(item.subitems,depth+1)}}
async function gotoChapter(i){if(!rendition||!toc[i])return;message('Opening '+toc[i].label.trim()+'…');await rendition.display(toc[i].href);message('Reading');}
async function init(){
 if(!validId)return error('Invalid story link. Return to the catalogue and open the story again.');
 try{
  const r=await fetch('/api/novel/resolve?id='+encodeURIComponent(id),{cache:'no-store'});
  if(r.ok){
   const canonical=await r.json();
   if(canonical.id&&String(canonical.id)!==String(id)){
    params.set('id',String(canonical.id));
    location.replace('/read/?'+params.toString());
    return;
   }
  }
 }catch{}
 if(typeof ePub!=='function')return error('The reader library could not load. Check your internet connection or try again.');loadPrefs();setTheme();
try{
 const [infoResponse,catalogueResponse,profileResponse,editionsResponse]=await Promise.all([(Number(id)>962?Promise.resolve(new Response(JSON.stringify({name:'Additional novel'}),{status:200,headers:{'content-type':'application/json'}})):fetch('/api/private/epub/status?id='+id,{cache:'no-store'})),fetch('/api/content',{cache:'no-store'}),fetch('/api/me',{cache:'no-store'}),fetch('/api/private/edition/list?id='+id,{cache:'no-store'})]);
 if(!infoResponse.ok)throw Error('This account is not approved to read EPUBs, or library sharing is disabled.');
 const info=await infoResponse.json();
 const editionsData=editionsResponse.ok?await editionsResponse.json():{editions:[]};
 const editions=editionsData.editions||[];
 const requested=editions.find(x=>x.id===editionParam)||editions[0];
 if(!requested)throw Error('No EPUB stored for this novel.');
 const editionId=requested.id;activeEdition=editionId;
 const picker=el('edition-picker');picker.replaceChildren();for(const entry of editions){const o=document.createElement('option');o.value=entry.id;o.textContent=entry.label+(entry.translator?' · '+entry.translator:'')+' · '+entry.language;o.selected=entry.id===editionId;picker.append(o)}
 picker.addEventListener('change',()=>{location.href='/read/?id='+encodeURIComponent(id)+'&edition='+encodeURIComponent(picker.value)});
 // Readable catalogue changes are public to all invited site visitors.
 // The editor-only static catalogue is intentionally not requested here.
 const content=catalogueResponse.ok?await catalogueResponse.json():{};
 const novel=Number(id)>962?(content.additional||[]).find(x=>x.id===Number(id))||{}:(content.edits||[]).find(x=>x.id===Number(id))?.patch||{};
 el('fic-title').textContent=novel.title||info.name||'My novel';document.title=(novel.title||'Reading')+' · The Novel Conservatory';el('fic-author').textContent='by '+(novel.author||'Unknown author');
 if(novel.nuUrl){el('source-link').href=novel.nuUrl;el('source-link').classList.remove('hidden')}
 const profile=profileResponse.ok?await profileResponse.json():{};
 const fileUrl=editionId==='legacy'?'/api/private/epub/file?id='+id:'/api/private/edition/file?id='+id+'&edition='+encodeURIComponent(editionId);
 if(profile.role==='owner'){el('download').href=fileUrl+'&download=1';el('download').classList.remove('hidden');}
 message('Opening private EPUB…');
 const response=await fetch(fileUrl,{credentials:'same-origin',cache:'no-store'});
 if(!response.ok){const d=await response.json().catch(()=>({}));throw Error(d.error||'You do not have permission to open this file.');}
 const bytes=await response.arrayBuffer();
 epubBook=ePub(bytes);
 await epubBook.ready;
 try{const m=await epubBook.loaded.metadata;if(m.title){el('fic-title').textContent=m.title;document.title=m.title+' · The Novel Conservatory';}if(m.creator)el('fic-author').textContent='by '+m.creator;}catch{}
 rendition=epubBook.renderTo('book-area',{width:'100%',height:'100%',flow:'scrolled-doc',spread:'none',allowScriptedContent:false});
 setTheme();rendition.on('relocated',updateChapter);
 const nav=await epubBook.loaded.navigation;addNav(nav.toc);
 el('chapter-menu').replaceChildren();if(!toc.length){const o=document.createElement('option');o.textContent='Chapters unavailable';el('chapter-menu').append(o)}else for(let i=0;i<toc.length;i++){const opt=document.createElement('option');opt.value=String(i);opt.textContent=toc[i].label;el('chapter-menu').append(opt)}
 let last='';try{last=localStorage.getItem(positionKey())||''}catch{}
 try{await rendition.display(last||undefined)}catch{await rendition.display()}
 el('loading').classList.add('hidden');message(last?'Resumed where you left off':'Reading');
 }catch(e){error(e.message||'Could not open the EPUB.')}}
el('settings-button').addEventListener('click',()=>{const panel=el('settings-panel'),opening=panel.classList.contains('hidden');panel.classList.toggle('hidden',!opening);el('settings-button').setAttribute('aria-expanded',String(opening))});
for(const input of ['theme','font-family','reading-width'])el(input).addEventListener('change',setTheme);
el('font-size').addEventListener('input',setTheme);
el('chapter-menu').addEventListener('change',()=>gotoChapter(Number(el('chapter-menu').value)).catch(e=>error(e.message)));
el('prev-chapter').addEventListener('click',async()=>{if(!rendition)return;const i=chapterIndex();if(i>0)await gotoChapter(i-1);else await rendition.prev()});
el('next-chapter').addEventListener('click',async()=>{if(!rendition)return;const i=chapterIndex();if(i>=0&&i<toc.length-1)await gotoChapter(i+1);else await rendition.next()});
el('reset-position').addEventListener('click',async()=>{try{localStorage.removeItem(positionKey())}catch{}if(rendition){await rendition.display();message('Back at the beginning')}});
window.addEventListener('pagehide',()=>{if(lastCfi){try{localStorage.setItem(positionKey(),lastCfi)}catch{}}});
init();
