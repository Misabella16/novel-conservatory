/* Browser-only EPUB package metadata scanner. No chapter text leaves the browser. */
(()=>{'use strict';
const $=id=>document.getElementById(id);
const show=(message,error=false)=>{const el=$('epub-meta-status');el.textContent=message;el.classList.toggle('error',error);};
const nodes=(xml,name)=>[...xml.getElementsByTagName('*')].filter(n=>n.localName===name);
const first=(xml,name)=>nodes(xml,name)[0]?.textContent?.trim()||'';
async function parse(file){
 if(!file||file.size>250*1048576)throw Error('Select an EPUB under 250 MiB.');
 if(typeof JSZip==='undefined')throw Error('The EPUB ZIP reader is unavailable.');
 const zip=await JSZip.loadAsync(file),container=zip.file('META-INF/container.xml');
 if(!container)throw Error('Missing EPUB package metadata.');
 const c=new DOMParser().parseFromString(await container.async('text'),'application/xml');
 const root=nodes(c,'rootfile')[0]?.getAttribute('full-path');
 if(!root||root.includes('..')||root.startsWith('/')||!root.toLowerCase().endsWith('.opf'))throw Error('Invalid EPUB package location.');
 const f=zip.file(root);if(!f)throw Error('EPUB metadata file missing.');
 const x=new DOMParser().parseFromString(await f.async('text'),'application/xml');
 if(x.querySelector('parsererror'))throw Error('Could not parse embedded metadata.');
 const title=first(x,'title').slice(0,210);
 const author=first(x,'creator').slice(0,140);
 const synopsis=first(x,'description').slice(0,6000);
 const tags=[...new Set(nodes(x,'subject').map(n=>String(n.textContent||'').trim()).filter(Boolean))].slice(0,40);
 return {title,author,synopsis,tags};
}
$('scan-epub-metadata').addEventListener('click',async()=>{
 const file=$('epub-files').files[0];if(!file)return show('Choose an EPUB file first.',true);
 $('scan-epub-metadata').disabled=true;$('epub-metadata-preview').hidden=true;
 try{
  const data=await parse(file);
  $('epub-meta-title').value=data.title;$('epub-meta-author').value=data.author;
  $('epub-meta-synopsis').value=data.synopsis;$('epub-meta-tags').value=data.tags.join(', ');
  $('epub-metadata-preview').hidden=false;
  show('Found embedded metadata in '+file.name+'. Review and save it to the selected novel when ready.'+
       (!data.synopsis?' No embedded synopsis found.':'')+(!data.tags.length?' No subject tags found.':''));
 }catch(e){show(e.message,true)}
 finally{$('scan-epub-metadata').disabled=false}
});
$('apply-epub-metadata').addEventListener('click',async()=>{
 const match=/^#(\d+)\b/.exec($('epub-novel').value.trim());
 if(!match)return show('Select a novel by its #ID first. Metadata will never be applied to an unknown book.',true);
 const id=Number(match[1]);
 if(!Number.isSafeInteger(id)||id<100000)return show('This editor handles additional novels (#100000+). Use the original catalogue editor for the 962 seed novels.',true);
 const title=$('epub-meta-title').value.trim(),author=$('epub-meta-author').value.trim(),
 synopsis=$('epub-meta-synopsis').value.trim(),
 tags=$('epub-meta-tags').value.split(',').map(x=>x.trim()).filter(Boolean).slice(0,40);
 // Never erase existing fields with absent EPUB fields.
 const patch={metadataSource:'EPUB embedded metadata (reviewed)'};
 if(title)patch.title=title;if(author)patch.author=author;if(synopsis)patch.synopsis=synopsis;
 if(tags.length)patch.tags=tags;
 if(!confirm('Save these reviewed metadata fields to novel #'+id+'? This does not publish the EPUB or change its public/private visibility.'))return;
 const button=$('apply-epub-metadata');button.disabled=true;
 try{
  const r=await fetch('/api/admin/additional/edit',{method:'POST',credentials:'same-origin',
   headers:{'content-type':'application/json'},body:JSON.stringify({id,patch})});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Could not save metadata');
  show('Saved reviewed EPUB metadata to novel #'+id+'. Its publication visibility was not changed.');
 }catch(e){show(e.message,true)}finally{button.disabled=false}
});
})();