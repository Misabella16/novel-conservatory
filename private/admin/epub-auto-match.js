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
async function inspect(file){
 const fallback={title:'',author:'',synopsis:'',tags:[],metadataFound:false};
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
  const tags=[...new Set(els(metadata,'subject').map(x=>trim(x.textContent).slice(0,65)).filter(Boolean))].slice(0,35);
  return {title:value('title',210),author:value('creator',140),synopsis:value('description',6000),tags,metadataFound:true};
 }catch{return fallback}
}
function resolve(file,metadata,books){
 const fileTitle=filenameTitle(file?.name);
 const embeddedTitle=trim(metadata?.title);
 const meaningless=value=>/^(?:epub|ebook|book|untitled|unknown|volume|chapter|novel)(?:\s*\d+)?$/i.test(value);
 const sourceTitle=meaningless(embeddedTitle)?'':embeddedTitle;
 const parts=[...variants(sourceTitle),...variants(fileTitle)];
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
  tags:Array.isArray(meta?.tags)?meta.tags.slice(0,35):[],
  genres:[],metadataSource:meta?.metadataFound?'EPUB embedded metadata':'EPUB filename',
  language:'English',translation:'unconfirmed',publish:false
 };
}
window.ConservatoryEPUBMatch={norm,filenameTitle,variants,inspect,resolve,createPayload};
})();