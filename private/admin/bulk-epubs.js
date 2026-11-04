/* The Novel Conservatory private bulk EPUB attachment tool.
   Runs only from /admin/; all file APIs recheck owner Access JWT server-side. */
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  if (!el('bulk-scan')) return;
  let sourceInput = null, rows = [], stored = {}, isScanning = false, isUploading = false, stopRequested = false;
  let catalogue = [], exactTitles = new Map();
  const maximumFiles = 200, maximumFileBytes = 30000000;
  const normalize = input => String(input ?? '').normalize('NFKC').toLowerCase()
    .replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/&/g,' and ')
    .replace(/[^\p{L}\p{N}]+/gu,'').trim();
  const label = b => `${b.title} (#${b.id})`;
  const fmtSize = bytes => (bytes / 1048576).toFixed(1) + ' MB';
  const setFeedback = (message, error = false) => { el('bulk-feedback').textContent = message; el('bulk-feedback').style.color = error ? '#aa3527' : '#205b53'; };
  const currentBooks = () => (typeof books === 'undefined' ? [] : books).map(b => ({...b, ...(typeof edits === 'undefined' ? {} : (edits[b.id] || {}))}));

  function buildCatalogue() {
    catalogue = currentBooks(); exactTitles = new Map();
    for (const b of catalogue) {
      for (const title of [b.title, b.originalTitle]) {
        const key = normalize(title);
        if (!key) continue;
        if (!exactTitles.has(key)) exactTitles.set(key, []);
        if (!exactTitles.get(key).includes(b.id)) exactTitles.get(key).push(b.id);
      }
    }
    const list = el('bulk-book-choices');
    list.replaceChildren();
    for (const b of catalogue) {
      const item = document.createElement('option'); item.value = label(b);
      list.appendChild(item);
    }
  }

  function resolveTyped(text) {
    const value = String(text || '').trim();
    const match = /\(#([0-9]+)\)$/.exec(value);
    if (match) {
      const b = catalogue.find(x => x.id === Number(match[1]));
      if (b && label(b) === value) return b.id;
    }
    if (/^#[0-9]+$/.test(value)) {
      const id = Number(value.slice(1));
      if (catalogue.some(b => b.id === id)) return id;
    }
    const choices = exactTitles.get(normalize(value)) || [];
    return choices.length === 1 ? choices[0] : null;
  }

  async function epubTitle(file) {
    if (typeof JSZip === 'undefined') throw Error('The local EPUB inspector did not load.');
    const zip = await JSZip.loadAsync(file);
    const container = zip.file('META-INF/container.xml');
    if (!container) throw Error('EPUB container.xml missing');
    const documentXml = new DOMParser().parseFromString(await container.async('string'), 'application/xml');
    if (documentXml.querySelector('parsererror')) throw Error('Invalid EPUB container.xml');
    const fileNode = documentXml.getElementsByTagNameNS('*','rootfile')[0];
    const opfPath = fileNode?.getAttribute('full-path') || '';
    if (!opfPath || opfPath.includes('..')) throw Error('Invalid EPUB manifest path');
    const opfFile = zip.file(opfPath); if (!opfFile) throw Error('EPUB package file missing');
    const opf = new DOMParser().parseFromString(await opfFile.async('string'), 'application/xml');
    if (opf.querySelector('parsererror')) throw Error('Invalid EPUB package XML');
    const metadata = opf.getElementsByTagNameNS('*','metadata')[0];
    const title = metadata?.getElementsByTagNameNS('*','title')[0]?.textContent?.trim() || '';
    const author = metadata?.getElementsByTagNameNS('*','creator')[0]?.textContent?.trim() || '';
    const field = name => metadata?.getElementsByTagNameNS('*',name)[0]?.textContent?.trim() || '';
    const rawDescription=field('description');
    const htmlDoc=new DOMParser().parseFromString(rawDescription,'text/html');
    const description=(htmlDoc.body?.textContent || rawDescription).replace(/\s+/g,' ').trim().slice(0,2000);
    const rawSubjects=Array.from(metadata?.getElementsByTagNameNS('*','subject')||[]).map(n=>n.textContent?.trim()||'').filter(Boolean);
    // Some EPUB exporters place multiple subjects in one semicolon-separated dc:subject field.
    const subjects=[...new Set(rawSubjects.flatMap(s=>s.split(/\s*;\s*/g).map(x=>x.trim().slice(0,75)).filter(Boolean)))].slice(0,24);
    return { title: title.slice(0,240), author: author.slice(0,160), description, subjects };
  }

  async function loadStored() {
    const r = await fetch('/api/private/epub/bulk-status',{credentials:'same-origin',cache:'no-store'});
    const j = await r.json().catch(()=>({error:'Server returned an unexpected response'}));
    if (!r.ok) throw Error(j.error || 'Could not check existing private EPUBs');
    stored = j.files || {};
  }

  function determineStatus(row) {
    if (row.uploaded) return {state:'done', text:row.metadataError?'✓ EPUB saved · ⚠ metadata failed':'✓ EPUB uploaded'+(row.metadataDone?' · tags/summary saved':'')};
    if (row.error) return {state:'error',text:row.error};
    if (!row.id) return {state:'review',text:'Choose a matching novel'};
    const other = rows.some(r => r!==row && !r.uploaded && !r.error && r.id===row.id);
    if (other) return {state:'duplicate',text:'Two files target this novel: resolve duplicates'};
    if (stored[row.id] && !el('bulk-replace').checked) {
      if(el('bulk-auto-metadata').checked && (row.epubDescription||row.epubSubjects.length))return {state:'metadata-only',text:'Already stored · add summary/tags only'};
      return {state:'existing',text:'Already stored · skipped'};
    }
    return {state:'ready',text:stored[row.id]?'Will replace existing EPUB':'Ready to upload'};
  }

  function refreshStatus() {
    let ready=0, skip=0;
    for (const row of rows) {
      const s=determineStatus(row); row.state=s.state;
      if (row.statusElement) row.statusElement.textContent=s.text;
      if (s.state==='ready'||s.state==='metadata-only') ready++;
      else if (s.state==='existing')skip++;
    }
    el('bulk-start').disabled = !ready || isUploading || isScanning;
    return {ready,skip};
  }

  function drawRows() {
    const body = el('bulk-rows'); body.replaceChildren();
    if (!rows.length) {
      const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=3;td.style.padding='14px';td.textContent='No EPUBs inspected yet.';tr.append(td);body.append(tr);return;
    }
    for (const row of rows) {
      const tr=document.createElement('tr');tr.style.borderBottom='1px solid #e8eeea';
      const a=document.createElement('td'),b=document.createElement('td'),c=document.createElement('td');
      for(const cell of [a,b,c])cell.style.padding='9px';
      a.style.minWidth='155px';a.style.maxWidth='270px';a.style.overflowWrap='anywhere';
      const title=document.createElement('strong');title.textContent=row.file.name;a.append(title);
      const subtitle=document.createElement('div');subtitle.style.cssText='font-size:11px;color:#607267;margin-top:3px';
      subtitle.textContent=`${fmtSize(row.file.size)} · ${row.epubTitle ? 'EPUB title: '+row.epubTitle : row.error ? 'Cannot inspect EPUB' : 'Filename match only'}`;a.append(subtitle);
      if(row.epubAuthor){const s=document.createElement('div');s.style.cssText='font-size:11px;color:#607267';s.textContent='Author: '+row.epubAuthor;a.append(s);}
      if(row.epubDescription || row.epubSubjects.length){
        const details=document.createElement('details');details.style.marginTop='5px';
        const summary=document.createElement('summary');summary.style.cssText='font-size:11px;color:#205b53;cursor:pointer';
        summary.textContent=(row.epubDescription?'Summary':'No summary')+' · '+row.epubSubjects.length+' tags found';
        const body=document.createElement('div');body.style.cssText='font-size:11px;line-height:1.35;max-height:145px;overflow:auto;padding:6px 0;color:#53675d';
        body.textContent=(row.epubDescription?row.epubDescription.slice(0,380)+(row.epubDescription.length>380?'…':''):'No embedded summary')+'\n'+row.epubSubjects.join(' · ');
        body.style.whiteSpace='pre-line'; details.append(summary,body);a.append(details);
      }

      const input=document.createElement('input'); input.type='search';input.setAttribute('list','bulk-book-choices');input.placeholder='Select a catalogue title or type #ID';
      input.style.cssText='min-width:160px;width:100%;font-size:12px';
      input.value=row.id ? label(catalogue.find(book=>book.id===row.id)) : '';
      input.disabled=!!row.error||row.uploaded;
      input.setAttribute('aria-label','Match '+row.file.name+' to a catalogue novel');
      input.addEventListener('change',()=>{row.id=resolveTyped(input.value);if(row.id)input.value=label(catalogue.find(book=>book.id===row.id));refreshStatus()});
      b.append(input);
      row.statusElement=document.createElement('span');row.statusElement.style.cssText='font-size:12px';c.append(row.statusElement);
      if(row.metadataError){const retry=document.createElement('button');retry.type='button';retry.style.cssText='display:block;margin-top:6px;padding:5px 7px;font-size:11px';retry.textContent='Retry metadata';retry.disabled=isUploading;
        retry.addEventListener('click',async()=>{retry.disabled=true;try{await saveMetadata(row);setFeedback('Recovered metadata for '+row.file.name+'.')}catch(e){row.metadataError=String(e.message||e).slice(0,100);setFeedback(row.metadataError,true)}drawRows();});c.append(retry);}
      tr.append(a,b,c);body.append(tr);
    }
    refreshStatus();
  }

  el('bulk-files').addEventListener('change',() => { sourceInput=el('bulk-files');el('bulk-folder').value='';setFeedback(`${sourceInput.files.length} files selected. Click Review files & match novels.`); });
  el('bulk-folder').addEventListener('change',() => { sourceInput=el('bulk-folder');el('bulk-files').value='';setFeedback(`${sourceInput.files.length} items selected from folder. Click Review files & match novels.`); });
  el('bulk-replace').addEventListener('change',refreshStatus);
  el('bulk-auto-metadata').addEventListener('change',refreshStatus);

  el('bulk-scan').addEventListener('click',async()=>{
    if (isScanning||isUploading) return;
    if (typeof currentRole==='undefined'||currentRole!=='owner')return setFeedback('Only the owner can bulk upload private EPUBs.',true);
    const files=Array.from(sourceInput?.files||[]).filter(f=>/\.epub$/i.test(f.name));
    if (!files.length)return setFeedback('Choose EPUB files first. Other file types are ignored.',true);
    if (files.length>maximumFiles)return setFeedback(`Choose up to ${maximumFiles} EPUBs per batch.`,true);
    buildCatalogue();
    if (!catalogue.length)return setFeedback('Catalogue is still loading. Try again after the book list appears.',true);
    isScanning=true;el('bulk-scan').disabled=true;el('bulk-start').disabled=true;rows=[];drawRows();
    el('bulk-progress').classList.remove('hidden');el('bulk-bar').value=0;el('bulk-count').textContent='Checking stored EPUBs…';
    try {
      await loadStored();
      for (let i=0;i<files.length;i++) {
        const file=files[i];const row={file,id:null,epubTitle:'',epubAuthor:'',epubDescription:'',epubSubjects:[],error:'',uploaded:false,metadataDone:false,metadataError:'',statusElement:null};
        if(file.size>maximumFileBytes)row.error='File exceeds 30 MB';
        else if(file.size<100)row.error='EPUB is too small to be valid';
        else try{const meta=await epubTitle(file);row.epubTitle=meta.title;row.epubAuthor=meta.author;row.epubDescription=meta.description;row.epubSubjects=meta.subjects;}catch(err){row.error='Invalid EPUB: '+String(err.message||'could not read').slice(0,95);}
        if(!row.error){
          const fname=file.name.replace(/\.epub$/i,'');
          const candidates=[row.epubTitle,fname].filter(Boolean);
          for (const candidate of candidates){const ids=exactTitles.get(normalize(candidate))||[];if(ids.length===1){row.id=ids[0];break;}}
        }
        rows.push(row);
        el('bulk-count').textContent=`Inspecting EPUB ${i+1} of ${files.length}`;el('bulk-bar').value=Math.round((i+1)/files.length*100);
        await Promise.resolve();
      }
      drawRows();const {ready,skip}=refreshStatus();
      setFeedback(`Reviewed ${rows.length} EPUBs. ${ready} ready; ${skip} already stored and skipped. Correct any unmatched titles, then upload.`);
    } catch(err){rows=[];drawRows();setFeedback(`No uploads started: ${err.message||err}`,true);}
    finally{isScanning=false;el('bulk-scan').disabled=false;refreshStatus();}
  });

  async function saveMetadata(row){
    if(!row.epubDescription && !row.epubSubjects.length){row.metadataDone=true;row.metadataError='';return;}
    const base=catalogue.find(b=>b.id===row.id)||{};
    const resp=await fetch('/api/private/epub/metadata?id='+row.id,{
      method:'POST',credentials:'same-origin',cache:'no-store',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({description:row.epubDescription,subjects:row.epubSubjects,baseSynopsis:base.synopsis||'',baseTags:base.tags||[]})
    });
    const result=await resp.json().catch(()=>({error:'Metadata server returned an invalid response'}));
    if(!resp.ok)throw Error(result.error||'Could not save EPUB metadata.');
    if(result.changed){
      if(typeof edits!=='undefined')edits[row.id]=result.patch;
      const i=catalogue.findIndex(b=>b.id===row.id);if(i>=0)catalogue[i]={...catalogue[i],...result.patch};
      if(typeof selected!=='undefined'&&selected===row.id&&typeof selectBook==='function')selectBook(row.id);
    }
    row.metadataDone=true;row.metadataError='';
  }

  el('bulk-start').addEventListener('click',async()=>{
    if(isUploading||isScanning||currentRole!=='owner')return;
    const ready=rows.filter(row=>['ready','metadata-only'].includes(determineStatus(row).state));
    if(!ready.length)return setFeedback('No matched files ready to upload.',true);
    const replacements=ready.filter(row=>stored[row.id]&&determineStatus(row).state==='ready').length;
    const metaOnlyCount=ready.filter(row=>determineStatus(row).state==='metadata-only').length;
    const uploadCount=ready.length-metaOnlyCount;
    const auto=el('bulk-auto-metadata').checked;
    const message=`Upload ${uploadCount} private EPUB(s) and update metadata for ${metaOnlyCount} already-stored EPUB(s)? ${replacements} existing EPUB(s) will be REPLACED. Unmatched or duplicate entries will be skipped. ${auto?'Embedded summaries and subject tags will be added to visible profiles as UNREVIEWED metadata.':'Book metadata will not be changed.'} EPUB text and downloads stay owner-only. Continue?`;
    if(!confirm(message))return;
    stopRequested=false;isUploading=true;el('bulk-start').disabled=true;el('bulk-scan').disabled=true;el('bulk-stop').disabled=false;
    el('bulk-progress').classList.remove('hidden');el('bulk-bar').value=0;
    let success=0,fail=0;
    for(let i=0;i<ready.length;i++){
      if(stopRequested)break;
      const row=ready[i];const state=determineStatus(row);
      if(!['ready','metadata-only'].includes(state.state))continue;
      row.statusElement.textContent=state.state==='metadata-only'?'Saving summary and tags…':'Uploading…';
      try{
        if(state.state==='ready'){
          const resp=await fetch('/api/private/epub/upload?id='+row.id,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/epub+zip','x-epub-name':encodeURIComponent(row.file.name)},body:row.file});
          const result=await resp.json().catch(()=>({error:'Invalid server response'}));
          if(!resp.ok)throw Error(result.error||`Upload failed (${resp.status})`);
          row.uploaded=true;stored[row.id]={name:row.file.name,size:row.file.size};success++;
        }else{row.uploaded=true;}
        if(auto){
          row.statusElement.textContent='EPUB stored; saving summary and tags…';
          try{await saveMetadata(row);}catch(e){row.metadataError='Metadata failed: '+String(e.message||e).slice(0,95);}
        }
      }catch(err){row.error='Upload failed: '+String(err.message||err).slice(0,90);fail++;}
      el('bulk-count').textContent=`Processed ${i+1} of ${ready.length} · ${success} uploaded · ${fail} failed`;
      el('bulk-bar').value=Math.round((i+1)/ready.length*100);
      refreshStatus();
    }
    isUploading=false;el('bulk-scan').disabled=false;el('bulk-stop').disabled=true;
    const remaining=rows.filter(r=>['ready','metadata-only'].includes(determineStatus(r).state)).length;
    const metaFailed=rows.filter(r=>r.metadataError).length;
    setFeedback(`${success} EPUB(s) uploaded, ${metaOnlyCount} existing EPUB(s) metadata-only, ${fail} file(s) failed, ${metaFailed} metadata save(s) need retry${stopRequested?', stopped early':''}. ${remaining} still ready. Open a novel in Edit Library to delete or correct imported tags and descriptions.`,fail>0||metaFailed>0);
    drawRows();refreshStatus();
    if(typeof selected!=='undefined'&&selected&&typeof loadEpubStatus==='function')loadEpubStatus(selected);
  });
  el('bulk-stop').addEventListener('click',()=>{stopRequested=true;el('bulk-stop').disabled=true;setFeedback('Stopping after the current file finishes…');});
})();
