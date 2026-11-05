/* Shared, client-side EPUB metadata reader and conservative catalogue matcher.
   Never sends chapter text or file bytes to a matching service. */
(function(){
'use strict';
const norm=value=>String(value??'').normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/['‘’]/g,'').replace(/[^\p{L}\p{N}]+/gu,'');
const trim=value=>String(value??'').trim();
const filenameTitle=name=>trim(String(name||'').replace(/^.*[\\/]/,'').replace(/\.epub$/i,'').replace(/_/g,' ').replace(/\s+/g,' ')).slice(0,210);
function variants(value){
 const title=trim(value);if(!title)return [];
 const choices=[title];
 const withoutTail=title.replace(/\s*(?:\[(?:[^\]]{1,80})\]|\((?:translation|fan translation|complete|completed|v\d+(?:\.\d+)?|volume \d+)\))\s*$/i,'').trim();
 if(withoutTail!==title)choices.push(withoutTail);
 const beforeEdition=title.replace(/\s+[-–—|]\s+(?:(?:translated by|translation|fan translation|edition|complete|completed|vol(?:ume)?\s*\d+|v\d+)\b.*)$/i,'').trim();
 if(beforeEdition!==title)choices.push(beforeEdition);
 const withoutVolume=title.replace(/\s*(?:[-–—:|]?\s*)\b(?:vol(?:ume)?|book|part)\s*\.?\s*(?:\d+|[ivxlcdm]+)\s*$/i,'').trim();
 if(withoutVolume&&withoutVolume!==title)choices.push(withoutVolume);
 const afterBracket=title.replace(/^\s*\[(?:translation|fan translation|epub|team [^\]]+|group [^\]]+)\]\s*/i,'');
 if(afterBracket!==title)choices.push(afterBracket);
 for(const candidate of [...choices]){
  const article=candidate.replace(/^(?:the|an|a)\s+/i,'').trim();
  if(article!==candidate&&article)choices.push(article);
 }
 return [...new Set(choices.map(norm).filter(Boolean))];
}
const els=(doc,name)=>[...doc.getElementsByTagName('*')].filter(node=>node.localName===name);
const genreNames=new Set(['action','adventure','comedy','drama','fantasy','historical','horror',
 'martial arts','mystery','psychological','romance','sci-fi','science fiction',
 'slice of life','sports','supernatural','tragedy','wuxia','xianxia','xuanhuan']);
function novelUpdatesUrl(value){
 try{
  const url=new URL(trim(value));
  if(url.protocol!=='https:'||!['novelupdates.com','www.novelupdates.com'].includes(url.hostname)
     ||url.username||url.password||url.port||url.search||url.hash)return '';
  const match=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/i.exec(url.pathname);
  return match?'https://www.novelupdates.com/series/'+match[1].toLowerCase()+'/':'';
 }catch{return ''}
}
// Some EPUBs package tags on an "About", "Metadata" or title page
// instead of in OPF dc:subject. Read only small, explicitly named
// front-matter XHTML files and only LABELLED fields, never story chapters.
async function structuredFrontMatter(zip,opf,packagePath){
 const result={tags:[],genres:[],nuUrl:'',synopsis:''};
 const parent=packagePath.includes('/')?packagePath.slice(0,packagePath.lastIndexOf('/')+1):'';
 const items=els(opf,'item').filter(node=>{
  const href=trim(node.getAttribute('href'));
  return /(?:\.xhtml|\.html)$/i.test(href)&&
   /(?:^|[/_.-])(?:title|about|metadata|meta|info|introduction|intro|frontmatter|front-matter|description|summary|credits)(?:[/_.-]|$)/i.test(href)&&
   !href.includes('..')&&!href.startsWith('/');
 }).slice(0,4);
 const split=value=>trim(value).split(/\s*[,;|\n]\s*/).map(x=>trim(x).slice(0,70))
  .filter(x=>x.length>=2&&x.length<=70);
 const add=(field,value)=>{
  if(field==='tags')result.tags.push(...split(value));
  if(field==='genres')result.genres.push(...split(value));
  if(field==='nuUrl'&&!result.nuUrl){
   const raw=trim(value).match(/https:\/\/(?:www\.)?novelupdates\.com\/series\/[a-z0-9-]+\/?/i)?.[0];
   if(raw)result.nuUrl=novelUpdatesUrl(raw);
  }
  if(field==='synopsis'&&!result.synopsis)result.synopsis=trim(value).slice(0,6000);
 };
 const fieldOf=label=>{
  const key=trim(label).replace(/[:：\s-]+$/,'').toLowerCase();
  return /^(?:tags?|tropes?|subjects?|keywords?)$/.test(key)?'tags':
   /^(?:genres?|categories)$/.test(key)?'genres':
   /^(?:novel updates|novelupdates|nu link|series url)$/.test(key)?'nuUrl':
   /^(?:synopsis|summary|description)$/.test(key)?'synopsis':'';
 };
 for(const item of items){
  const href=trim(item.getAttribute('href'));
  const entry=zip.file(parent+href);
  if(!entry||entry.dir||Number(entry._data?.uncompressedSize||0)>200000)continue;
  try{
   const dom=new DOMParser().parseFromString(await entry.async('text'),'text/html');
   const rows=[...dom.querySelectorAll('tr')].slice(0,70);
   for(const row of rows){
    const cells=[...row.querySelectorAll('th,td')];
    if(cells.length>=2){
     const field=fieldOf(cells[0].textContent);
     if(field)add(field,cells.slice(1).map(x=>x.textContent).join(', '));
    }
   }
   for(const node of [...dom.querySelectorAll('p,li,dd,dt')].slice(0,140)){
    const line=trim(node.textContent).replace(/\s+/g,' ').slice(0,4000);
    const match=/^([^:：]{2,28})\s*[:：]\s*(.+)$/.exec(line);
    if(match){const field=fieldOf(match[1]);if(field)add(field,match[2]);}
   }
  }catch{/* A broken optional front-matter page must not fail the EPUB upload. */}
 }
 result.tags=[...new Set(result.tags)].slice(0,100);
 result.genres=[...new Set(result.genres)].slice(0,50);
 return result;
}
async function inspect(file){
 const fallback={title:'',author:'',synopsis:'',tags:[],genres:[],nuUrl:'',language:'',metadataFound:false};
 if(!file||file.size>250*1048576||typeof JSZip==='undefined')return fallback;
 try{
  const zip=await JSZip.loadAsync(file),container=zip.file('META-INF/container.xml');
  if(!container)return fallback;
  const xml=new DOMParser().parseFromString(await container.async('text'),'application/xml');
  const path=els(xml,'rootfile')[0]?.getAttribute('full-path');
  if(!path||path.startsWith('/')||path.includes('..')||!path.toLowerCase().endsWith('.opf'))return fallback;
  const opf=zip.file(path);if(!opf)return fallback;
  const metadata=new DOMParser().parseFromString(await opf.async('text'),'application/xml');
  if(els(metadata,'parsererror').length)return fallback;
  const value=(name,max)=>trim(els(metadata,name)[0]?.textContent).slice(0,max);
  // Calibre and many fan-made EPUBs put the entire subject catalogue in a
  // single dc:subject or meta[name="calibre:tags"] record. Split explicit
  // lists, rather than treating twenty labels as one huge unsearchable tag.
  const tagFields=[
   ...els(metadata,'subject').map(x=>trim(x.textContent)),
   ...els(metadata,'meta').filter(x=>/^(?:calibre:tags|tags|keywords|subject|genre)$/i.test(
    trim(x.getAttribute('name')||x.getAttribute('property')||'')))
    .map(x=>trim(x.getAttribute('content')||x.textContent))
  ];
  let tags=[...new Set(tagFields.flatMap(x=>x.split(/\s*[,;|\n]\s*/))
   .map(x=>trim(x).slice(0,70)).filter(Boolean))].slice(0,100);
  // Genre is taken only from explicit embedded subject/type labels. Never
  // infer genre or tropes from chapter prose or the book's title.
  const candidateGenres=[...tags,...els(metadata,'type').map(x=>trim(x.textContent))];
  let genres=[...new Set(candidateGenres.map(x=>x.replace(/\s+/g,' ').trim()).filter(
   x=>genreNames.has(x.toLowerCase())))].slice(0,20);
  const possibleSources=[
   ...els(metadata,'identifier').map(x=>trim(x.textContent)),
   ...els(metadata,'source').map(x=>trim(x.textContent)),
   ...els(metadata,'relation').map(x=>trim(x.textContent)),
   ...els(metadata,'meta').flatMap(x=>[
    trim(x.getAttribute('content')),trim(x.textContent)])
  ];
  let nuUrl=possibleSources.map(novelUpdatesUrl).find(Boolean)||'';
  const front=await structuredFrontMatter(zip,metadata,path);
  tags=[...new Set([...tags,...front.tags])].slice(0,100);
  genres=[...new Set([...genres,...front.genres])].slice(0,50);
  nuUrl=nuUrl||front.nuUrl;
  return {title:value('title',210),author:value('creator',140),
   synopsis:value('description',6000)||front.synopsis,tags,genres,nuUrl,language:value('language',40),
   metadataFound:true};
 }catch{return fallback}
}
function resolve(file,metadata,books){
 const fileTitle=filenameTitle(file?.name);
 const embeddedTitle=trim(metadata?.title);
 const meaningless=value=>/^(?:epub|ebook|book|untitled|unknown|volume|chapter|novel)(?:\s*\d+)?$/i.test(value);
 const sourceTitle=meaningless(embeddedTitle)?'':embeddedTitle;
 const parts=[...variants(sourceTitle),...variants(fileTitle)];
 const sourceNu=novelUpdatesUrl(metadata?.nuUrl);
 if(sourceNu){
  const exact=books.filter(b=>novelUpdatesUrl(b.nuUrl)===sourceNu);
  if(exact.length===1)return {kind:'matched',bookId:Number(exact[0].id),
   title:sourceTitle||fileTitle,reason:'Matching canonical Novel Updates series URL'};
  if(exact.length>1)return {kind:'ambiguous',bookId:null,
   title:sourceTitle||fileTitle,candidates:exact.map(x=>x.id),
   reason:'Multiple catalogue entries use this Novel Updates URL. Resolve duplicates first.'};
 }
 const index=new Map();
 for(const b of books){
  for(const name of [b.title,b.originalTitle]){
   for(const key of variants(name)){
    const members=index.get(key)||new Set();members.add(Number(b.id));index.set(key,members);
   }
  }
 }
 const matches=new Map();
 for(const key of parts){
  for(const id of index.get(key)||[])matches.set(id,(matches.get(id)||0)+1);
 }
 if(matches.size){
  const found=[...matches.keys()];
  if(found.length===1){
   const candidate=books.find(b=>Number(b.id)===found[0]);
   const author=norm(metadata?.author),current=norm(candidate?.author);
   const otherNu=novelUpdatesUrl(candidate?.nuUrl);
   if(sourceNu&&otherNu&&sourceNu!==otherNu)return {kind:'ambiguous',bookId:null,
    title:sourceTitle||fileTitle,candidates:found,
    reason:'Title matches but the novels have different Novel Updates series URLs'};
   if(author&&current&&author!==current)return {kind:'ambiguous',bookId:null,
    title:sourceTitle||fileTitle,candidates:found,
    reason:'Title matches, but EPUB author conflicts with the catalogue'};
   return {kind:'matched',bookId:found[0],title:sourceTitle||fileTitle,reason:'Matched catalogue title'};
  }
  // Same name can refer to different works. The EPUB author can
  // disambiguate, but otherwise the editor must choose.
  const author=norm(metadata?.author);
  const authors=author?books.filter(b=>found.includes(Number(b.id))&&norm(b.author)===author):[];
  if(authors.length===1)return {kind:'matched',bookId:Number(authors[0].id),title:sourceTitle||fileTitle,reason:'Matched title and EPUB author'};
  return {kind:'ambiguous',title:sourceTitle||fileTitle,bookId:null,candidates:found,reason:'Multiple novels share this title'};
 }
 const title=sourceTitle||fileTitle;
 const key=norm(title);
 if(key.length<5||/^(?:epub|ebook|book|untitled|unknown|volume|chapter|novel)(?:\d+)?$/.test(key))
  return {kind:'ambiguous',title,bookId:null,candidates:[],reason:'No usable book title was found in the EPUB'};
 return {kind:'new',bookId:null,title,reason:'No catalogue match; create a private novel entry'};
}
function createPayload(match,meta){
 return {
  title:trim(match.title).slice(0,210),
  author:trim(meta?.author).slice(0,140),
  synopsis:trim(meta?.synopsis).slice(0,6000),
  tags:Array.isArray(meta?.tags)?meta.tags.slice(0,100):[],
  genres:Array.isArray(meta?.genres)?meta.genres.slice(0,20):[],
  nuUrl:novelUpdatesUrl(meta?.nuUrl),
  metadataSource:meta?.metadataFound?'EPUB embedded metadata':'EPUB filename',
  language:trim(meta?.language)||'English',translation:'unconfirmed',publish:false
 };
}
window.ConservatoryEPUBMatch={norm,filenameTitle,variants,inspect,resolve,createPayload,novelUpdatesUrl};
})();