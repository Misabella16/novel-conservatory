// Public site: separate public branding, approved catalogue and community artwork.
// Never bind the private DB, EPUB bucket or private banner storage to this Worker.
const respond=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const validKey=k=>/^[a-f0-9-]{36}\.(?:png|jpg|webp|gif)$/.test(k);
const clamp=v=>Number.isFinite(Number(v))?Math.max(0,Math.min(100,Math.round(Number(v)))):50;
async function activeBanner(env){
 if(!env.COMMUNITY_DB||!env.COMMUNITY_IMAGES)return {image:'',positionX:50,positionY:50,configured:false};
 const settings=await siteGet(env,'public');
 const key=String(settings.publicBannerKey||'');
 return {image:validKey(key)?'/banner-media/'+key:'',positionX:clamp(settings.publicBannerX),positionY:clamp(settings.publicBannerY),configured:true};
}
export default {async fetch(request,env){
 const url=new URL(request.url),path=url.pathname;
 if(path.startsWith('/api/additional/'))return additionalRoutes(request,env,'public');
 if(path==='/api/site/config')return siteConfigRoute(request,env,'public');
 if(path==='/api/site/feedback')return siteFeedbackRoute(request,env,'public','');
 if(path==='/api/nu-links/submit')return publicNovelUpdatesLinkSubmit(request,env);
 if(path==='/api/published/novels'&&request.method==='GET'){
  if(!env.COMMUNITY_DB)return respond({overrides:[],configured:false});
  try{const r=await env.COMMUNITY_DB.prepare('SELECT novel_id,patch_json,updated_at FROM published_catalogue_overrides ORDER BY novel_id LIMIT 1000').all();
   const allowed=new Set(['tags','genres','author','originalTitle','nuUrl','translatorUrl','translatorLinks','synopsis','translation','title','cover','coverRights','coverCredit','metadataReview','metadataSource']);
   const overrides=(r.results||[]).map(row=>{let patch={};try{for(const [k,v] of Object.entries(JSON.parse(row.patch_json||'{}')))if(allowed.has(k))patch[k]=v;}catch{}return {id:row.novel_id,patch,updatedAt:row.updated_at};});
   // Community additions appear immediately without overwriting the canonical records.
   // Removing an approved contribution through the editor queue removes it from this feed.
   const byId=new Map(overrides.map(x=>[x.id,x]));
   try{
    const additions=await env.COMMUNITY_DB.prepare("SELECT novel_id,kind,body,tags_json FROM community_entries WHERE scope='public' AND status='approved' AND kind IN ('tags','update') ORDER BY created_at ASC LIMIT 5000").all();
    for(const entry of additions.results||[]){
     const novel=Number(entry.novel_id);if(!Number.isInteger(novel)||novel<1||novel>962)continue;
     let record=byId.get(novel);if(!record){record={id:novel,patch:{},updatedAt:null};byId.set(novel,record);}
     let tags=[];try{tags=JSON.parse(entry.tags_json||'[]');}catch{}
     if(entry.kind==='tags'){
      const existing=new Set((record.patch.communityTags||[]).map(t=>t.toLowerCase()));
      for(const tag of tags){if(typeof tag==='string'&&tag.length<=70&&!existing.has(tag.toLowerCase())){(record.patch.communityTags||=[]).push(tag);existing.add(tag.toLowerCase());}}
     }else if(tags.includes('__synopsis__')&&typeof entry.body==='string'){
      record.patch.communitySynopsis=entry.body.slice(0,2000);
     }
    }
   }catch{}
   return respond({configured:true,overrides:[...byId.values()]});
  }catch{return respond({error:'Published corrections not configured'},503)}
 }
 if(path.startsWith('/api/community/')) return communityDispatch(request,env,'public',null);
 if(request.method==='GET'&&path==='/api/banner'){
  try{return respond(await activeBanner(env))}catch{return respond({image:'',positionX:50,positionY:50,configured:false},503)}
 }
 if(request.method==='GET'&&path.startsWith('/banner-media/')){
  const key=path.slice('/banner-media/'.length);
  if(!validKey(key)||!env.COMMUNITY_IMAGES)return new Response('Not found',{status:404});
  const active=await activeBanner(env);
  if(active.image!=='/banner-media/'+key)return new Response('Not found',{status:404});
  const file=await env.COMMUNITY_IMAGES.get('public-banners/'+key);if(!file)return new Response('Not found',{status:404});
  return new Response(file.body,{headers:{'content-type':file.httpMetadata?.contentType||'application/octet-stream','cache-control':'public,max-age=300','x-content-type-options':'nosniff'}});
 }
 // This separate public site never exposes the private editing API or media.
 if(path.startsWith('/api/')||path.startsWith('/admin')||path.startsWith('/media/')||path.startsWith('/manage'))return respond({error:'Not found'},404);
 return env.ASSETS.fetch(request);
}};


// Community API, appended to BOTH Cloudflare Pages advanced-mode Workers.
// The public worker invokes communityDispatch(req,env,'public',null);
// The private worker invokes communityDispatch(req,env,'private',{email,role});
// PUBLIC COMMUNITY_DB and COMMUNITY_IMAGES are dedicated, shared resources.
// Public server NEVER receives the private catalogue's DB/IMAGES bindings.
const COMMUNITY_HEADERS={
 'content-type':'application/json;charset=utf-8','cache-control':'no-store',
 'x-content-type-options':'nosniff','referrer-policy':'no-referrer'
};
const communityJson=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:COMMUNITY_HEADERS});
const communityText=(v,max=2000)=>String(v??'').trim().slice(0,max);
const communityBook=v=>Number.isSafeInteger(Number(v))&&Number(v)>=1&&Number(v)<=962?Number(v):null;
const communityOrigin=request=>{
 const origin=request.headers.get('Origin');
 // Browsers send Origin on form POST. Reject non-browser and cross-site posts.
 return origin===new URL(request.url).origin;
};
function communityUrl(value){
 try{const u=new URL(String(value||''));return u.protocol==='https:'&&u.username===''&&u.password===''?u.href.slice(0,750):'';}catch{return ''}
}
function communityRecord(row){return {
 id:row.id,scope:row.scope,novelId:row.novel_id,kind:row.kind,
 name:row.display_name,body:row.body,rating:row.rating,spoiler:!!row.spoiler,
 tags:JSON.parse(row.tags_json||'[]'),externalUrl:row.external_url,
 imageUrl:row.image_key?'/api/community/image?id='+encodeURIComponent(row.id):'',
 imageCredit:row.image_credit,parentId:row.parent_id,
 createdAt:row.created_at,status:row.status
};}
async function communityVerifyTurnstile(request,env,token){
 if(!env.TURNSTILE_SECRET||!env.TURNSTILE_SITE_KEY)return false;
 if(!token||token.length>1800)return false;
 const body=new FormData();body.set('secret',env.TURNSTILE_SECRET);body.set('response',token);
 const ip=request.headers.get('CF-Connecting-IP');if(ip)body.set('remoteip',ip);
 const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
   method:'POST',body,signal:AbortSignal.timeout(6000)
 });
 if(!r.ok)return false;
 const v=await r.json();
 return v.success===true&&v.hostname===new URL(request.url).hostname;
}
function communityMagic(type,bytes){
 const b=new Uint8Array(bytes);
 if(type==='image/png')return b.length>80&&b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71&&b[4]===13&&b[5]===10&&b[6]===26&&b[7]===10;
 if(type==='image/jpeg')return b.length>80&&b[0]===255&&b[1]===216&&b[2]===255;
 if(type==='image/webp')return b.length>80&&String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP';
 return false;
}
async function communityDispatch(request,env,scope,identity){
 const u=new URL(request.url),path=u.pathname,method=request.method.toUpperCase();
 const editor=scope==='private'&&(identity?.role==='owner'||identity?.role==='editor');
 if(path==='/api/community/config'&&method==='GET')return communityJson({
  enabled:!!env.COMMUNITY_DB&&(scope==='private'||!!(env.TURNSTILE_SECRET&&env.TURNSTILE_SITE_KEY)),
  imagesEnabled:!!env.COMMUNITY_IMAGES,scope,
  siteKey:scope==='public'?(env.TURNSTILE_SITE_KEY||''):'',
  moderationAvailable:editor
 });
 if(!env.COMMUNITY_DB)return communityJson({error:'Community database is not configured'},503);
 try{
  if(path==='/api/community/book'&&method==='GET'){
   const id=communityBook(u.searchParams.get('id'));
   if(!id)return communityJson({error:'Invalid book'},400);
   const r=await env.COMMUNITY_DB.prepare('SELECT * FROM community_entries WHERE scope=? AND novel_id=? AND status=? ORDER BY created_at DESC LIMIT 100')
    .bind(scope,id,'approved').all();
   // Link reports and translator URL proposals are editorial-only records.
   // Even after moderation, don't turn them into public discussion posts.
   const items=(r.results||[]).filter(row=>{
     if(row.kind!=='update')return true;
     try{return !JSON.parse(row.tags_json||'[]').some(t=>t==='__broken_link__'||t==='__translator_link__')}catch{return false}
   }).map(communityRecord);
   const stats=await env.COMMUNITY_DB.prepare("SELECT COUNT(*) AS n,AVG(rating) AS avg_rating FROM community_entries WHERE scope=? AND novel_id=? AND kind='review' AND status='approved'").bind(scope,id).first();
   const average=Number(stats?.n)>0?Math.round(Number(stats.avg_rating)*10)/10:null;
   return communityJson({items,reviewCount:Number(stats?.n)||0,averageRating:average});
  }
  if(path==='/api/community/image'&&method==='GET'){
   if(!env.COMMUNITY_IMAGES)return communityJson({error:'Images are unavailable'},503);
   const id=String(u.searchParams.get('id')||'');
   if(!/^[a-f0-9-]{36}$/.test(id))return communityJson({error:'Not found'},404);
   const row=await env.COMMUNITY_DB.prepare('SELECT scope,kind,status,image_key FROM community_entries WHERE id=?').bind(id).first();
   if(!row||row.scope!==scope||row.kind!=='image'||!row.image_key||row.status!=='approved')return communityJson({error:'Not found'},404);
   const obj=await env.COMMUNITY_IMAGES.get(row.image_key);if(!obj)return communityJson({error:'Not found'},404);
   const type=obj.httpMetadata?.contentType||'application/octet-stream';
   return new Response(obj.body,{headers:{'content-type':type,'cache-control':scope==='public'?'public,max-age=300':'private,no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"}});
  }
  if(path==='/api/community/mod-image'&&method==='GET'){
   if(!editor)return communityJson({error:'Editor permission required'},403);
   if(!env.COMMUNITY_IMAGES)return communityJson({error:'Image storage unavailable'},503);
   const id=String(u.searchParams.get('id')||'');
   if(!/^[a-f0-9-]{36}$/.test(id))return communityJson({error:'Not found'},404);
   const row=await env.COMMUNITY_DB.prepare('SELECT kind,image_key FROM community_entries WHERE id=?').bind(id).first();
   if(!row||row.kind!=='image'||!row.image_key)return communityJson({error:'Not found'},404);
   const obj=await env.COMMUNITY_IMAGES.get(row.image_key);if(!obj)return communityJson({error:'Not found'},404);
   return new Response(obj.body,{headers:{'content-type':obj.httpMetadata?.contentType||'application/octet-stream','cache-control':'private,no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex,nofollow','content-security-policy':"default-src 'none'; sandbox"}});
  }
  if(path==='/api/community/moderation'&&method==='GET'){
   if(!editor)return communityJson({error:'Editor permission required'},403);
   const state=['pending','approved','rejected'].includes(u.searchParams.get('status'))?u.searchParams.get('status'):'pending';
   const r=await env.COMMUNITY_DB.prepare('SELECT * FROM community_entries WHERE status=? ORDER BY created_at DESC LIMIT 250').bind(state).all();
   return communityJson({items:(r.results||[]).map(x=>({...communityRecord(x),authorIdentity:x.author_identity,scope:x.scope,imageUrl:x.image_key?'/api/community/mod-image?id='+encodeURIComponent(x.id):''}))});
  }
  if(path==='/api/community/moderation'&&method==='POST'){
   if(!editor)return communityJson({error:'Editor permission required'},403);
   if(!communityOrigin(request))return communityJson({error:'Wrong origin'},403);
   if(!(request.headers.get('content-type')||'').includes('application/json'))return communityJson({error:'Expected JSON'},415);
   const raw=await request.text();if(raw.length>4000)return communityJson({error:'Request too long'},413);
   const data=JSON.parse(raw),id=String(data.id||''),decision=String(data.decision||'');
   if(!/^[a-f0-9-]{36}$/.test(id)||!['approved','rejected','pending'].includes(decision))return communityJson({error:'Invalid decision'},400);
   const row=await env.COMMUNITY_DB.prepare('SELECT status FROM community_entries WHERE id=?').bind(id).first();
   if(!row)return communityJson({error:'Submission not found'},404);
   await env.COMMUNITY_DB.prepare('UPDATE community_entries SET status=?,moderated_by=?,moderated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(decision,identity.email,id).run();
   return communityJson({ok:true,id,status:decision});
  }
  if(path==='/api/community/submit'&&method==='POST'){
   if(!communityOrigin(request))return communityJson({error:'Wrong origin'},403);
   if(scope==='public'&&(!env.TURNSTILE_SECRET||!env.TURNSTILE_SITE_KEY))return communityJson({error:'Public submissions are not enabled. Configure Turnstile.'},503);
   const size=Number(request.headers.get('content-length')||0);
   if(size>3400000)return communityJson({error:'Submission exceeds size limit'},413);
   if(!(request.headers.get('content-type')||'').startsWith('multipart/form-data'))return communityJson({error:'Use a form submission'},415);
   // Stream with a hard size cap even if Content-Length is omitted or forged.
   const pieces=[];let total=0;const reader=request.body?.getReader();
   if(!reader)return communityJson({error:'Empty submission'},400);
   for(;;){const part=await reader.read();if(part.done)break;total+=part.value.length;
    if(total>3400000){await reader.cancel();return communityJson({error:'Submission exceeds size limit'},413);}
    pieces.push(part.value);
   }
   const fd=await new Response(new Blob(pieces),{headers:{'content-type':request.headers.get('content-type')}}).formData();
   const token=communityText(fd.get('turnstile'),1800);
   if(scope==='public'&&!await communityVerifyTurnstile(request,env,token))return communityJson({error:'Security check failed. Please retry the challenge.'},403);
   const id=crypto.randomUUID(),book=communityBook(fd.get('novel_id'));
   const kind=communityText(fd.get('kind'),30),name=communityText(fd.get('display_name'),64);
   const body=communityText(fd.get('body'),2200),url=communityUrl(fd.get('external_url'));
   const imageCredit=communityText(fd.get('image_credit'),150),spoiler=fd.get('spoiler')==='on'?1:0;
   const rating=kind==='review'?Number(fd.get('rating')):null;
   const parentId=communityText(fd.get('parent_id'),40);
   const rawTags=communityText(fd.get('tags'),700);
   const suggestionField=communityText(fd.get('suggestion_field'),30);
   const linkAction=communityText(fd.get('link_action'),30);
   const linkType=communityText(fd.get('link_type'),25);
   let tags=[...new Set(rawTags.split(',').map(x=>x.trim()).filter(Boolean))].slice(0,10);
   // Reuse existing update type and JSON tag column: no database migration.
   if(kind==='update' && (linkAction==='broken'||linkAction==='translator')){
     if(!url)return communityJson({error:'Enter the exact HTTPS address of the broken or proposed link'},400);
     if(linkAction==='translator'&&!['homepage','reading-page'].includes(linkType))return communityJson({error:'Choose translator homepage or direct novel page'},400);
     tags=linkAction==='broken'?['__broken_link__']:['__translator_link__',linkType==='reading-page'?'__reading_page__':'__translator_homepage__'];
   }
   if(kind==='update'&&suggestionField==='synopsis'){
     if(body.length<50||body.length>2000)return communityJson({error:'Write an original synopsis between 50 and 2,000 characters'},400);
     if(fd.get('synopsis_original')!=='on')return communityJson({error:'Confirm that the suggested synopsis is original or authorized'},400);
     tags=['__synopsis__'];
   }
   if(!book||!['comment','review','image','tags','update'].includes(kind)||name.length<2||name.length>64)return communityJson({error:'Enter a book, type, and a display name (at least 2 characters)'},400);
   if(kind==='review'&&(!Number.isInteger(rating)||rating<1||rating>5))return communityJson({error:'Select 1–5 stars'},400);
   if(kind==='comment'&&body.length<2||kind==='review'&&body.length<10||kind==='update'&&body.length<8||kind==='tags'&&tags.length===0)return communityJson({error:'Add more detail to the submission'},400);
   if(tags.some(x=>x.length>70))return communityJson({error:'Tags must be 70 characters or fewer'},400);
   if(parentId){
     if(kind!=='comment'||!/^[a-f0-9-]{36}$/.test(parentId))return communityJson({error:'Invalid reply'},400);
     const row=await env.COMMUNITY_DB.prepare('SELECT id FROM community_entries WHERE id=? AND novel_id=? AND scope=? AND kind=? AND status=?')
      .bind(parentId,book,scope,'comment','approved').first();
     if(!row)return communityJson({error:'Original comment is unavailable'},400);
   }
   let imageKey='';const file=fd.get('image');
   if(kind==='image'){
     if(!env.COMMUNITY_IMAGES)return communityJson({error:'Image storage is not configured'},503);
     if(!(file instanceof File)||file.size<80||file.size>3000000||!['image/png','image/jpeg','image/webp'].includes(file.type))return communityJson({error:'Upload a PNG, JPG or WebP up to 3 MB'},415);
     if(fd.get('rights')!=='on'||imageCredit.length<2)return communityJson({error:'Confirm permission to share and credit the image'},400);
     const bytes=await file.arrayBuffer();if(!communityMagic(file.type,bytes))return communityJson({error:'Image file format did not pass validation'},415);
     const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[file.type];
     imageKey='community-submissions/'+id+'.'+ext;
     await env.COMMUNITY_IMAGES.put(imageKey,bytes,{httpMetadata:{contentType:file.type}});
   }
   const direct=scope==='public'&&(kind==='tags'||kind==='image'||(kind==='update'&&suggestionField==='synopsis'));
   const status=direct?'approved':'pending';
   try{
    await env.COMMUNITY_DB.prepare('INSERT INTO community_entries(id,scope,novel_id,kind,display_name,author_identity,body,rating,spoiler,tags_json,external_url,image_key,image_credit,parent_id,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
     .bind(id,scope,book,kind,name,identity?.email||'',body,rating,spoiler,JSON.stringify(tags),url,imageKey,imageCredit,parentId,status).run();
   }catch(e){if(imageKey&&env.COMMUNITY_IMAGES)await env.COMMUNITY_IMAGES.delete(imageKey);throw e;}
   return communityJson({ok:true,id,status},201);
  }
  return communityJson({error:'Not found'},404);
 }catch(e){
  return communityJson({error:'Community action failed. Check the database setup or form fields.'},500);
 }
}

// Public-safe site copy, owner-only controls and community help inbox.
// Both workers use ONLY the existing shared COMMUNITY_DB. No private information
// is ever returned by the public worker.
const SITE_COPY_FIELDS={
 homeEyebrow:100,homeHeadline:110,homeFlavor:350,storyTagsHeadline:100,
 storyTagsFlavor:320,browseHeadline:100,curatedHeadline:100,curatedFlavor:320,
 noticeText:320
};
const SITE_DEFAULT={creator:'Momo',instagram:'',instagramLabel:'Message Momo on Instagram',publicBannerKey:'',publicBannerX:50,publicBannerY:50,
 homeEyebrow:'',homeHeadline:'',homeFlavor:'',storyTagsHeadline:'',storyTagsFlavor:'',
 browseHeadline:'',curatedHeadline:'',curatedFlavor:'',noticeText:''};
const siteOut=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const siteTrim=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
const siteScope=(s)=>s==='private'?'private':'public';
function cleanInstagram(raw){
 const x=String(raw??'').trim();if(!x)return '';
 let account=x.replace(/^@/,'');
 if(/^https:\/\//i.test(account)){
  try{const u=new URL(account);if(!['instagram.com','www.instagram.com'].includes(u.hostname.toLowerCase())||u.username||u.password||u.search||u.hash)throw Error();account=u.pathname.replace(/^\/+|\/+$/g,'');}catch{return null}
 }
 if(!/^[A-Za-z0-9._]{1,30}$/.test(account))return null;
 return 'https://www.instagram.com/'+account+'/';
}
function siteClean(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const insta=cleanInstagram(raw.instagram);
 if(insta===null)return null;
 const result={...SITE_DEFAULT,instagram:insta,instagramLabel:siteTrim(raw.instagramLabel,70)||SITE_DEFAULT.instagramLabel};
 for(const [key,len] of Object.entries(SITE_COPY_FIELDS))result[key]=siteTrim(raw[key],len);
 const bannerKey=String(raw.publicBannerKey||'');
 result.publicBannerKey=validKey(bannerKey)?bannerKey:'';
 result.publicBannerX=clamp(raw.publicBannerX);
 result.publicBannerY=clamp(raw.publicBannerY);
 return result;
}
async function siteGet(env,scope){
 const row=await env.COMMUNITY_DB.prepare('SELECT config_json FROM conservatory_site_config WHERE scope=?').bind(siteScope(scope)).first();
 try{return siteClean(row?JSON.parse(row.config_json):{})||{...SITE_DEFAULT}}catch{return {...SITE_DEFAULT}}
}
async function siteConfigRoute(request,env,scope){
 if(request.method!=='GET')return siteOut({error:'Method not allowed'},405);
 if(!env.COMMUNITY_DB)return siteOut({settings:SITE_DEFAULT,configured:false,feedbackEnabled:false});
 try{return siteOut({settings:await siteGet(env,scope),configured:true,feedbackEnabled:scope==='private'||!!(env.TURNSTILE_SECRET&&env.TURNSTILE_SITE_KEY),turnstileSiteKey:scope==='public'?(env.TURNSTILE_SITE_KEY||''):''})}
 catch{return siteOut({settings:SITE_DEFAULT,configured:false,feedbackEnabled:false},503)}
}
// Public, link-only Novel Updates contribution intake.
// Accepted URLs are editorial suggestions, never automatically published records.
// Only this fixed hostname/path is accepted: no redirects, credentials or SSRF.
async function publicNovelUpdatesLinkSubmit(request,env){
 if(request.method!=='POST')return siteOut({error:'Method not allowed'},405);
 const url=new URL(request.url);
 if(request.headers.get('Origin')!==url.origin)return siteOut({error:'Wrong origin'},403);
 if(!env.COMMUNITY_DB||!env.TURNSTILE_SECRET||!env.TURNSTILE_SITE_KEY)
  return siteOut({error:'Link submissions are not configured'},503);
 if(!(request.headers.get('content-type')||'').startsWith('application/json'))
  return siteOut({error:'Expected JSON'},415);
 let input;
 try{const raw=await request.text();if(raw.length>4000)return siteOut({error:'Request too large'},413);input=JSON.parse(raw)}
 catch{return siteOut({error:'Invalid submission'},400)}
 if(!input||typeof input!=='object'||Array.isArray(input))return siteOut({error:'Invalid submission'},400);
 if(input.website)return siteOut({ok:true,status:'pending'},201);
 const canonicalNU=raw=>{
  if(typeof raw!=='string'||raw.length>700)return null;
  try{
   const u=new URL(raw.trim());
   const slug=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/.exec(u.pathname);
   if(u.protocol!=='https:'||u.hostname!=='www.novelupdates.com'||u.port||u.username||u.password||u.search||u.hash||!slug)return null;
   return {url:'https://www.novelupdates.com/series/'+slug[1]+'/',slug:slug[1]};
  }catch{return null}
 };
 const link=canonicalNU(input.nuUrl);
 if(!link)return siteOut({error:'Paste an exact HTTPS Novel Updates series URL (www.novelupdates.com/series/...)'},400);
 const displayName=siteTrim(input.name,70)||'Reader';
 const replyTo=siteTrim(input.replyTo,160),note=siteTrim(input.note,1200);
 if(replyTo&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)||replyTo.length>160))
  return siteOut({error:'Enter a valid reply email or leave it blank'},400);
 try{
  if(!await communityVerifyTurnstile(request,env,siteTrim(input.turnstile,1800)))
   return siteOut({error:'Complete the verification challenge and try again'},403);
 }catch{return siteOut({error:'Security check temporarily unavailable'},503)}
 let novelId=null,linkedTitle='';
 if(input.novelId!==null&&input.novelId!==undefined&&input.novelId!==''){
  const candidate=Number(input.novelId);
  if(!Number.isSafeInteger(candidate)||candidate<1)return siteOut({error:'Invalid catalogue ID'},400);
  if(candidate<=962){
   const seed=await env.ASSETS.fetch(new Request(new URL('/catalogue-submission-index.json',url.origin)));
   if(!seed.ok)return siteOut({error:'Cannot verify the catalogue entry right now'},503);
   const data=await seed.json(),record=(Array.isArray(data)?data:data.books||[]).find(x=>x.id===candidate);
   if(!record)return siteOut({error:'Novel not found in the public catalogue'},404);
   novelId=candidate;linkedTitle=String(record.title||'').slice(0,180);
  }else{
   const record=await env.COMMUNITY_DB.prepare("SELECT title FROM additional_catalogue_novels WHERE id=? AND visibility='published'").bind(candidate).first();
   if(!record)return siteOut({error:'Novel not found in the public catalogue'},404);
   novelId=candidate;linkedTitle=String(record.title||'').slice(0,180);
  }
 }
 const subject='Novel Updates link: '+link.slug.slice(0,95)+(novelId?' · Book #'+novelId:'');
 try{
  // Do not flood the owner inbox with repeated pending submissions of one series.
  const exists=await env.COMMUNITY_DB.prepare(
   "SELECT id FROM conservatory_site_feedback WHERE scope='public' AND status='pending' AND subject=? LIMIT 1"
  ).bind(subject).first();
  if(exists)return siteOut({ok:true,status:'already_submitted',message:'This Novel Updates link is already waiting for editorial review.'});
  const id=crypto.randomUUID();
  const message='Novel Updates series: '+link.url+(novelId?'\nCatalogue ID: '+novelId+'\nCatalogue title: '+linkedTitle:'')+(note?'\nReader note: '+note:'');
  await env.COMMUNITY_DB.prepare(
   'INSERT INTO conservatory_site_feedback(id,scope,kind,display_name,reply_to,subject,message,status,member_email) VALUES(?,?,?,?,?,?,?,?,?)'
  ).bind(id,'public','suggestion',displayName,replyTo,subject,message,'pending','').run();
  return siteOut({ok:true,id,status:'pending',message:novelId?'Link submitted for review of novel #'+novelId+'. No changes are published yet.':'Link received. An editor will review the source information before publication.'},201);
 }catch{return siteOut({error:'Could not save your Novel Updates link. Try again later.'},503)}
}

async function siteFeedbackRoute(request,env,scope,email){
 if(request.method!=='POST')return siteOut({error:'Method not allowed'},405);
 if(request.headers.get('Origin')!==new URL(request.url).origin)return siteOut({error:'Wrong origin'},403);
 if(!env.COMMUNITY_DB)return siteOut({error:'Community database is not configured'},503);
 if(!(request.headers.get('content-type')||'').startsWith('application/json'))return siteOut({error:'Expected JSON'},415);
 let body;
 try{const raw=await request.text();if(raw.length>7000)return siteOut({error:'Message too long'},413);body=JSON.parse(raw)}catch{return siteOut({error:'Invalid submission'},400)}
 if(!body||typeof body!=='object'||Array.isArray(body))return siteOut({error:'Invalid submission'},400);
 if(scope==='public'){
  if(!env.TURNSTILE_SECRET||!env.TURNSTILE_SITE_KEY)return siteOut({error:'Public questions require the site security check to be configured'},503);
  try{if(!await communityVerifyTurnstile(request,env,siteTrim(body.turnstile,1800)))return siteOut({error:'Please complete the security check and try again'},403)}catch{return siteOut({error:'Security check is temporarily unavailable'},503)}
 }
 const kind=body.kind==='question'?'question':body.kind==='suggestion'?'suggestion':null;
 const displayName=siteTrim(body.name,70),subject=siteTrim(body.subject,120),message=siteTrim(body.message,3000);
 const replyTo=siteTrim(body.replyTo,160);
 if(!kind||displayName.length<2||subject.length<3||message.length<10)return siteOut({error:'Choose a type and provide your name, subject and a message of at least 10 characters'},400);
 if(replyTo&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)||replyTo.length>160))return siteOut({error:'Enter a valid reply email or leave it blank'},400);
 // A small hidden honeypot reduces trivial form spam without making answers public.
 if(body.website)return siteOut({ok:true,status:'pending'},201);
 const id=crypto.randomUUID();
 try{await env.COMMUNITY_DB.prepare('INSERT INTO conservatory_site_feedback(id,scope,kind,display_name,reply_to,subject,message,status,member_email) VALUES (?,?,?,?,?,?,?,?,?)').bind(id,scope,kind,displayName,replyTo,subject,message,'pending',scope==='private'?email||'':'').run();}
 catch{return siteOut({error:'Could not save your message'},503)}
 return siteOut({ok:true,id,status:'pending'},201);
}
async function siteAdminRoute(request,env,email,role){
 if(role!=='owner')return siteOut({error:'Owner access required'},403);
 if(!env.COMMUNITY_DB)return siteOut({error:'Shared database unavailable'},503);
 const url=new URL(request.url),path=url.pathname,method=request.method.toUpperCase();
 if(path==='/api/admin/site-config'){
  if(method==='GET'){
   try{return siteOut({public:await siteGet(env,'public'),private:await siteGet(env,'private')})}catch{return siteOut({error:'Run the shared site-settings migration first'},503)}
  }
  if(method!=='POST')return siteOut({error:'Method not allowed'},405);
  if(request.headers.get('Origin')!==url.origin)return siteOut({error:'Wrong origin'},403);
  let raw;try{const text=await request.text();if(text.length>8000)return siteOut({error:'Too much text'},413);raw=JSON.parse(text)}catch{return siteOut({error:'Invalid JSON'},400)}
  if(!['public','private'].includes(raw?.scope))return siteOut({error:'Invalid site scope'},400);
  const config=siteClean(raw.settings);if(!config)return siteOut({error:'Please enter a valid Instagram username or URL, or leave it blank'},400);
  try{
   await env.COMMUNITY_DB.prepare('INSERT INTO conservatory_site_config(scope,config_json,updated_by) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET config_json=excluded.config_json,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP').bind(raw.scope,JSON.stringify(config),email).run();
   return siteOut({ok:true,scope:raw.scope,settings:config});
  }catch{return siteOut({error:'Could not save settings. Run the shared SQL migration.'},503)}
 }
 if(path==='/api/admin/site-feedback'){
  if(method==='GET'){
   const status=['pending','resolved','archived'].includes(url.searchParams.get('status'))?url.searchParams.get('status'):'pending';
   try{const r=await env.COMMUNITY_DB.prepare('SELECT id,scope,kind,display_name,reply_to,subject,message,status,created_at,member_email FROM conservatory_site_feedback WHERE status=? ORDER BY created_at DESC LIMIT 200').bind(status).all();return siteOut({items:r.results||[]})}catch{return siteOut({error:'Feedback inbox unavailable. Run the shared SQL migration.'},503)}
  }
  if(method==='POST'){
   if(request.headers.get('Origin')!==url.origin)return siteOut({error:'Wrong origin'},403);
   let raw;try{raw=JSON.parse(await request.text())}catch{return siteOut({error:'Invalid JSON'},400)}
   if(!/^[a-f0-9-]{36}$/.test(String(raw.id||''))||!['pending','resolved','archived'].includes(raw.status))return siteOut({error:'Invalid feedback update'},400);
   try{await env.COMMUNITY_DB.prepare('UPDATE conservatory_site_feedback SET status=?,moderated_by=?,moderated_at=CURRENT_TIMESTAMP WHERE id=?').bind(raw.status,email,raw.id).run();return siteOut({ok:true,id:raw.id,status:raw.status})}catch{return siteOut({error:'Could not update feedback'},503)}
  }
  return siteOut({error:'Method not allowed'},405);
 }
 return siteOut({error:'Not found'},404);
}

// Additional catalogue entries. Independent from the 962-entry seed and its
// strict D1 CHECK constraints. Public project only receives COMMUNITY_DB and
// COMMUNITY_IMAGES. Private EPUBs are handled by private-only edition routes.
const extraJson=(x,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const extraTxt=(x,n=200)=>String(x??'').normalize('NFKC').trim().slice(0,n);
const extraId=x=>Number.isSafeInteger(Number(x))&&Number(x)>=100000?Number(x):null;
const extraOrigin=r=>r.headers.get('Origin')===new URL(r.url).origin;
const extraUrl=x=>{try{const u=new URL(extraTxt(x,700));return u.protocol==='https:'&&!u.username&&!u.password?u.href.slice(0,700):'';}catch{return '';}};
const extraTags=x=>[...new Set((Array.isArray(x)?x:String(x||'').split(/[,;\n]/)).map(t=>extraTxt(t,65)).filter(Boolean))].slice(0,35);
function extraPayload(input){
 const x=input&&typeof input==='object'?input:{};
 return {
  title:extraTxt(x.title,210),originalTitle:extraTxt(x.originalTitle,210),author:extraTxt(x.author,140),
  originalLanguage:extraTxt(x.originalLanguage,65),language:extraTxt(x.language,65)||'English',
  translator:extraTxt(x.translator,170),translation:['completed','ongoing','incomplete','dropped','licensed','original','unconfirmed'].includes(x.translation)?x.translation:'unconfirmed',
  totalChapters:x.totalChapters!==null&&x.totalChapters!==undefined&&String(x.totalChapters).trim()!==''&&Number.isInteger(Number(x.totalChapters))&&Number(x.totalChapters)>=0?Math.min(Number(x.totalChapters),999999):null,
  chaptersTranslated:x.chaptersTranslated!==null&&x.chaptersTranslated!==undefined&&String(x.chaptersTranslated).trim()!==''&&Number.isInteger(Number(x.chaptersTranslated))&&Number(x.chaptersTranslated)>=0?Math.min(Number(x.chaptersTranslated),999999):null,
  synopsis:extraTxt(x.synopsis,6000),genres:extraTags(x.genres),tags:extraTags(x.tags),
  contentWarnings:extraTags(x.contentWarnings),nuUrl:extraUrl(x.nuUrl),translatorUrl:extraUrl(x.translatorUrl),
  originalUrl:extraUrl(x.originalUrl),sourceUrl:extraUrl(x.sourceUrl),
  coverCredit:extraTxt(x.coverCredit,180),coverRights:!!x.coverRights,
  metadataSource:extraTxt(x.metadataSource,160)||'Reader submission',
  metadataReview:!!x.metadataReview,
  collection:'non-CG',novelOrigin:extraTxt(x.novelOrigin,120)||'Other source'
 };
}
async function extraPhoto(file,env){
 if(!(file instanceof File)||!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size<80||file.size>2800000)throw Error('Cover must be a JPG, PNG, or WebP under 2.8 MB');
 if(!env.COMMUNITY_IMAGES)throw Error('Shared image bucket is not connected');
 const bytes=await file.arrayBuffer();const v=new Uint8Array(bytes);
 const good=file.type==='image/png'?v[0]===137&&v[1]===80&&v[2]===78&&v[3]===71&&v[4]===13&&v[5]===10&&v[6]===26&&v[7]===10:
  file.type==='image/jpeg'?v[0]===255&&v[1]===216&&v[2]===255:
  String.fromCharCode(...v.slice(0,4))==='RIFF'&&String.fromCharCode(...v.slice(8,12))==='WEBP';
 if(!good)throw Error('Cover does not match its image format');
 const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[file.type];
 const key='additional-novel-covers/'+crypto.randomUUID()+'.'+ext;
 await env.COMMUNITY_IMAGES.put(key,bytes,{httpMetadata:{contentType:file.type}});
 return key;
}
function extraDecorate(row,scope){
 let v;try{v=JSON.parse(row.payload_json||'{}')}catch{v={}};
 const cover=row.cover_key?'/api/additional/cover?id='+row.id:'';
 return {...v,id:row.id,title:row.title,cover,coverRights:!!cover,translation:v.translation||'unconfirmed',visibility:scope==='private'?row.visibility:undefined};
}
async function extraNovelExists(env,id){
 if(!extraId(id)||!env.COMMUNITY_DB)return false;
 const r=await env.COMMUNITY_DB.prepare('SELECT id FROM additional_catalogue_novels WHERE id=?').bind(id).first();return !!r;
}
async function extraInsert(env,payload,coverKey,visibility,who,submissionId=''){
 const key=payload.title.toLocaleLowerCase().replace(/\s+/g,' ').trim();
 if(!payload.title||payload.title.length<2)throw Error('Enter a novel title');
 const duplicate=await env.COMMUNITY_DB.prepare("SELECT id,title FROM additional_catalogue_novels WHERE normalized_title=? AND source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%' LIMIT 1").bind(key).first();
 if(duplicate)throw Error('This title may already exist as #'+duplicate.id+'. Check before submitting again.');
 for(let i=0;i<5;i++){
  const id=100000+crypto.getRandomValues(new Uint32Array(1))[0];
  try{
   await env.COMMUNITY_DB.prepare('INSERT INTO additional_catalogue_novels(id,normalized_title,title,payload_json,cover_key,visibility,source_submission_id,created_by) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id,key,payload.title,JSON.stringify(payload),coverKey,visibility,submissionId,who).run();return id;
  }catch(e){if(!/unique|constraint.*id/i.test(String(e?.message||'')))throw e;}
 }
 throw Error('Could not assign novel ID; please retry');
}

// Public community catalogue writes: publish on submission, log every change,
// and preserve private novels/EPUBs without making them visible.
const guestKey=x=>String(x||'').normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]/gu,'');
const guestEmpty=x=>x==null||x===''||(Array.isArray(x)&&x.length===0);
const guestNu=x=>{
 try{const u=new URL(String(x||''));const m=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/.exec(u.pathname);
  return u.protocol==='https:'&&['www.novelupdates.com','novelupdates.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&m?
   'https://www.novelupdates.com/series/'+m[1]+'/':'';}catch{return ''}
};
const guestMerge=(current,incoming)=>{
 const result={...current},changed=[];
 for(const field of ['title','author','originalTitle','synopsis','genres','tags','contentWarnings','nuUrl',
  'translator','translatorUrl','originalLanguage','originalUrl','sourceUrl','language','translation','novelOrigin']){
  const value=incoming[field],old=result[field];
  if(guestEmpty(value))continue;
  if(['genres','tags','contentWarnings'].includes(field)){
   const before=extraTags(old),values=extraTags(value);
   const next=[...before];
   for(const x of values)if(!next.some(y=>guestKey(y)===guestKey(x)))next.push(x);
   if(next.length!==before.length){result[field]=next.slice(0,35);changed.push(field)}
  }else if(guestEmpty(old)||field==='translation'&&old==='unconfirmed'&&value!=='unconfirmed'){
   result[field]=value;changed.push(field);
  }
 }
 if(changed.length&&!current.metadataReview){
  result.metadataReview=false;
  result.metadataSource=current.metadataSource&&current.metadataSource!=='Reader submission'?
   current.metadataSource:'Community submission (unreviewed)';
 }
 return {result,changed};
};
let guestSeedCache=null;
async function guestSeed(env,request){
 if(guestSeedCache)return guestSeedCache;
 const r=await env.ASSETS.fetch(new Request(new URL('/',request.url)));
 if(!r.ok)throw Error('Cannot check the original catalogue now. Retry your submission.');
 const html=await r.text();
 const found=/<script\s+id="seed"\s+type="application\/json">([\s\S]*?)<\/script>/.exec(html);
 if(!found)throw Error('Original catalogue unavailable; submission was not published.');
 const books=JSON.parse(found[1]);if(!Array.isArray(books)||books.length<900)throw Error('The original catalogue could not be checked.');
 guestSeedCache=books;return books;
}
async function guestJournal(env){
 await env.COMMUNITY_DB.prepare("CREATE TABLE IF NOT EXISTS catalogue_edit_events (id TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation IN ('merge','metadata_sync','create')),target_id INTEGER NOT NULL,duplicate_id INTEGER,before_json TEXT NOT NULL,after_json TEXT NOT NULL,source_url TEXT NOT NULL DEFAULT '',actor_email TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,undone_at TEXT,undone_by TEXT NOT NULL DEFAULT '',CHECK(target_id>=1))").run();
 await env.COMMUNITY_DB.prepare('CREATE INDEX IF NOT EXISTS idx_catalogue_edit_events_recent ON catalogue_edit_events(created_at DESC)').run();
}
async function guestCandidates(env,request,p){
 const [seed,raw,overrides]=await Promise.all([
  guestSeed(env,request),
  env.COMMUNITY_DB.prepare("SELECT * FROM additional_catalogue_novels WHERE visibility='published' AND source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%' ORDER BY created_at ASC LIMIT 5000").all(),
  env.COMMUNITY_DB.prepare('SELECT novel_id,patch_json FROM published_catalogue_overrides LIMIT 1500').all()
 ]);
 const patches=new Map((overrides.results||[]).map(x=>{let data={};try{data=JSON.parse(x.patch_json)}catch{}return [Number(x.novel_id),data]}));
 const originals=seed.map(book=>({...book,...(patches.get(book.id)||{}),kind:'seed'}));
 const added=(raw.results||[]).map(row=>{let values={};try{values=JSON.parse(row.payload_json)}catch{}return {...values,id:row.id,title:row.title,kind:'extra',row}});
 const source=guestNu(p.nuUrl)||guestNu(p.sourceUrl),title=guestKey(p.title),original=guestKey(p.originalTitle),author=guestKey(p.author);
 const matches=[];
 for(const item of [...originals,...added]){
  const targetSource=guestNu(item.nuUrl)||guestNu(item.sourceUrl);
  const sameSource=!!source&&source===targetSource;
  const conflictingSources=!!source&&!!targetSource&&source!==targetSource;
  const sameTitle=!!title&&(title===guestKey(item.title)||title===guestKey(item.originalTitle))
   ||!!original&&(original===guestKey(item.title)||original===guestKey(item.originalTitle));
  const sameAuthor=!!author&&author===guestKey(item.author);
  if(!conflictingSources&&(sameSource||sameTitle&&sameAuthor))
   matches.push({item,rank:sameSource?3:2});
 }
 matches.sort((a,b)=>b.rank-a.rank||(a.item.kind==='seed'?-1:1)-(b.item.kind==='seed'?-1:1)||Number(a.item.id)-Number(b.item.id));
 return matches.length?matches[0].item:null;
}
async function guestApply(env,request,p,coverKey,visitor){
 await guestJournal(env);
 const found=await guestCandidates(env,request,p);
 const who='public-contributor';
 const eventId=crypto.randomUUID();
 if(!found){
  // Same title can be a genuinely different novel. Identity checking above
  // avoids hiding independent works just because the titles are identical.
  let id=null;
  for(let attempt=0;attempt<5;attempt++){
   const candidate=100000+crypto.getRandomValues(new Uint32Array(1))[0];
   try{
    await env.COMMUNITY_DB.prepare('INSERT INTO additional_catalogue_novels(id,normalized_title,title,payload_json,cover_key,visibility,source_submission_id,created_by) VALUES (?,?,?,?,?,?,?,?)')
     .bind(candidate,p.title.toLowerCase().replace(/\s+/g,' ').trim(),p.title,JSON.stringify(p),coverKey,'published','',who).run();
    id=candidate;break;
   }catch(error){if(!/unique|constraint.*id/i.test(String(error?.message||'')))throw error}
  }
  if(!id)throw Error('Unable to create a unique novel ID. Please retry.');
  const snap={targetKind:'created',beforeTarget:null,afterTarget:JSON.stringify(p),sourceId:null,
   beforeSourceMarker:'',afterSourceMarker:'reverted-create:'+id,beforeVisibility:null,afterVisibility:'published',
   beforeCoverKey:'',afterCoverKey:coverKey||''};
  try{
   await env.COMMUNITY_DB.prepare('INSERT INTO catalogue_edit_events(id,operation,target_id,duplicate_id,before_json,after_json,source_url,actor_email) VALUES(?,?,?,?,?,?,?,?)')
    .bind(eventId,'create',id,null,JSON.stringify(snap),JSON.stringify({target:JSON.stringify(p)}),guestNu(p.nuUrl),who).run();
  }catch(error){
   await env.COMMUNITY_DB.prepare("DELETE FROM additional_catalogue_novels WHERE id=? AND payload_json=? AND source_submission_id=''").bind(id,JSON.stringify(p)).run().catch(()=>{});
   throw error;
  }
  return {ok:true,novelId:id,created:true,eventId,usedCover:!!coverKey,changedFields:['new novel']};
 }
 if(found.kind==='extra'){
  const row=found.row,old=JSON.parse(row.payload_json||'{}');
  const {result,changed}=guestMerge(old,p);
  const before=row.payload_json,after=JSON.stringify(result);
  const addedCover=!!coverKey&&!row.cover_key;
  if(!changed.length&&!addedCover)return {ok:true,novelId:row.id,reused:true,unchanged:true,usedCover:false};
  const nextCover=addedCover?coverKey:row.cover_key;
  const snap={targetKind:'extra',beforeTarget:before,afterTarget:after,sourceId:null,
   beforeSourceMarker:null,afterSourceMarker:null,beforePrivate:null,afterPrivate:null,
   beforeVisibility:'published',afterVisibility:'published',beforeCoverKey:row.cover_key||'',afterCoverKey:nextCover||''};
  const write=await env.COMMUNITY_DB.prepare(
   "UPDATE additional_catalogue_novels SET payload_json=?,cover_key=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payload_json=? AND cover_key=? AND visibility='published'")
   .bind(after,nextCover,row.id,before,row.cover_key).run();
  if((write.meta?.changes||0)!==1)throw Error('This book changed while submitting. Please retry.');
  try{await env.COMMUNITY_DB.prepare('INSERT INTO catalogue_edit_events(id,operation,target_id,duplicate_id,before_json,after_json,source_url,actor_email) VALUES(?,?,?,?,?,?,?,?)')
   .bind(eventId,'metadata_sync',row.id,null,JSON.stringify(snap),JSON.stringify({target:after}),guestNu(p.nuUrl),who).run();}
  catch(error){
   await env.COMMUNITY_DB.prepare("UPDATE additional_catalogue_novels SET payload_json=?,cover_key=? WHERE id=? AND payload_json=? AND cover_key=?")
    .bind(before,row.cover_key,row.id,after,nextCover).run().catch(()=>{});
   throw error;
  }
  return {ok:true,novelId:row.id,reused:true,eventId,usedCover:addedCover,changedFields:[...changed,...(addedCover?['cover']:[])]};
 }
 // Existing original catalogue: only fill blanks and union unique tags;
 // never let an anonymous contribution replace curated descriptions.
 const base=found;
 const row=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(base.id).first();
 const before=row?.patch_json??null,old=before?JSON.parse(before):{};
 const {result,changed}=guestMerge({...base,...old},p);
 let newImageId=null;
 if(coverKey&&!result.cover){
  newImageId=crypto.randomUUID();
  result.cover='/api/community/image?id='+newImageId;
  result.coverRights=true;result.coverCredit=p.coverCredit;
  changed.push('cover');
 }
 if(!changed.length)return {ok:true,novelId:base.id,reused:true,unchanged:true,usedCover:false};
 // Store only the fields that actually differ from the original. Other
 // published changes survive untouched in the patch.
 const next={...old};
 for(const key of changed)if(key!=='cover')next[key]=result[key];
 if(newImageId){next.cover=result.cover;next.coverRights=true;next.coverCredit=p.coverCredit}
 if(!old.metadataReview)next.metadataReview=false;
 if(!old.metadataSource)next.metadataSource='Community submission (unreviewed)';
 const after=JSON.stringify(next);
 if(newImageId)await env.COMMUNITY_DB.prepare('INSERT INTO community_entries(id,scope,novel_id,kind,display_name,author_identity,body,rating,spoiler,tags_json,external_url,image_key,image_credit,parent_id,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .bind(newImageId,'public',base.id,'image',visitor||'Community contributor',who,'Community-submitted cover',null,0,'[]','',coverKey,p.coverCredit,'','approved').run();
 let write;
 try{
  write=before===null?await env.COMMUNITY_DB.prepare(
   'INSERT INTO published_catalogue_overrides(novel_id,patch_json,source_entry_id,published_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING')
   .bind(base.id,after,eventId,who).run():await env.COMMUNITY_DB.prepare(
   'UPDATE published_catalogue_overrides SET patch_json=?,source_entry_id=?,published_by=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?')
   .bind(after,eventId,who,base.id,before).run();
  if((write.meta?.changes||0)!==1)throw Error('This book changed while saving. Retry to include the latest changes.');
  const snap={targetKind:'seed',beforeTarget:before,afterTarget:after,sourceId:null,
   beforeSourceMarker:null,afterSourceMarker:null,beforePrivate:null,afterPrivate:null};
  await env.COMMUNITY_DB.prepare('INSERT INTO catalogue_edit_events(id,operation,target_id,duplicate_id,before_json,after_json,source_url,actor_email) VALUES(?,?,?,?,?,?,?,?)')
   .bind(eventId,'metadata_sync',base.id,null,JSON.stringify(snap),JSON.stringify({target:after}),guestNu(p.nuUrl),who).run();
 }catch(error){
  if(before===null)await env.COMMUNITY_DB.prepare('DELETE FROM published_catalogue_overrides WHERE novel_id=? AND patch_json=?').bind(base.id,after).run().catch(()=>{});
  else await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=? WHERE novel_id=? AND patch_json=?').bind(before,base.id,after).run().catch(()=>{});
  if(newImageId)await env.COMMUNITY_DB.prepare('DELETE FROM community_entries WHERE id=?').bind(newImageId).run().catch(()=>{});
  throw error;
 }
 return {ok:true,novelId:base.id,reused:true,eventId,usedCover:!!newImageId,changedFields:changed};
}

async function additionalRoutes(request,env,scope,email='',role='reader'){
 const path=new URL(request.url).pathname,method=request.method.toUpperCase();
 if(!env.COMMUNITY_DB)return extraJson({error:'Community database binding is missing'},503);
 const editor=scope==='private'&&['owner','editor'].includes(role),owner=scope==='private'&&role==='owner';
 try{
  if(path==='/api/additional/books'&&method==='GET'){
   const sql=scope==='public'?"SELECT * FROM additional_catalogue_novels WHERE visibility='published' AND source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%' ORDER BY created_at DESC LIMIT 5000":"SELECT * FROM additional_catalogue_novels WHERE source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%' ORDER BY created_at DESC LIMIT 5000";
   const rows=await env.COMMUNITY_DB.prepare(sql).all();
   return extraJson({novels:(rows.results||[]).map(row=>extraDecorate(row,scope)),configured:true});
  }
  if(path==='/api/additional/cover'&&method==='GET'){
   const id=extraId(new URL(request.url).searchParams.get('id'));if(!id||!env.COMMUNITY_IMAGES)return new Response('Not found',{status:404});
   const row=await env.COMMUNITY_DB.prepare('SELECT cover_key,visibility,source_submission_id FROM additional_catalogue_novels WHERE id=?').bind(id).first();
   if(!row||!row.cover_key||String(row.source_submission_id||'').startsWith('reverted-create:')||(scope==='public'&&row.visibility!=='published'))return new Response('Not found',{status:404});
   const obj=await env.COMMUNITY_IMAGES.get(row.cover_key);if(!obj)return new Response('Not found',{status:404});
   return new Response(obj.body,{headers:{'content-type':obj.httpMetadata?.contentType||'application/octet-stream','cache-control':scope==='public'?'public,max-age=300':'private,no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"}});
  }
  if(path==='/api/additional/config'&&method==='GET')return extraJson({siteKey:scope==='public'?(env.TURNSTILE_SITE_KEY||''):'',enabled:scope==='private'||!!(env.TURNSTILE_SECRET&&env.TURNSTILE_SITE_KEY)});
  if(path==='/api/additional/submit'&&method==='POST'&&scope==='public'){
   if(!extraOrigin(request))return extraJson({error:'Cross-site submissions are blocked'},403);
   if(!env.TURNSTILE_SECRET||!env.TURNSTILE_SITE_KEY)return extraJson({error:'Submissions are not enabled until Turnstile is configured'},503);
   const fd=await request.formData();
   if(!await communityVerifyTurnstile(request,env,extraTxt(fd.get('cf-turnstile-response'),1800)))return extraJson({error:'Complete the anti-spam verification'},403);
   // Honeypot, same-origin and Turnstile protect this publish-first endpoint.
   if(String(fd.get('website')||'').trim())return extraJson({error:'Invalid submission'},400);
   const p=extraPayload(JSON.parse(extraTxt(fd.get('payload'),18000)||'{}'));
   if(!p.title||!p.author||!p.synopsis||(!p.sourceUrl&&!p.nuUrl&&!p.originalUrl))
    return extraJson({error:'Provide the title, author, synopsis, and a source URL'},400);
   const visitor=extraTxt(fd.get('displayName'),80)||'Anonymous';
   let coverKey='';
   if(fd.get('cover') instanceof File&&fd.get('cover').size){
    if(!p.coverCredit||!p.coverRights)return extraJson({error:'Cover requires credit and permission to display it'},400);
    coverKey=await extraPhoto(fd.get('cover'),env);
   }
   try{
    const result=await guestApply(env,request,p,coverKey,visitor);
    if(coverKey&&!result.usedCover)await env.COMMUNITY_IMAGES.delete(coverKey).catch(()=>{});
    return extraJson({...result,message:result.unchanged?'Already in the library; no changes needed.':
     result.created?'Novel published!':'Existing novel updated!'},200);
   }catch(e){
    // A failed write must never leave an unused uploaded image behind.
    // If the log write failed after the SQL write, the event is rolled back.
    if(coverKey)await env.COMMUNITY_IMAGES.delete(coverKey).catch(()=>{});
    throw e;
   }
  }
  if(path==='/api/admin/additional/submissions'&&method==='GET'){
   if(!editor)return extraJson({error:'Editor access required'},403);
   const rows=await env.COMMUNITY_DB.prepare("SELECT * FROM additional_novel_submissions WHERE status='pending' ORDER BY created_at DESC LIMIT 200").all();
   return extraJson({items:(rows.results||[]).map(r=>({id:r.id,...JSON.parse(r.payload_json),hasCover:!!r.cover_key,displayName:r.display_name,submittedAt:r.created_at}))});
  }
  if(path==='/api/admin/additional/review'&&method==='POST'){
   if(!editor||!extraOrigin(request))return extraJson({error:'Editor permission required'},403);
   const b=await request.json(),id=extraTxt(b.submissionId,36),action=String(b.action||'');
   if(!/^[0-9a-f-]{36}$/.test(id)||!['approve','reject'].includes(action))return extraJson({error:'Invalid review action'},400);
   const row=await env.COMMUNITY_DB.prepare("SELECT * FROM additional_novel_submissions WHERE id=? AND status='pending'").bind(id).first();
   if(!row)return extraJson({error:'Submission already handled'},409);
   let newId=null;
   if(action==='approve'){
    const p=extraPayload(JSON.parse(row.payload_json));newId=await extraInsert(env,p,row.cover_key,'published',email,id);
   }
   const result=await env.COMMUNITY_DB.prepare("UPDATE additional_novel_submissions SET status=?,published_novel_id=?,moderated_by=?,moderated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'")
    .bind(action==='approve'?'approved':'rejected',newId,email,id).run();
   if(!result.meta?.changes)return extraJson({error:'Submission changed. Refresh and retry'},409);
   if(action==='reject'&&row.cover_key&&env.COMMUNITY_IMAGES)await env.COMMUNITY_IMAGES.delete(row.cover_key);
   return extraJson({ok:true,novelId:newId});
  }
  if(path==='/api/admin/additional/create'&&method==='POST'){
   if(!owner||!extraOrigin(request))return extraJson({error:'Owner permission required'},403);
   const b=await request.json(),p=extraPayload(b),visibility=b.publish===true?'published':'private';
   const id=await extraInsert(env,p,'',visibility,email);return extraJson({ok:true,id});
  }
  if(path==='/api/admin/additional/bulk'&&method==='POST'){
   if(!owner||!extraOrigin(request))return extraJson({error:'Owner permission required'},403);
   const body=await request.json();if(!Array.isArray(body.novels)||body.novels.length===0||body.novels.length>100)return extraJson({error:'Import 1–100 novels per batch'},400);
   const results=[];
   for(const raw of body.novels){try{const p=extraPayload(raw),id=await extraInsert(env,p,'',body.publish===true?'published':'private',email);results.push({title:p.title,id,ok:true});}
    catch(e){results.push({title:extraTxt(raw?.title,100),error:String(e.message||e),ok:false});}}
   return extraJson({ok:true,results});
  }
  if(path==='/api/admin/additional/edit'&&method==='POST'){
   if(!owner||!extraOrigin(request))return extraJson({error:'Owner permission required'},403);
   const b=await request.json(),id=extraId(b.id);if(!id)return extraJson({error:'Invalid additional novel ID'},400);
   const row=await env.COMMUNITY_DB.prepare('SELECT * FROM additional_catalogue_novels WHERE id=?').bind(id).first();if(!row)return extraJson({error:'Novel not found'},404);
   const next=extraPayload({...JSON.parse(row.payload_json||'{}'),...b.patch});
   const vis=b.publish===true?'published':b.publish===false?'private':row.visibility;
   await env.COMMUNITY_DB.prepare('UPDATE additional_catalogue_novels SET title=?,normalized_title=?,payload_json=?,visibility=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(next.title,next.title.toLocaleLowerCase(),JSON.stringify(next),vis,id).run();
   return extraJson({ok:true,id});
  }
  if(path==='/api/admin/additional/auto-cover'&&method==='POST'){
   if(!owner||!extraOrigin(request))return extraJson({error:'Owner permission required'},403);
   const fd=await request.formData(),id=extraId(fd.get('novel_id'));
   if(!id)return extraJson({error:'Invalid additional novel'},400);
   const row=await env.COMMUNITY_DB.prepare('SELECT * FROM additional_catalogue_novels WHERE id=?').bind(id).first();
   if(!row)return extraJson({error:'Novel is missing from shared catalogue'},404);
   const old=row.cover_key;
   const key=await extraPhoto(fd.get('image'),env);
   const base=JSON.parse(row.payload_json||'{}');
   const value={...base,coverCredit:extraTxt(fd.get('source'),180)||'Owner EPUB cover',coverRights:true};
   // First recognized cover becomes default, subsequent edition covers do not replace it.
   if(old&&fd.get('replace')!=='1'){await env.COMMUNITY_IMAGES.delete(key);return extraJson({ok:true,published:false,skipped:true});}
   await env.COMMUNITY_DB.prepare('UPDATE additional_catalogue_novels SET cover_key=?,payload_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(key,JSON.stringify(value),id).run();
   return extraJson({ok:true,published:true});
  }
  return extraJson({error:'Not found'},404);
 }catch(e){return extraJson({error:extraTxt(e?.message||'Could not process request',220)},400);}
}
