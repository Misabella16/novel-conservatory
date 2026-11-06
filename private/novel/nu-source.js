/* NU source helpers shared by the private catalogue drawer and novel page.
 * Never fetch Novel Updates directly from a browser. The authorized server
 * lookup can fail with 403/429; manual mobile copy is an explicit fallback. */
(function(root){
'use strict';
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const canonical=value=>{
 try{
  const u=new URL(String(value||'').trim());
  const match=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/i.exec(u.pathname);
  if(u.protocol!=='https:'||!['novelupdates.com','www.novelupdates.com'].includes(u.hostname)||
    u.username||u.password||u.port||u.search||u.hash||!match)return '';
  return 'https://www.novelupdates.com/series/'+match[1].toLowerCase()+'/';
 }catch{return ''}
};
function parseHtml(html,url){
 const doc=new DOMParser().parseFromString(String(html||''),'text/html');
 const first=selectors=>{
  for(const selector of selectors){
   const value=clean(doc.querySelector(selector)?.textContent);
   if(value)return value;
  }
  return '';
 };
 const list=selectors=>{
  const result=[];
  for(const selector of selectors)for(const element of doc.querySelectorAll(selector)){
   const value=clean(element.textContent);
   if(value&&value.length<=100&&!result.some(old=>old.toLowerCase()===value.toLowerCase()))result.push(value);
  }
  return result.slice(0,100);
 };
 let coverUrl='';
 const cover=doc.querySelector('#seriesimg img,.seriesimg img,.series-image img');
 try{
  const raw=cover?.getAttribute('data-src')||cover?.getAttribute('src');
  if(raw){const u=new URL(raw,url);if(u.protocol==='https:')coverUrl=u.href}
 }catch{}
 const translated=first(['#showtranslated','#seriestranslated']).slice(0,80);
 const originalStatus=first(['#showstatus','#seriesstatus']).slice(0,100);
 const chapters=first(['#showchapters','#serieschapters']).slice(0,120);
 const novel={
  nuUrl:canonical(url),title:first(['.seriestitlenu','#edit-title','.series-title']).slice(0,210),
  author:first(['#showauthors','#seriesauthors','.author-content']).slice(0,140),
  originalTitle:first(['#editassociated','#seriesothernames','#showassociated','#seriesassociated']).slice(0,210),
  synopsis:first(['#editdescription','#seriesdescription','.series-description','#showdescription','.seriesdescription']).slice(0,6000),
  genres:list(['#seriesgenre a','#showgenres a','.seriesgenre a']),
  tags:list(['#showtags a','#seriestags a','.seriestags a']),
  nuTranslationSourceStatus:/^(yes|no|completed|ongoing|fully translated|not fully translated)$/i.test(translated)?translated:'',
  nuChapterSourceText:chapters,
  nuOriginalSourceStatus:originalStatus,
  coverUrl
 };
 return novel.nuUrl&&novel.title&&(novel.synopsis||novel.tags.length||novel.genres.length||novel.nuChapterSourceText)?
  {source:'novelupdates-browser-v1',novel}:null;
}
const headings=[
 ['genres',/^(?:genres?|genre)\s*:?\s*(.*)$/i],
 ['tags',/^(?:tags?|story tags|story elements)\s*:?\s*(.*)$/i],
 ['synopsis',/^(?:description|synopsis|summary)\s*:?\s*(.*)$/i],
 ['nuChapterSourceText',/^(?:chapters?|chapters in original|original chapters|chapter count)\s*:?\s*(.*)$/i],
 ['nuTranslationSourceStatus',/^(?:completely translated|fully translated|translation status)\s*:?\s*(.*)$/i],
 ['nuOriginalSourceStatus',/^(?:status in coo|status in country of origin|original publication status)\s*:?\s*(.*)$/i],
 ['author',/^authors?\s*:?\s*(.*)$/i],
 ['title',/^(?:series title|novel title)\s*:?\s*(.*)$/i]
];
function parseCopiedText(text,url,identity={},options={}){
 const raw=String(text||'').replace(/\r/g,'').replace(/\u00a0/g,' ').trim().slice(0,15000);
 if(!raw)throw Error('Paste the copied Novel Updates information first.');
 const mode=['tags','genres','mixed'].includes(options.mode)?options.mode:'mixed';
 const sections={},trim=clean;
 const lines=raw.split(/\n+/).map(line=>trim(line.replace(/\[\s*(?:Edit|[↑⇧⌃▲▼])\s*\]/gi,'')
  .replace(/\s*[↑⇧⌃▲▼]\s*/g,' '))).filter(Boolean);
 let section=mode==='mixed'?'':mode;
 for(const value of lines){
  // The copied page can include ratings or navigation after the tag list.
  // Do not allow unrelated page sections to become source metadata.
  if(/^(?:rating\b|ratings\b|reviews?\b|recommendations?\b|readers?\b|reading list\b|type\b|release frequency\b)/i.test(value)){
   section='';continue;
  }
  let matched=false;
  for(const [key,pattern] of headings){
   const m=pattern.exec(value);
   if(!m)continue;
   section=mode==='mixed'||mode===key||!['genres','tags'].includes(key)?key:'';
   if(section){
    sections[key]=sections[key]||[];
    if(trim(m[1]))sections[key].push(trim(m[1]));
   }
   matched=true;break;
  }
  if(!matched&&section&&(sections[section]||[]).join(' ').length<9500){
   sections[section]=sections[section]||[];
   sections[section].push(value);
  }
 }
 if((mode==='tags'||mode==='genres')&&!sections[mode]?.length){
  // No heading is needed when a user copies only the NU tag/genre links.
  const standalone=lines.filter(value=>!/^(?:genre|tags)\b/i.test(value)&&
   !/^(?:rating|reviews?|type)\b/i.test(value));
  if(standalone.length)sections[mode]=standalone;
 }
 const split=key=>{
  const input=(sections[key]||[]).join(' ');
  if(!input)return {labels:[],unresolved:[]};
  if(!root.ConservatoryNUSplit)
   throw Error('The tag separator did not load. Refresh the novel page and try again.');
  return root.ConservatoryNUSplit.splitLabels(input,key);
 };
 const tags=split('tags'),genres=split('genres');
 const single=(key,max)=>trim((sections[key]||[]).join(' ')).slice(0,max);
 const status=single('nuTranslationSourceStatus',80);
 const novel={
  nuUrl:canonical(url),title:single('title',210)||String(identity.title||'').slice(0,210),
  author:single('author',140)||String(identity.author||'').slice(0,140),
  synopsis:single('synopsis',6000),
  genres:genres.labels,tags:tags.labels,
  nuChapterSourceText:single('nuChapterSourceText',120),
  nuTranslationSourceStatus:/^(yes|no|completed|ongoing|fully translated|not fully translated)$/i.test(status)?status:'',
  nuOriginalSourceStatus:single('nuOriginalSourceStatus',100),
  coverUrl:''
 };
 if(!novel.nuUrl)throw Error('Enter the Novel Updates series URL first.');
 if(!novel.genres.length&&!novel.tags.length&&!novel.synopsis&&!novel.nuChapterSourceText&&
    !novel.nuTranslationSourceStatus&&!novel.nuOriginalSourceStatus&&
    !genres.unresolved.length&&!tags.unresolved.length)
  throw Error('No fields found. Choose “Tags” or “Genres” for copied lists, or include headings when copying several NU sections.');
 return {source:'novelupdates-browser-v1',novel,review:{
  unresolvedTags:tags.unresolved,unresolvedGenres:genres.unresolved,
  recognizedTags:tags.labels.length,recognizedGenres:genres.labels.length,
  mode
 }};
}
async function discover(url){
 const canonicalUrl=canonical(url);
 if(!canonicalUrl)throw Error('Enter a valid Novel Updates series link.');
 const staged=await fetch('/api/admin/nu/staged-by-url?url='+encodeURIComponent(canonicalUrl),
  {credentials:'same-origin',cache:'no-store'}).catch(()=>null);
 if(staged?.ok)return {capture:null,mode:'staged'};
 const response=await fetch('/api/admin/nu/lookup?url='+encodeURIComponent(canonicalUrl),
  {credentials:'same-origin',cache:'no-store'}).catch(()=>null);
 if(!response?.ok)return {capture:null,mode:'blocked'};
 const result=await response.json().catch(()=>({}));
 const capture=parseHtml(result.html,canonicalUrl);
 return capture?{capture,mode:'live'}:{capture:null,mode:'blocked'};
}
root.ConservatoryNUSource=Object.freeze({canonical,parseHtml,parseCopiedText,discover});
})(window);
