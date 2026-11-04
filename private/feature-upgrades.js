// V3: private EPUB editions, multipart imports, follows, in-app notifications,
// editor-approved one-click publication. This code runs ONLY after the existing
// Cloudflare Access JWT and private membership gates.
const EDITION_PART_BYTES=8*1024*1024;
const EDITION_MAX_BYTES=2*1024*1024*1024;
const editionText=(v,n=160)=>String(v??'').trim().slice(0,n);
const editionBook=v=>Number.isInteger(Number(v))&&Number(v)>=1&&Number(v)<=962?Number(v):null;
const editionUuid=v=>/^[0-9a-f-]{36}$/.test(String(v||''))?String(v):'';
const strictOrigin=r=>r.headers.get('Origin')===new URL(r.url).origin;
const editionHeaders={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const editionJson=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:editionHeaders});
const translationRef=v=>String(v||'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ').slice(0,120);
const safeEdition=e=>({id:e.id,novelId:e.novel_id,label:e.label,translator:e.translator,language:e.language,filename:e.filename,size:e.bytes,createdAt:e.created_at,legacy:false});
async function getEditions(env,id){
 const r=await env.DB.prepare('SELECT id,novel_id,label,translator,language,filename,bytes,created_at FROM epub_editions WHERE novel_id=? ORDER BY created_at ASC,id ASC').bind(id).all();
 const rows=(r.results||[]).map(safeEdition);
 const old=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind('private-epub:'+id).first();
 if(old){try{const x=JSON.parse(old.value);if(x.key)rows.unshift({id:'legacy',novelId:id,label:'Original saved edition',translator:'',language:'English',filename:x.name||'book.epub',size:x.size||0,createdAt:x.updatedAt||'',legacy:true});}catch{}}
 return rows;
}
async function followersNotice(env,id,translator,message,type){
 if(!env.DB||!editionBook(id))return;
 const ref=translationRef(translator);
 // SQL-side distinct recipients, one notice per member even when following both.
 const sql=`INSERT INTO conservatory_notifications(id,member_email,novel_id,message,type)
 SELECT lower(hex(randomblob(16))),member_email,?,?,?
 FROM (SELECT DISTINCT member_email FROM conservatory_follows
 WHERE (kind='novel' AND ref=?) OR (kind='translator' AND ref=?)) LIMIT 3000`;
 await env.DB.prepare(sql).bind(id,editionText(message,260),editionText(type,40),String(id),ref).run();
}
async function editionRoutes(request,env,email,role){
 const u=new URL(request.url),path=u.pathname,method=request.method;
 if(!env.DB)return editionJson({error:'Private D1 database is not configured.'},503);
 const isOwner=role==='owner';
 const readAllowed=await canReadEpubs(email,role,env);
 if(method==='GET'&&path==='/api/private/edition/list'){
   if(!readAllowed&&!isOwner)return editionJson({error:'EPUB reading permission required'},403);
   const id=editionBook(u.searchParams.get('id'));if(!id)return editionJson({error:'Invalid novel'},400);
   return editionJson({novelId:id,editions:await getEditions(env,id)});
 }
 if(method==='GET'&&path==='/api/private/edition/file'){
   if(!readAllowed&&!isOwner)return editionJson({error:'EPUB reading permission required'},403);
   if(u.searchParams.has('download')&&!isOwner)return editionJson({error:'Only the owner may download stored EPUB files'},403);
   const id=editionBook(u.searchParams.get('id')),edition=editionUuid(u.searchParams.get('edition'));
   if(!id||!edition)return editionJson({error:'Invalid edition'},400);
   const row=await env.DB.prepare('SELECT object_key FROM epub_editions WHERE novel_id=? AND id=?').bind(id,edition).first();
   if(!row||!/^private-epub-editions\/[0-9a-f-]{36}\.epub$/.test(row.object_key))return editionJson({error:'Edition not found'},404);
   if(!env.IMAGES)return editionJson({error:'Private R2 storage missing'},503);
   const object=await env.IMAGES.get(row.object_key);if(!object)return editionJson({error:'EPUB missing from storage'},404);
   return new Response(object.body,{headers:{'content-type':'application/epub+zip','cache-control':'private,no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex,nofollow','content-disposition':u.searchParams.has('download')?'attachment; filename="private-edition.epub"':'inline'}});
 }
 if(!isOwner)return editionJson({error:'Owner permission required'},403);
 if(method==='GET'&&path==='/api/private/edition/inventory'){
   const novels=await env.DB.prepare('SELECT novel_id AS id,COUNT(*) AS count FROM epub_editions GROUP BY novel_id').all();
   const editions=await env.DB.prepare('SELECT novel_id AS id,id AS editionId,filename,bytes,label,translator FROM epub_editions ORDER BY novel_id,created_at').all();
   return editionJson({novels:novels.results||[],editions:editions.results||[]});
 }
 if(method==='GET'&&path==='/api/private/edition/resume'){
   const session=editionUuid(u.searchParams.get('session'));
   const row=await env.DB.prepare('SELECT id,novel_id,bytes,filename,created_at FROM epub_upload_sessions WHERE id=? AND owner_email=?').bind(session,email).first();
   if(!row)return editionJson({error:'Upload session expired or unavailable'},404);
   const parts=await env.DB.prepare('SELECT part_number FROM epub_upload_parts WHERE session_id=? ORDER BY part_number').bind(session).all();
   return editionJson({session:row,uploadedParts:(parts.results||[]).map(x=>x.part_number),partSize:EDITION_PART_BYTES});
 }
 if(method!=='POST'||!strictOrigin(request))return editionJson({error:'Cross-origin request rejected'},403);
 if(path==='/api/private/edition/start'){
   if(!env.IMAGES)return editionJson({error:'Private R2 bucket not configured'},503);
   const b=await getJson(request),id=editionBook(b.novelId),size=Number(b.size);
   const filename=editionText(b.filename,160).replace(/[\\/\x00-\x1f]/g,'_');
   if(!id||!Number.isSafeInteger(size)||size<100||size>EDITION_MAX_BYTES||!/\.epub$/i.test(filename))
     return editionJson({error:'Choose an EPUB under 2 GiB and match it to an existing novel.'},400);
   const count=Math.ceil(size/EDITION_PART_BYTES);if(count>10000)return editionJson({error:'Too many chunks'},400);
   const idPart=crypto.randomUUID(),key='private-epub-editions/'+idPart+'.epub';
   const mpu=await env.IMAGES.createMultipartUpload(key,{httpMetadata:{contentType:'application/epub+zip'}});
   try{
     await env.DB.prepare('INSERT INTO epub_upload_sessions(id,novel_id,owner_email,object_key,upload_id,filename,bytes,label,translator,language) VALUES (?,?,?,?,?,?,?,?,?,?)')
       .bind(idPart,id,email,key,mpu.uploadId,filename,size,editionText(b.label,100)||'Translation edition',editionText(b.translator,130),editionText(b.language,45)||'English').run();
   }catch(e){await mpu.abort();throw e;}
   return editionJson({sessionId:idPart,partSize:EDITION_PART_BYTES,totalParts:count,maxBytes:EDITION_MAX_BYTES});
 }
 if(path==='/api/private/edition/remove'){
   const body=await getJson(request),id=editionBook(body.novelId),edition=editionUuid(body.editionId);
   if(!id||!edition)return editionJson({error:'Choose a stored edition'},400);
   const row=await env.DB.prepare('SELECT object_key,filename FROM epub_editions WHERE novel_id=? AND id=?').bind(id,edition).first();
   if(!row||!/^private-epub-editions\/[0-9a-f-]{36}\.epub$/.test(row.object_key))return editionJson({error:'Edition not found'},404);
   await env.IMAGES.delete(row.object_key);
   await env.DB.prepare('DELETE FROM epub_editions WHERE novel_id=? AND id=?').bind(id,edition).run();
   await audit(env,email,'epub.edition.remove',id,row.filename);
   return editionJson({ok:true,removed:edition});
 }
 const bSession=editionUuid(u.searchParams.get('session'));
 if(!bSession)return editionJson({error:'Invalid upload session'},400);
 const session=await env.DB.prepare('SELECT * FROM epub_upload_sessions WHERE id=? AND owner_email=?').bind(bSession,email).first();
 if(!session)return editionJson({error:'Session expired; start this file again'},404);
 // Upload sessions are short-lived even if an incomplete R2 MPU is cleaned up later.
 if(!Number.isFinite(Date.parse(String(session.created_at).replace(' ','T')+'Z'))||Date.now()-Date.parse(String(session.created_at).replace(' ','T')+'Z')>24*3600*1000)return editionJson({error:'This upload session has expired'},410);
 const mpu=env.IMAGES.resumeMultipartUpload(session.object_key,session.upload_id);
 if(path==='/api/private/edition/part'){
   const n=Number(u.searchParams.get('part'));
   const total=Math.ceil(session.bytes/EDITION_PART_BYTES);
   if(!Number.isInteger(n)||n<1||n>total)return editionJson({error:'Invalid part number'},400);
   const expected=n===total?session.bytes-(n-1)*EDITION_PART_BYTES:EDITION_PART_BYTES;
   const length=Number(request.headers.get('content-length'));
   if(request.headers.has('content-length')&&Number.isFinite(length)&&length!==expected)return editionJson({error:'Part length mismatch'},400);
   const body=await request.arrayBuffer();if(body.byteLength!==expected)return editionJson({error:'Part size mismatch'},400);
   if(n===1){const prefix=new Uint8Array(body,0,4);if(prefix[0]!==80||prefix[1]!==75||prefix[2]!==3||prefix[3]!==4)return editionJson({error:'Invalid EPUB ZIP header'},415);}
   const part=await mpu.uploadPart(n,body);
   await env.DB.prepare('INSERT INTO epub_upload_parts(session_id,part_number,etag) VALUES (?,?,?) ON CONFLICT(session_id,part_number) DO UPDATE SET etag=excluded.etag')
     .bind(bSession,n,part.etag).run();
   return editionJson({ok:true,part:n});
 }
 if(path==='/api/private/edition/finish'){
   const total=Math.ceil(session.bytes/EDITION_PART_BYTES);
   const rows=await env.DB.prepare('SELECT part_number,etag FROM epub_upload_parts WHERE session_id=? ORDER BY part_number').bind(bSession).all();
   const parts=rows.results||[];
   if(parts.length!==total||parts.some((x,i)=>x.part_number!==i+1))return editionJson({error:'Upload incomplete. Retry missing chunks before finishing.'},409);
   const obj=await mpu.complete(parts.map(x=>({partNumber:x.part_number,etag:x.etag})));
   if(obj.size!==session.bytes){await env.IMAGES.delete(session.object_key);return editionJson({error:'Uploaded bytes did not match the original file size'},409);}
   try{await env.DB.prepare('INSERT INTO epub_editions(id,novel_id,label,translator,language,filename,object_key,bytes,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)')
     .bind(session.id,session.novel_id,session.label,session.translator,session.language,session.filename,session.object_key,session.bytes,email).run();}
   catch(e){await env.IMAGES.delete(session.object_key);throw e;}
   await env.DB.prepare('DELETE FROM epub_upload_parts WHERE session_id=?').bind(bSession).run();
   await env.DB.prepare('DELETE FROM epub_upload_sessions WHERE id=?').bind(bSession).run();
   await audit(env,email,'epub.edition.upload',session.novel_id,session.filename);
   try{await followersNotice(env,session.novel_id,session.translator,`A new ${session.label} EPUB edition was added to novel #${session.novel_id}.`,'edition');}catch{}
   return editionJson({ok:true,edition:{id:session.id,novelId:session.novel_id,label:session.label,translator:session.translator,language:session.language,filename:session.filename,size:session.bytes}});
 }
 if(path==='/api/private/edition/abort'){
   try{await mpu.abort()}catch{}
   await env.DB.prepare('DELETE FROM epub_upload_parts WHERE session_id=?').bind(bSession).run();
   await env.DB.prepare('DELETE FROM epub_upload_sessions WHERE id=?').bind(bSession).run();
   return editionJson({ok:true});
 }
 return editionJson({error:'Not found'},404);
}
async function followRoutes(request,env,email){
 if(!env.DB)return editionJson({error:'Private database unavailable'},503);
 const u=new URL(request.url),path=u.pathname;
 if(request.method==='GET'&&path==='/api/follows'){
   const follows=await env.DB.prepare('SELECT kind,ref,created_at FROM conservatory_follows WHERE member_email=? ORDER BY kind,ref LIMIT 2000').bind(email).all();
   return editionJson({follows:follows.results||[]});
 }
 if(request.method==='GET'&&path==='/api/notifications'){
   const rows=await env.DB.prepare('SELECT id,novel_id,message,type,created_at,read_at FROM conservatory_notifications WHERE member_email=? ORDER BY created_at DESC LIMIT 100').bind(email).all();
   return editionJson({notifications:rows.results||[],unread:(rows.results||[]).filter(x=>!x.read_at).length});
 }
 if(request.method!=='POST'||!strictOrigin(request))return editionJson({error:'Cross-origin request rejected'},403);
 const b=await getJson(request);
 if(path==='/api/follows'){
   const kind=b.kind==='novel'?'novel':b.kind==='translator'?'translator':null;
   let ref=kind==='novel'?String(editionBook(b.ref)||''):kind==='translator'?translationRef(b.ref):'';
   if(!kind||!ref)return editionJson({error:'Choose a valid novel or translator'},400);
   const action=b.action==='remove'?'remove':'add';
   if(action==='remove')await env.DB.prepare('DELETE FROM conservatory_follows WHERE member_email=? AND kind=? AND ref=?').bind(email,kind,ref).run();
   else await env.DB.prepare('INSERT INTO conservatory_follows(member_email,kind,ref) VALUES (?,?,?) ON CONFLICT DO NOTHING').bind(email,kind,ref).run();
   return editionJson({ok:true,action,kind,ref});
 }
 if(path==='/api/notifications/read'){
   if(b.all===true)await env.DB.prepare('UPDATE conservatory_notifications SET read_at=CURRENT_TIMESTAMP WHERE member_email=? AND read_at IS NULL').bind(email).run();
   else if(/^[0-9a-f]{32}$/.test(String(b.id||'')))await env.DB.prepare('UPDATE conservatory_notifications SET read_at=CURRENT_TIMESTAMP WHERE member_email=? AND id=?').bind(email,String(b.id)).run();
   else return editionJson({error:'Invalid notification'},400);
   return editionJson({ok:true});
 }
 return editionJson({error:'Not found'},404);
}
const PUBLISH_FIELDS=new Set(['tags','nuUrl','translatorUrl','synopsis','translation','title','cover']);
async function publishCorrectionRoute(request,env,email,role){
 if(!isEditor(role))return editionJson({error:'Editor access required'},403);
 if(!env.DB||!env.COMMUNITY_DB)return editionJson({error:'Private and community databases must both be configured'},503);
 if(request.method!=='POST'||!strictOrigin(request))return editionJson({error:'Cross-origin request rejected'},403);
 const b=await getJson(request),id=editionUuid(b.submissionId),field=String(b.field||'');
 if(!id||!PUBLISH_FIELDS.has(field))return editionJson({error:'Choose an approved submission and a publishing field'},400);
 const entry=await env.COMMUNITY_DB.prepare('SELECT * FROM community_entries WHERE id=? AND status=?').bind(id,'approved').first();
 if(!entry||!editionBook(entry.novel_id))return editionJson({error:'Submission must be approved first'},409);
 if((field==='tags'&&entry.kind!=='tags')||(field==='cover'&&entry.kind!=='image'))return editionJson({error:'Submission type cannot be published to this field'},400);
 if(field!=='tags'&&field!=='cover'&&entry.kind!=='update')return editionJson({error:'Only an approved correction can update that field'},400);
 let value,extra={};
 if(field==='tags'){
   const proposed=JSON.parse(entry.tags_json||'[]').filter(x=>typeof x==='string').map(x=>editionText(x,70)).filter(Boolean);
   if(!proposed.length)return editionJson({error:'No approved tags'},400);
   // Include catalogue baseline so publishing never erases existing tags.
   const resp=await env.ASSETS.fetch(new Request(new URL('/admin/catalogue.json',request.url)));
   if(!resp.ok)return editionJson({error:'Catalogue unavailable'},503);
   const catalogue=await resp.json();const base=(Array.isArray(catalogue)?catalogue:catalogue.books||[]).find(x=>x.id===entry.novel_id)||{};
   const old=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(entry.novel_id).first();
   const current=old?JSON.parse(old.patch):{};
   const merged=[...(current.tags||base.tags||[]),...proposed];
   value=[...new Map(merged.filter(x=>typeof x==='string').map(x=>[x.normalize('NFKC').toLowerCase().trim(),editionText(x,70)])).values()].slice(0,24);
 }else if(field==='cover'){
   // Image is already approved by editors, served only through the approved-image route.
   if(!entry.image_key||entry.scope!=='public')return editionJson({error:'Only approved public artwork can become a public cover'},409);
   value='/api/community/image?id='+entry.id;extra.coverRights=true;
 }else if(['nuUrl','translatorUrl'].includes(field)){
   value=safeLink(entry.external_url);
   if(!/^https:\/\//.test(value||''))return editionJson({error:'Approved suggestion has no HTTPS link'},400);
 }else{
   // Free-form submissions are NOT blindly copied into a canonical field.
   // The editor must supply a reviewed replacement value explicitly.
   value=editionText(b.value,field==='synopsis'?2000:field==='title'?240:40);
   if(!value)return editionJson({error:'Provide the reviewed replacement value'},400);
   if(field==='translation'&&!['completed','ongoing','incomplete','dropped','licensed','unconfirmed','original'].includes(value))return editionJson({error:'Invalid translation status'},400);
 }
 const patch={[field]:value,...extra};
 // First update the shared public-only override. Both sites read that source;
 // then apply the same safe field to private D1. These databases cannot share a transaction.
 let updated=false;
 for(let attempt=0;attempt<3&&!updated;attempt++){
   const row=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(entry.novel_id).first();
   const combined={...(row?JSON.parse(row.patch_json):{}),...patch};const val=JSON.stringify(combined);
   if(!row){const r=await env.COMMUNITY_DB.prepare('INSERT INTO published_catalogue_overrides(novel_id,patch_json,source_entry_id,published_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING').bind(entry.novel_id,val,id,email).run();updated=(r.meta?.changes??0)>0;}
   else{const r=await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=?,source_entry_id=?,published_by=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?').bind(val,id,email,entry.novel_id,row.patch_json).run();updated=(r.meta?.changes??0)>0;}
 }
 if(!updated)return editionJson({error:'Another editor published simultaneously; refresh and retry'},409);
 await env.COMMUNITY_DB.prepare('INSERT INTO published_correction_history(id,source_entry_id,novel_id,field_name,published_value,actor_email) VALUES (?,?,?,?,?,?)')
   .bind(crypto.randomUUID(),id,entry.novel_id,field,JSON.stringify(value),email).run();
 let privateSynced=true;
 try{
   const prior=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(entry.novel_id).first();
   const privatePatch={...patch};
   if(field==='cover'){
     if(!env.COMMUNITY_IMAGES||!env.IMAGES)throw Error('Private cover storage is not bound');
     const publicImage=await env.COMMUNITY_IMAGES.get(entry.image_key);
     if(!publicImage)throw Error('Approved image is missing');
     const ext=(entry.image_key.match(/\.(png|jpg|webp)$/)||[])[1];
     if(!ext)throw Error('Invalid image format');
     const privateKey=crypto.randomUUID()+'.'+ext;
     await env.IMAGES.put(privateKey,publicImage.body,{httpMetadata:{contentType:publicImage.httpMetadata?.contentType||'image/'+ext}});
     privatePatch.cover='/media/'+privateKey;privatePatch.coverRights=true;
   }
   const next={...(prior?JSON.parse(prior.patch):{}),...privatePatch};
   await env.DB.prepare('INSERT INTO novel_edits(id,patch) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET patch=excluded.patch,updated_at=CURRENT_TIMESTAMP').bind(entry.novel_id,JSON.stringify(next)).run();
   await audit(env,email,'correction.published',entry.novel_id,field+':'+id);
   try{await followersNotice(env,entry.novel_id,'',`An editor published a ${field} update for novel #${entry.novel_id}.`,'correction');}catch{}
 }catch{privateSynced=false;}
 return editionJson({ok:true,novelId:entry.novel_id,field,publicPublished:true,privateSynced});
}
