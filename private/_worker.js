// Novel Conservatory: invitation-only, role-checked Cloudflare Pages Worker.
// Configure: ACCESS_TEAM_DOMAIN, ACCESS_PROD_AUD, ACCESS_PREVIEW_AUD (optional),
// SITE_HOST, OWNER_EMAIL, D1 binding DB, optional R2 IMAGES.
// Cloudflare Access gates the domains, and this Worker independently validates
// the signed Access JWT before returning any page, media, or API data.

// Community features: user-owned shelves, opt-in shared/collaborative shelves,
// translation link reports, and sanitized owner-only metadata backups.
// Stored in the existing D1 site_settings table; no migrations required.
const SHELF_KEY = 'conservatory-shelves-v1:';
const REPORT_KEY = 'conservatory-link-report-v1:';
const SHELF_VISIBILITY = new Set(['private','friends','collaborative']);
const SHELF_DEFAULTS = [
  {id:'want-to-read',name:'Want to Read',visibility:'private',collaborators:[],items:[]},
  {id:'currently-reading',name:'Currently Reading',visibility:'private',collaborators:[],items:[]},
  {id:'completed',name:'Completed',visibility:'private',collaborators:[],items:[]},
  {id:'favorites',name:'Favorites',visibility:'private',collaborators:[],items:[]}
];
const shelfIdValid = v => /^[a-z0-9-]{1,60}$/.test(String(v||''));
const bookIdValid = v => Number.isSafeInteger(Number(v))&&Number(v)>=1&&(Number(v)<=962||Number(v)>=100000);
const cleanShelfItem = v => ({id:Number(v.id),notes:textField(v.notes,300),addedAt:new Date().toISOString()});
function safeShelfRecord(raw){
  if(!raw||typeof raw!=='object'||!Array.isArray(raw.shelves))return structuredClone({shelves:SHELF_DEFAULTS});
  return {shelves:raw.shelves.filter(s=>s&&shelfIdValid(s.id)).slice(0,24).map(s=>({
    id:s.id,name:textField(s.name,80),visibility:SHELF_VISIBILITY.has(s.visibility)?s.visibility:'private',
    collaborators:Array.isArray(s.collaborators)?s.collaborators.map(emailNorm).filter(emailValid).slice(0,15):[],
    items:Array.isArray(s.items)?s.items.filter(x=>bookIdValid(x.id)).slice(0,300).map(x=>({id:Number(x.id),notes:textField(x.notes,300),addedAt:String(x.addedAt||'').slice(0,35)})):[],
  }))};
}
async function readShelfState(owner,env){
  const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(SHELF_KEY+owner).first();
  return {value:row?.value||null,state:row?safeShelfRecord(JSON.parse(row.value)):structuredClone({shelves:SHELF_DEFAULTS})};
}
async function saveShelfState(owner,state,env,previous){
  const value=JSON.stringify(state);
  if(value.length>180000)throw Error('Shelf limit exceeded');
  if(previous===null){
    const result=await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').bind(SHELF_KEY+owner,value).run();
    return (result.meta?.changes??1)>0;
  }
  const result=await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?').bind(value,SHELF_KEY+owner,previous).run();
  return (result.meta?.changes??1)>0;
}
function allowedShelfView(shelf,viewer,owner){
  return viewer===owner||shelf.visibility==='friends'||(shelf.visibility==='collaborative'&&shelf.collaborators.includes(viewer));
}
async function shelfRoutes(request,env,email){
  const url=new URL(request.url),path=url.pathname,method=request.method.toUpperCase();
  if(!env.DB)return respond({error:'Database not connected'},503);
  try{
    if(path==='/api/shelves/export'&&method==='GET'){
      const {state}=await readShelfState(email,env);
      const value={format:'novel-conservatory-personal-shelves-v1',generatedAt:new Date().toISOString(),owner:email,shelves:state.shelves};
      return new Response(JSON.stringify(value,null,2),{headers:{...JSON_HEADERS,'content-disposition':'attachment; filename="my-novel-conservatory-shelves.json"'}});
    }
    if(path==='/api/shelves/mine'&&method==='GET'){
      const {state}=await readShelfState(email,env);
      return respond({owner:email,shelves:state.shelves});
    }
    if(path==='/api/shelves/community'&&method==='GET'){
      const r=await env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'conservatory-shelves-v1:%' LIMIT 400").all();
      const rows=[];
      for(const item of r.results||[]){
        const owner=item.key.slice(SHELF_KEY.length);
        if(!emailValid(owner)||owner===email)continue;
        const memberRole=await roleFor(owner,env);
        if(!await isSiteMember(owner,memberRole,env))continue;
        let state;try{state=safeShelfRecord(JSON.parse(item.value))}catch{continue}
        for(const shelf of state.shelves){
          if(allowedShelfView(shelf,email,owner))rows.push({owner,...shelf,canEdit:shelf.visibility==='collaborative'&&shelf.collaborators.includes(email)});
        }
      }
      return respond({shelves:rows.slice(0,200)});
    }
    if(path==='/api/shelves/view'&&method==='GET'){
      const owner=emailNorm(url.searchParams.get('owner'));
      if(!emailValid(owner))return respond({error:'Invalid shelf owner'},400);
      const memberRole=await roleFor(owner,env);
      if(!await isSiteMember(owner,memberRole,env))return respond({error:'Shelf not found'},404);
      const {state}=await readShelfState(owner,env),shelf=state.shelves.find(x=>x.id===url.searchParams.get('id'));
      if(!shelf||!allowedShelfView(shelf,email,owner))return respond({error:'Shelf not found'},404);
      return respond({owner,shelf,canEdit:owner===email||(shelf.visibility==='collaborative'&&shelf.collaborators.includes(email))});
    }
    if(path!=='/api/shelves'||method!=='POST')return respond({error:'Not found'},404);
    if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
    const body=await getJson(request),action=String(body.action||'');
    if(!['create','update','delete','add','remove-book'].includes(action))return respond({error:'Unknown shelf operation'},400);
    const owner=action==='add'||action==='remove-book'?emailNorm(body.owner||email):email;
    if(!emailValid(owner))return respond({error:'Invalid shelf owner'},400);
    const memberRole=await roleFor(owner,env);
    if(!await isSiteMember(owner,memberRole,env))return respond({error:'Shelf not found'},404);
    const {state,value}=await readShelfState(owner,env);
    if(action==='create'){
      if(owner!==email)return respond({error:'Only owners can create shelves'},403);
      if(state.shelves.length>=24)return respond({error:'Maximum 24 shelves'},400);
      const name=textField(body.name,80);if(!name)return respond({error:'Enter a shelf name'},400);
      state.shelves.push({id:crypto.randomUUID(),name,visibility:'private',collaborators:[],items:[]});
      // UUIDs are allowed in shelf IDs; IDs may also be built-in slugs.
    }else{
      const shelf=state.shelves.find(x=>x.id===body.id);
      if(!shelf)return respond({error:'Shelf not found'},404);
      const isOwner=owner===email;
      const canCollaborate=shelf.visibility==='collaborative'&&shelf.collaborators.includes(email);
      if(!isOwner&&!canCollaborate)return respond({error:'Only the shelf owner or a collaborator can edit this shelf'},403);
      if(action==='update'){
        if(!isOwner)return respond({error:'Only the shelf owner can change sharing settings'},403);
        const name=textField(body.name,80);
        if(!name)return respond({error:'Enter a shelf name'},400);
        const visibility=String(body.visibility||'private');
        if(!SHELF_VISIBILITY.has(visibility))return respond({error:'Invalid visibility'},400);
        const collaborators=(Array.isArray(body.collaborators)?body.collaborators:[]).map(emailNorm).filter(emailValid).filter(x=>x!==owner).slice(0,15);
        for(const person of collaborators){
          const memberRole=await roleFor(person,env);
          if(!await isSiteMember(person,memberRole,env))return respond({error:'Invite '+person+' to the library before collaborating'},400);
        }
        shelf.name=name;shelf.visibility=visibility;shelf.collaborators=visibility==='collaborative'?[...new Set(collaborators)]:[];
      }else if(action==='delete'){
        if(!isOwner)return respond({error:'Only the shelf owner may delete shelves'},403);
        state.shelves=state.shelves.filter(x=>x.id!==body.id);
      }else if(action==='add'){
        if(!bookIdValid(body.bookId))return respond({error:'Invalid novel ID'},400);
        const bookId=Number(body.bookId),notes=textField(body.notes,300);
        const prior=shelf.items.find(x=>x.id===bookId);
        if(prior)prior.notes=notes;
        else{
          if(shelf.items.length>=300)return respond({error:'Maximum 300 novels per shelf'},400);
          shelf.items.push(cleanShelfItem({id:bookId,notes}));
        }
      }else if(action==='remove-book'){
        if(!bookIdValid(body.bookId))return respond({error:'Invalid novel ID'},400);
        shelf.items=shelf.items.filter(x=>x.id!==Number(body.bookId));
      }
    }
    if(!await saveShelfState(owner,state,env,value))return respond({error:'Shelf changed in another tab. Refresh and try again.'},409);
    return respond({ok:true,owner,shelves:state.shelves});
  }catch(e){return respond({error:textField(e.message||'Invalid shelf request',160)},400)}
}
async function linkReportRoutes(request,env,email,role){
  const url=new URL(request.url),path=url.pathname,method=request.method.toUpperCase();
  if(!env.DB)return respond({error:'Database not connected'},503);
  try{
    if(path==='/api/admin/link-reports'&&method==='GET'){
      if(!isEditor(role))return respond({error:'Editor access required'},403);
      const rows=await env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'conservatory-link-report-v1:%' ORDER BY updated_at DESC LIMIT 500").all();
      const reports=[];for(const row of rows.results||[])try{reports.push(JSON.parse(row.value))}catch{}
      return respond({reports});
    }
    if(method!=='POST'||!sameOrigin(request))return respond({error:'Not allowed'},403);
    const body=await getJson(request);
    if(path==='/api/link-reports'){
      if(!bookIdValid(body.bookId))return respond({error:'Invalid novel ID'},400);
      const kind=['broken','moved','missing','other'].includes(body.reason)?body.reason:'broken';
      const message=textField(body.message,400),urlValue=safeLink(body.url);
      const id=crypto.randomUUID();
      const report={id,bookId:Number(body.bookId),reason:kind,message,url:urlValue,reporter:email,status:'open',createdAt:new Date().toISOString()};
      await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?)').bind(REPORT_KEY+id,JSON.stringify(report)).run();
      return respond({ok:true,id});
    }
    if(path==='/api/admin/link-reports'){
      if(!isEditor(role))return respond({error:'Editor access required'},403);
      const id=String(body.id||''),status=String(body.status||'');
      if(!/^[a-f0-9-]{36}$/.test(id)||!['open','reviewing','resolved','dismissed'].includes(status))return respond({error:'Invalid update'},400);
      const key=REPORT_KEY+id;
      const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(key).first();
      if(!row)return respond({error:'Report not found'},404);
      const report=JSON.parse(row.value);
      report.status=status;report.reviewedBy=email;report.reviewedAt=new Date().toISOString();
      await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=?').bind(JSON.stringify(report),key).run();
      await audit(env,email,'link-report.status',id,status);
      return respond({ok:true,report});
    }
    return respond({error:'Not found'},404);
  }catch(e){return respond({error:textField(e.message||'Invalid link report',160)},400)}
}
async function backupRoutes(request,env,email,role){
  if(role!=='owner')return respond({error:'Only the owner can export catalogue backups'},403);
  if(!env.DB)return respond({error:'Database not connected'},503);
  const [edits,homepage,memberRows,editors,links]=await Promise.all([
    env.DB.prepare('SELECT id,patch FROM novel_edits ORDER BY id').all(),
    env.DB.prepare("SELECT value FROM site_settings WHERE key='homepage'").first(),
    env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'site-reader:%' OR key LIKE 'epub-reader:%'").all(),
    env.DB.prepare('SELECT email,role FROM editor_roles ORDER BY email').all(),
    env.DB.prepare("SELECT value FROM site_settings WHERE key LIKE 'conservatory-link-report-v1:%'").all()
  ]);
  const reports=[];for(const r of links.results||[])try{reports.push(JSON.parse(r.value))}catch{}
  const backup={format:'novel-conservatory-metadata-backup-v1',generatedAt:new Date().toISOString(),
    warning:'Contains private member emails and private reports. Store securely. Does not include EPUB files, R2 object keys, authentication tokens, private shelves belonging to friends, or invitation codes.',
    edits:(edits.results||[]).map(x=>({id:x.id,patch:JSON.parse(x.patch)})),
    homepage:homepage?JSON.parse(homepage.value):{},
    membership:(memberRows.results||[]).filter(x=>x.value==='true').map(x=>({type:x.key.startsWith('epub-reader:')?'epubReader':'reader',email:x.key.split(':').slice(1).join(':')})),
    editors:editors.results||[],linkReports:reports};
  return new Response(JSON.stringify(backup,null,2),{headers:{...JSON_HEADERS,'content-disposition':'attachment; filename="novel-conservatory-metadata-backup.json"'}});
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const respond = (body,status=200) => new Response(JSON.stringify(body),{status,headers:JSON_HEADERS});
const emailNorm = x => String(x||'').trim().toLowerCase();
const emailValid = x => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(x) && x.length<=254;
const textField = (v,max) => String(v??'').trim().slice(0,max);
const textArray = v => Array.isArray(v) ? v.filter(x=>typeof x==='string').map(x=>x.trim().slice(0,75)).filter(Boolean).slice(0,24):[];
const safeLink = x => {try{const u = new URL(x);return u.protocol==='https:'&&!/(^|\.)(docs\.google\.com|drive\.google\.com)$/.test(u.hostname)?u.href:'';}catch{return '';}};
// A single novel can have multiple credited translation editions.
// Keep these in novel_edits.patch to avoid changing any existing D1 tables.
const translationStatuses=new Set(['completed','ongoing','incomplete','dropped','licensed','unconfirmed']);
function cleanTranslations(value){
  if(!Array.isArray(value))return [];
  return value.slice(0,12).map(v=>{
    if(!v||typeof v!=='object'||Array.isArray(v))return null;
    const name=textField(v.name,160);
    if(!name)return null;
    return {name,label:textField(v.label,120),language:textField(v.language,60),
      status:translationStatuses.has(v.status)?v.status:'unconfirmed',
      readUrl:safeLink(v.readUrl),siteUrl:safeLink(v.siteUrl),
      notes:textField(v.notes,280),
      chaptersTranslated:Number.isSafeInteger(Number(v.chaptersTranslated)) && v.chaptersTranslated!==null && v.chaptersTranslated!=='' && Number(v.chaptersTranslated)>=0 && Number(v.chaptersTranslated)<=100000?Number(v.chaptersTranslated):null,
      totalChapters:Number.isSafeInteger(Number(v.totalChapters)) && v.totalChapters!==null && v.totalChapters!=='' && Number(v.totalChapters)>=0 && Number(v.totalChapters)<=100000?Number(v.totalChapters):null,
      lastUpdated:/^\d{4}-\d{2}-\d{2}$/.test(String(v.lastUpdated||''))?String(v.lastUpdated):''};
  }).filter(Boolean);
}
const isImagePath = x => /^\/media\/[a-f0-9-]{36}\.(?:png|jpe?g|webp|gif)$/.test(x);
function cleanPatch(p){
  const r={}; if(!p||typeof p!=='object'||Array.isArray(p))return r;
  for(const k of ['title','originalTitle','author','translator'])if(k in p)r[k]=textField(p[k],240);
  if('synopsis' in p)r.synopsis=textField(p.synopsis,2000);
  if('translations' in p && Array.isArray(p.translations))r.translations=cleanTranslations(p.translations);
  for(const k of ['genres','tags','contentWarnings'])if(k in p)r[k]=textArray(p[k]);
  if('translation' in p&&['completed','ongoing','incomplete','dropped','original','licensed','unconfirmed'].includes(p.translation))r.translation=p.translation;
  for(const k of ['nuUrl','translatorUrl'])if(k in p)r[k]=safeLink(p[k]);
  if('cover' in p){const x=String(p.cover||'');r.cover=isImagePath(x)?x:safeLink(x);}
  if('coverRights' in p)r.coverRights=Boolean(p.coverRights);
  if('metadataReview' in p)r.metadataReview=Boolean(p.metadataReview);
  if('metadataOrigin' in p)r.metadataOrigin=p.metadataOrigin==='epub'?'epub':'';
  return r;
}
function getOrigin(request){try{return new URL(request.url).origin;}catch{return '';}}
function sameOrigin(request){const origin=request.headers.get('origin');return !origin || origin===getOrigin(request);}
async function getJson(request){
  if(!(request.headers.get('content-type')||'').includes('application/json'))throw Error('Expected JSON');
  const raw=await request.text();if(raw.length>16000)throw Error('Content too long');return JSON.parse(raw);
}
const decodeBase64url = value => {
  if(typeof value!=='string'||!/^[-_A-Za-z0-9]+$/.test(value))throw Error('Bad base64url');
  return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));
};
const decodeJson = x => JSON.parse(new TextDecoder().decode(decodeBase64url(x)));
let keyCache={url:'',until:0,keys:[]};
async function getJwks(certUrl){
  if(keyCache.url===certUrl && Date.now()<keyCache.until && keyCache.keys.length)return keyCache.keys;
  const r=await fetch(certUrl,{headers:{accept:'application/json'}});
  if(!r.ok)throw Error('Unable to retrieve Access verification keys');
  const value=await r.json();if(!Array.isArray(value.keys)||!value.keys.length)throw Error('Missing Access verification keys');
  keyCache={url:certUrl,until:Date.now()+5*60*1000,keys:value.keys};return value.keys;
}
function accessConfig(request,env){
  const raw=String(env.ACCESS_TEAM_DOMAIN||'').trim().replace(/\/$/,'');
  if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(raw))throw Error('ACCESS_TEAM_DOMAIN not configured');
  const host=new URL(request.url).hostname.toLowerCase();
  const productionHost=String(env.SITE_HOST||'novel-conservatory.pages.dev').toLowerCase();
  let aud;
  if(host===productionHost){aud=String(env.ACCESS_PROD_AUD||'').trim();}
  else if(host.endsWith('.'+productionHost)){aud=String(env.ACCESS_PREVIEW_AUD||'').trim();}
  else {throw Error('Unrecognized website hostname');}
  if(!aud)throw Error('Access audience not configured for this hostname');
  return {team:raw,aud};
}
async function verifyAccess(request,env){
  const {team,aud}=accessConfig(request,env);
  const jwt=request.headers.get('cf-access-jwt-assertion');
  if(!jwt||jwt.length>12000)throw Error('Cloudflare Access login required');
  const pieces=jwt.split('.');if(pieces.length!==3)throw Error('Invalid Access token');
  const hdr=decodeJson(pieces[0]);const p=decodeJson(pieces[1]);
  if(hdr.alg!=='RS256'||typeof hdr.kid!=='string')throw Error('Unexpected token signature algorithm');
  const keys=await getJwks(team+'/cdn-cgi/access/certs');
  const jwk=keys.find(x=>x.kid===hdr.kid&&x.kty==='RSA');if(!jwk)throw Error('Unknown Access signing key');
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const signed=new TextEncoder().encode(pieces[0]+'.'+pieces[1]);
  const good=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decodeBase64url(pieces[2]),signed);
  if(!good)throw Error('Invalid Access signature');
  const now=Math.floor(Date.now()/1000);
  if(p.iss!==team || !(typeof p.aud==='string'?p.aud===aud:Array.isArray(p.aud)&&p.aud.includes(aud)))throw Error('Invalid Access issuer or audience');
  if(!Number.isFinite(p.exp)||p.exp<=now||p.exp>now+86400*90)throw Error('Expired or invalid Access token');
  if(p.nbf!==undefined && (!Number.isFinite(p.nbf)||p.nbf>now+60))throw Error('Token not active');
  if(p.iat!==undefined && (!Number.isFinite(p.iat)||p.iat>now+60))throw Error('Invalid token issue time');
  const email=emailNorm(p.email);
  if(!emailValid(email))throw Error('Access token has no verified email');
  return email;
}
async function roleFor(email,env){
  if(email===emailNorm(env.OWNER_EMAIL)&&emailValid(email))return 'owner';
  if(!env.DB)return 'reader';
  const row=await env.DB.prepare('SELECT role FROM editor_roles WHERE email=?').bind(email).first();
  return row?.role==='editor'?'editor':'reader';
}
const isEditor = role => role==='owner'||role==='editor';
// Cloudflare Access is the sole reader-membership authority.
// This helper is called only AFTER verifyAccess has validated the signed JWT,
// issuer, audience, expiry and email for this private application.
// Editorial roles and EPUB reading entitlements remain separate in private D1.
async function isSiteMember(email,role,env){return emailValid(email);}

// Approval to read is independent of editing permission. The entire stored
// EPUB library remains private until the owner explicitly enables sharing.
async function epubSharingEnabled(env){
  if(!env.DB)return false;
  const row=await env.DB.prepare("SELECT value FROM site_settings WHERE key='epub-sharing-enabled'").first();
  return row?.value==='true';
}
async function canReadEpubs(email,role,env){
  if(role==='owner')return true;
  if(!env.DB||!await epubSharingEnabled(env))return false;
  const key='epub-reader:'+emailNorm(email);
  const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(key).first();
  return row?.value==='true';
}
async function audit(env,email,action,target,details=''){
  // Audit failures must stop a write transaction rather than silently disappear.
  await env.DB.prepare('INSERT INTO audit_log(actor_email,action,target,details) VALUES (?,?,?,?)')
    .bind(email,action,String(target),String(details).slice(0,700)).run();
}
async function routes(request,env,ctx,email,role){
  const url=new URL(request.url),path=url.pathname;
  const method=request.method.toUpperCase();
  // Retire the old page that auto-published cover replacements. Bookmarks and
  // existing admin links now lead to owner-controlled, private-first artwork.
  if(path==='/admin/epub-artwork.html'&&method==='GET'){
   const target=new URL('/admin/epub-cover-library.html',request.url);
   const id=url.searchParams.get('novel')||url.searchParams.get('id');
   if(id&&editionBook(id))target.searchParams.set('novel',id);
   return Response.redirect(target.toString(),302);
  }
  // Both the owner and explicitly approved friends may read EPUBs after the
  // owner enables sharing. All uploads, edits and bulk inventory remain owner-only.
  if(path==='/api/novel/resolve'&&method==='GET'){
   if(!env.COMMUNITY_DB)return respond({error:'Shared catalogue unavailable'},503);
   const id=await canonicalPrivateResolve(env,url.searchParams.get('id'));
   return id?respond({id,canonicalId:id}):respond({error:'Invalid novel identity'},404);
  }
  // Individual account archive. It only changes the current signed-in user's
  // display preferences, never shared novel metadata, EPUB files or shelves.
  if(path==='/api/me/hidden'&&(method==='GET'||method==='POST')){
   if(!env.DB)return respond({error:'Private account storage unavailable'},503);
   const settingKey='conservatory-hidden-v1:'+email;
   try{
    const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(settingKey).first();
    let current=[];try{
     const parsed=JSON.parse(row?.value||'[]');
     if(Array.isArray(parsed))current=[...new Set(parsed.filter(bookIdValid).map(Number))].slice(0,20000);
    }catch{throw Error('Your personal archive is unreadable. No changes were made.')}
    if(method==='GET')return respond({ids:current,private:true,ownerOnly:true});
    if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
    const body=await getJson(request),id=Number(body.id),action=String(body.action||'');
    if(!bookIdValid(id)||!['hide','restore'].includes(action))return respond({error:'Choose a valid novel and Hide or Restore'},400);
    const next=action==='hide'?[...new Set([...current,id])]:current.filter(x=>x!==id);
    if(next.length>20000)return respond({error:'Personal archive limit reached'},413);
    const value=JSON.stringify(next);
    if(value.length>200000)return respond({error:'Personal archive is too large'},413);
    const written=row?await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?')
      .bind(value,settingKey,row.value).run():
      await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').bind(settingKey,value).run();
    if((written.meta?.changes||0)!==1)return respond({error:'Your archive changed in another tab. Refresh and try again.'},409);
    return respond({ok:true,ids:next,private:true,affectedOtherAccounts:false});
   }catch(err){return respond({error:textField(err?.message||'Could not update your archive',180)},400)}
  }
  if(path.startsWith('/api/epub-submissions/'))return privateEpubSubmissionRoutes(request,env,email,role);
  if(path.startsWith('/api/admin/nu/'))return nuAdminRoutes(request,env,email,role);
  if(path==='/api/admin/epub/ingest-metadata')return privateEpubIngestRoute(request,env,email,role);
  if(path==='/api/admin/epub/undo-metadata'&&method==='POST'){
    if(role!=='owner'||!strictOrigin(request))return respond({error:'Owner-only Undo'},403);
    if(!env.DB)return respond({error:'Private metadata database missing'},503);
    try{
     const body=await getJson(request),eventId=String(body.eventId||'');
     if(!/^[a-f0-9-]{36}$/.test(eventId))return respond({error:'Invalid Undo reference'},400);
     const event=await env.DB.prepare('SELECT * FROM epub_metadata_import_events WHERE id=? AND undone_at IS NULL').bind(eventId).first();
     if(!event)return respond({error:'Import event already undone or not found'},404);
     const current=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(event.setting_key).first();
     if(current?.value!==event.after_value)return respond({error:'Metadata changed after this import. Undo later changes first.'},409);
     const update=event.before_value===null?
      await env.DB.prepare('DELETE FROM site_settings WHERE key=? AND value=?').bind(event.setting_key,event.after_value).run():
      await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?').bind(event.before_value,event.setting_key,event.after_value).run();
     if((update.meta?.changes||0)!==1)return respond({error:'A concurrent edit prevented Undo'},409);
     await env.DB.prepare('UPDATE epub_metadata_import_events SET undone_at=CURRENT_TIMESTAMP WHERE id=? AND undone_at IS NULL').bind(eventId).run();
     return respond({ok:true,undone:true,id:event.novel_id,eventId,privateOnly:true});
    }catch(err){return respond({error:textField(err?.message||'Could not undo this import',160)},400)}
   }

  if(path.startsWith('/api/admin/epub-cover-library/'))return privateEpubCoverLibraryRoute(request,env,email,role);
  if(path==='/api/admin/epub-artwork/private-auto')return privateEpubAutoCoverRoute(request,env,email,role);
  if(path==='/api/admin/epub-insights/private-cover')return privateEpubCoverRoute(request,env,email,role);
  if(path.startsWith('/api/admin/epub-insights/'))return epubInsightsRoutes(request,env,email,role);
  if(path.startsWith('/api/additional/')||path.startsWith('/api/admin/additional/'))return additionalRoutes(request,env,'private',email,role);
  if(path.startsWith('/api/private/edition/'))return editionRoutes(request,env,email,role);
  if(path==='/api/follows'||path.startsWith('/api/notifications'))return followRoutes(request,env,email);
  if(path==='/api/admin/publish-correction')return publishCorrectionRoute(request,env,email,role);
  if(path==='/api/admin/catalogue-editor')return liveCatalogueEditorRoute(request,env,email,role);
  if(path==='/api/admin/cover-sync/preview'||path==='/api/admin/cover-sync/run')return coverSyncRoutes(request,env,email,role);
  if(path==='/api/admin/epub-artwork/propose')return epubArtworkProposal(request,env,email,role);
  if(path==='/api/admin/epub-artwork/auto'&&method==='POST'){const copy=request.clone();const fd=await copy.formData();if(extraId(fd.get('novel_id'))){const target=new URL(request.url);target.pathname='/api/admin/additional/auto-cover';return additionalRoutes(new Request(target,request),env,'private',email,role)};}
  if(path.startsWith('/api/admin/epub-artwork/auto')||path==='/api/admin/epub-artwork/set-cover')return epubArtworkAutoRoutes(request,env,email,role);
  // EPUB presence, not EPUB content. The caller has already passed
  // the private site's Cloudflare Access JWT verification. This permits
  // allowed readers to filter the catalogue, without granting download access.
  if(path==='/api/private/epub/availability'&&method==='GET'){
    if(!env.DB)return respond({error:'EPUB inventory database is unavailable'},503);
    try{
      const entries=await epubVerificationState(env,await epubVerificationInventory(env));
      const totals=new Map(),verifiedTotals=new Map();
      for(const row of entries){
        totals.set(row.novelId,(totals.get(row.novelId)||0)+1);
        if(row.verified)verifiedTotals.set(row.novelId,(verifiedTotals.get(row.novelId)||0)+1);
      }
      const ids=[...totals.keys()].sort((a,b)=>a-b);
      const verifiedIds=ids.filter(id=>totals.get(id)===verifiedTotals.get(id));
      return respond({ids,verifiedIds,uploadCount:entries.length,verifiedCount:entries.filter(x=>x.verified).length,complete:true});
    }catch{return respond({error:'EPUB inventory could not be loaded'},503)}
  }

  if(path.startsWith('/api/private/epub/')){
    if(!env.DB)return respond({error:'D1 database not configured.'},503);
    const readable=(path==='/api/private/epub/status'||path==='/api/private/epub/file')&&method==='GET';
    // Any Cloudflare Access-authenticated private member may contribute a shared
    // quality check. This ONLY permits the exact review endpoint, not EPUB
    // uploads, downloads, edits, deletions or bulk administration.
    const memberReview=path==='/api/private/epub/review'&&(method==='GET'||method==='POST');
    if(readable){
      if(!await canReadEpubs(email,role,env))return respond({error:'EPUB reading is not enabled for this account.'},403);
    }else if(!memberReview&&role!=='owner')return respond({error:'Only the owner can manage stored EPUBs.'},403);
    if(path==='/api/private/epub/bulk-status'&&method==='GET'){
      const rows=await env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'private-epub:%'").all();
      const files={};
      for(const item of rows.results||[]){
        const match=/^private-epub:([1-9][0-9]*)$/.exec(item.key);
        if(!match||Number(match[1])>962)continue;
        try{const info=JSON.parse(item.value);files[match[1]]={name:info.name||'book.epub',size:info.size||0,updatedAt:info.updatedAt||''};}catch{}
      }
      return respond({ok:true,files});
    }
    if(memberReview){
      if(method==='POST'&&!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
      try{
        const entries=await epubVerificationState(env,await epubVerificationInventory(env));
        if(method==='GET'){
          const items=entries.map(({kind,novelId,editionId,filename,verified})=>({kind,novelId,editionId,filename,verified}));
          return respond({items,total:items.length,verifiedCount:items.filter(x=>x.verified).length});
        }
        const body=await getJson(request);
        if(typeof body?.verified!=='boolean')return respond({error:'Choose verified or not verified'},400);
        const novelId=Number(body.novelId),kind=body.kind;
        if(!Number.isSafeInteger(novelId)||novelId<1||!['edition','legacy'].includes(kind))return respond({error:'Invalid EPUB selection'},400);
        const target=entries.find(x=>x.kind===kind&&x.novelId===novelId&&(kind==='legacy'||x.editionId===body.editionId));
        if(!target)return respond({error:'EPUB edition not found'},404);
        await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP')
         .bind('epub-verification:'+target.fileKey,JSON.stringify({verified:body.verified,reviewedBy:email,reviewedAt:new Date().toISOString()})).run();
        await audit(env,email,'private.epub.member_review',novelId,kind+':'+(target.editionId||'legacy')+'='+body.verified);
        return respond({ok:true,novelId,editionId:target.editionId,verified:body.verified});
      }catch{return respond({error:'Could not update EPUB verification'},503)}
    }
    const id=Number(url.searchParams.get('id'));
    if(!Number.isInteger(id)||id<1||id>962)return respond({error:'Select an existing novel.'},400);
    const settingKey='private-epub:'+id;
    if(path==='/api/private/epub/status'&&method==='GET'){
      const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(settingKey).first();
      if(!row){
        const first=await env.DB.prepare('SELECT id,label,filename,bytes,created_at FROM epub_editions WHERE novel_id=? ORDER BY created_at,id LIMIT 1').bind(id).first();
        if(!first)return respond({hasEpub:false,id});
        return respond({hasEpub:true,id,name:first.filename,size:first.bytes,updatedAt:first.created_at,newEditions:true,editionId:first.id});
      }
      const meta=JSON.parse(row.value);
      return respond({hasEpub:true,id,name:meta.name,size:meta.size,updatedAt:meta.updatedAt});
    }
    if(path==='/api/private/epub/file'&&method==='GET'){
      if(url.searchParams.has('download')&&role!=='owner')return respond({error:'Only the owner can use the direct download action.'},403);
      const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(settingKey).first();
      if(!row)return respond({error:'No EPUB uploaded for this novel.'},404);
      if(!env.IMAGES)return respond({error:'Private R2 storage unavailable.'},503);
      const info=JSON.parse(row.value);
      if(!/^private-epubs\/[a-f0-9-]{36}\.epub$/.test(info.key))return respond({error:'Invalid stored file reference.'},500);
      const obj=await env.IMAGES.get(info.key);
      if(!obj)return respond({error:'EPUB file missing from storage.'},404);
      return new Response(obj.body,{headers:{'content-type':'application/epub+zip','cache-control':'private,no-store','x-robots-tag':'noindex,nofollow','x-content-type-options':'nosniff','content-disposition':url.searchParams.has('download')?'attachment; filename="private-book.epub"':'inline'}});
    }
    if(!sameOrigin(request))return respond({error:'Cross-origin write rejected.'},403);
    if(path==='/api/private/epub/upload'&&method==='POST'){
      await ensureEpubVerificationBaseline(env);
      if(!env.IMAGES)return respond({error:'R2 bucket not configured (IMAGES).'},503);
      const ctype=(request.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      if(!['application/epub+zip','application/octet-stream','application/zip'].includes(ctype))return respond({error:'Choose an EPUB file.'},415);
      if(Number(request.headers.get('content-length')||0)>30000000)return respond({error:'EPUB exceeds the 30 MB per-file limit.'},413);
      const bytes=await request.arrayBuffer();const head=new Uint8Array(bytes.slice(0,4));
      if(bytes.byteLength<100||bytes.byteLength>30000000||head[0]!==80||head[1]!==75)return respond({error:'Invalid EPUB file or file too large.'},415);
      let name='book.epub';try{name=decodeURIComponent(request.headers.get('x-epub-name')||'book.epub').replace(/[\/\\\x00-\x1f]/g,'_').slice(0,160)}catch{}
      if(!/\.epub$/i.test(name))name+='.epub';
      const oldRow=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(settingKey).first();
      const old=oldRow?JSON.parse(oldRow.value):null;
      const key='private-epubs/'+crypto.randomUUID()+'.epub';
      await env.IMAGES.put(key,bytes,{httpMetadata:{contentType:'application/epub+zip'}});
      const info={key,name,size:bytes.byteLength,updatedAt:new Date().toISOString()};
      try{await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP').bind(settingKey,JSON.stringify(info)).run();}
      catch(e){await env.IMAGES.delete(key);throw e;}
      await audit(env,email,'private.epub.upload',id,name);
      if(old?.key&&/^private-epubs\/[a-f0-9-]{36}\.epub$/.test(old.key))await env.IMAGES.delete(old.key);
      return respond({ok:true,id,hasEpub:true,name,size:bytes.byteLength});
    }
    if(path==='/api/private/epub/metadata'&&method==='POST'){
      // Owner-only operation. A separate private EPUB must already exist for this novel.
      const linked=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(settingKey).first();
      if(!linked)return respond({error:'Upload the private EPUB before importing its metadata.'},409);
      const body=await getJson(request);
      const description=textField(body.description,2000);
      const subjects=textArray(body.subjects);
      const baseSynopsis=textField(body.baseSynopsis,2000);
      const baseTags=textArray(body.baseTags);
      const priorRow=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(id).first();
      const prior=priorRow?JSON.parse(priorRow.patch):{};
      const oldSynopsis=typeof prior.synopsis==='string'?prior.synopsis:baseSynopsis;
      const oldTags=Array.isArray(prior.tags)?textArray(prior.tags):baseTags;
      const tags=oldTags.slice(),seen=new Set(tags.map(t=>t.normalize('NFKC').trim().toLowerCase()));
      const added=[];
      for(const tag of subjects){
        const normalized=tag.normalize('NFKC').trim().toLowerCase();
        if(!normalized||seen.has(normalized))continue;
        if(tags.length>=24)break;
        tags.push(tag);added.push(tag);seen.add(normalized);
      }
      const synopsisAdded=!oldSynopsis.trim()&&!!description;
      if(!synopsisAdded&&!added.length)return respond({ok:true,id,changed:false,summaryAdded:false,tagsAdded:[],patch:prior});
      const next={...prior,synopsis:synopsisAdded?description:oldSynopsis,tags,metadataReview:false,metadataOrigin:'epub'};
      await env.DB.prepare('INSERT INTO novel_edits(id,patch) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET patch=excluded.patch,updated_at=CURRENT_TIMESTAMP')
        .bind(id,JSON.stringify(next)).run();
      await audit(env,email,'private.epub.metadata',id,`summary:${Number(synopsisAdded)}; tags:${added.length}`);
      return respond({ok:true,id,changed:true,summaryAdded:synopsisAdded,tagsAdded:added,patch:next});
    }
    if(path==='/api/private/epub/remove'&&method==='POST'){
      const oldRow=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(settingKey).first();
      await env.DB.prepare('DELETE FROM site_settings WHERE key=?').bind(settingKey).run();
      await audit(env,email,'private.epub.remove',id);
      if(oldRow){const info=JSON.parse(oldRow.value);if(info.key&&/^private-epubs\/[a-f0-9-]{36}\.epub$/.test(info.key)&&env.IMAGES)await env.IMAGES.delete(info.key);}
      return respond({ok:true,id,hasEpub:false});
    }
    return respond({error:'Not found'},404);
  }
  if(path==='/api/site/config')return siteConfigRoute(request,env,'private');
  if(path==='/api/site/feedback')return siteFeedbackRoute(request,env,'private',email);
  if(['/api/admin/site-config','/api/admin/site-feedback','/api/admin/public-banner','/api/admin/public-banner-preview','/api/admin/public-banner-copy','/api/admin/site-copy-from-private'].includes(path))return siteAdminRoute(request,env,email,role);
  if(path.startsWith('/api/community/'))return communityDispatch(request,env,'private',{email,role});
  if(path==='/api/catalogue'&&method==='GET'){
   const response=await env.ASSETS.fetch(new Request(new URL('/admin/catalogue.json',url.origin)));
   if(!response.ok)return respond({error:'Catalogue unavailable'},503);
   const original=await response.json(),base=Array.isArray(original)?original:(original.books||[]);
   if(env.COMMUNITY_DB){try{const additions=await env.COMMUNITY_DB.prepare("SELECT * FROM additional_catalogue_novels WHERE source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%' ORDER BY created_at DESC LIMIT 5000").all();base.push(...await canonicalPrivateDecorate(env,additions.results||[]));}catch{}}
   return respond(base);
  }
  if(path.startsWith('/api/shelves'))return shelfRoutes(request,env,email);
  if(path==='/api/link-reports'||path==='/api/admin/link-reports')return linkReportRoutes(request,env,email,role);
  if(path==='/api/admin/metadata-backup'&&method==='GET')return backupRoutes(request,env,email,role);
  if(path==='/api/me'&&method==='GET')return respond({email,role,configured:!!env.DB,uploadsConfigured:!!env.IMAGES,canReadEpubs:await canReadEpubs(email,role,env)});
  if(path==='/api/content'&&method==='GET'){
    if(!env.DB)return respond({edits:[],homepage:{},configured:false});
    try{
      const [novels,setting]=await Promise.all([
        env.DB.prepare('SELECT id,patch FROM novel_edits').all(),
        env.DB.prepare("SELECT value FROM site_settings WHERE key='homepage'").first()
      ]);
      let additional=[];if(env.COMMUNITY_DB){try{const r=await env.COMMUNITY_DB.prepare("SELECT * FROM additional_catalogue_novels WHERE source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%' ORDER BY created_at DESC LIMIT 5000").all();additional=await canonicalPrivateDecorate(env,r.results||[]);}catch{}}
      // Private-only, explicitly approved embedded EPUB covers. The public
      // project has no route to this private R2 bucket or site_settings table.
      const edits=(novels.results||[]).map(x=>({id:x.id,patch:JSON.parse(x.patch)}));
      // Community contributions to original books are shared with the private
      // browser too. Keep private editorial overrides as the final authority.
      if(env.COMMUNITY_DB){
       try{
        const shared=await env.COMMUNITY_DB.prepare('SELECT novel_id,patch_json FROM published_catalogue_overrides WHERE novel_id BETWEEN 1 AND 962 LIMIT 1000').all();
        const byId=new Map(edits.map(x=>[Number(x.id),x]));
        const fields=new Set(['title','originalTitle','author','translator','synopsis','genres','tags','contentWarnings','cover','coverRights','coverCredit','metadataReview','metadataSource','translation','nuUrl','translatorUrl']);
        for(const record of shared.results||[]){
         let pub={};try{pub=JSON.parse(record.patch_json||'{}')}catch{continue}
         const id=Number(record.novel_id);
         let saved=byId.get(id);
         if(!saved){saved={id,patch:{}};edits.push(saved);byId.set(id,saved)}
         const incoming={};
         for(const [key,val] of Object.entries(pub))if(fields.has(key))incoming[key]=val;
         saved.patch={...incoming,...saved.patch};
        }
       }catch(e){console.warn('Could not sync public community edits into private view',e)}
      }
      if(await canReadEpubs(email,role,env)){
       const covers=await env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'private-epub-cover:%' LIMIT 5000").all();
       const byId=new Map(edits.map(x=>[Number(x.id),x]));
       const extras=new Map(additional.map(x=>[Number(x.id),x]));
       for(const entry of covers.results||[]){
        const match=/^private-epub-cover:([1-9][0-9]*)$/.exec(entry.key);
        if(!match)continue;
        const id=Number(match[1]);let value;
        try{value=JSON.parse(entry.value)}catch{continue}
        const cover=String(value?.cover||'');
        if(!/^\/media\/[a-f0-9-]{36}\.jpg$/.test(cover))continue;
        if(id<=962){
         let edit=byId.get(id);if(!edit){edit={id,patch:{}};edits.push(edit);byId.set(id,edit)}
         if(!edit.patch.cover||value.selectedByOwner===true)edit.patch={...edit.patch,cover,privateCover:true,
          ...(value.selectedByOwner===true?{coverRights:false}:{}),
          coverCredit:value.selectedByOwner===true?'Owner-selected private EPUB cover · not publicly published':'Private EPUB cover · not publicly published'};
        }else{
         const extra=extras.get(id);
         if(extra&&(!extra.cover||value.selectedByOwner===true)){extra.cover=cover;extra.privateCover=true;
          if(value.selectedByOwner===true)extra.coverRights=false;
          extra.coverCredit=value.selectedByOwner===true?'Owner-selected private EPUB cover · not publicly published':'Private EPUB cover · not publicly published'}
        }
       }
      }
      // Private-only EPUB imports are blended into the member's catalogue
      // after the shared public corrections. Original/manual fields take
      // precedence; unreviewed EPUB subjects fill gaps or add unique tags.
      if(await canReadEpubs(email,role,env)){
       const metaRows=await env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'private-epub-metadata:%' LIMIT 5000").all();
       const byId=new Map(edits.map(x=>[Number(x.id),x]));
       const extras=new Map(additional.map(x=>[Number(x.id),x]));
       for(const row of metaRows.results||[]){
        const match=/^private-epub-metadata:([1-9][0-9]*)$/.exec(row.key);
        if(!match)continue;
        const id=Number(match[1]);let imported;
        try{imported=JSON.parse(row.value)}catch{continue}
        if(id<=962){
         let entry=byId.get(id);if(!entry){entry={id,patch:{}};edits.push(entry);byId.set(id,entry)}
         const patch=entry.patch;
         if(!patch.synopsis&&imported.synopsis)patch.synopsis=imported.synopsis;
         if(!patch.author&&imported.author)patch.author=imported.author;
         // Add explicit source labels to reviewed books without removing
         // manually curated tags, genres, summaries or warnings.
         if(imported.tags?.length){
          patch.tags=mergeEpubTags(patch.tags,imported.tags);
          patch.tagsCombinedFromEpub=true;
         }
         if(imported.genres?.length){
          patch.genres=mergeEpubTags(patch.genres,imported.genres);
          patch.genresCombinedFromEpub=true;
         }
         if(!patch.metadataReview&&(imported.tags?.length||imported.genres?.length||imported.synopsis)){
          patch.metadataOrigin='epub';patch.metadataSource=imported.metadataSource;
         }
        }else{
         const item=extras.get(id);if(!item)continue;
         if(!item.synopsis&&imported.synopsis)item.synopsis=imported.synopsis;
         if(!item.author&&imported.author)item.author=imported.author;
         if(imported.tags?.length)item.tags=mergeEpubTags(item.tags,imported.tags);
         if(imported.genres?.length)item.genres=mergeEpubTags(item.genres,imported.genres);
         if(!item.metadataReview&&(imported.tags?.length||imported.genres?.length||imported.synopsis)){
          item.metadataOrigin='epub';item.metadataSource=imported.metadataSource;
         }
        }
       }
      }
      // Private NU imports are never copied into public catalogue metadata.
      // Combine separately sourced tags and genres without replacing edits.
      const nuRows=await env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'private-nu-page:%' LIMIT 5000").all();
      const editMap=new Map(edits.map(x=>[Number(x.id),x]));
      const extraMap=new Map(additional.map(x=>[Number(x.id),x]));
      for(const row of nuRows.results||[]){
       const match=/^private-nu-page:([1-9][0-9]*)$/.exec(row.key);
       if(!match)continue;
       const id=Number(match[1]);let imported;
       try{imported=JSON.parse(row.value)}catch{continue}
       const target=id<=962?(editMap.get(id)||{id,patch:{}}):extraMap.get(id);
       if(!target)continue;
       if(id<=962&&!editMap.has(id)){edits.push(target);editMap.set(id,target)}
       const fields=id<=962?target.patch:target;
       if(!fields.nuUrl&&imported.nuUrl)fields.nuUrl=imported.nuUrl;
       for(const key of ['synopsis','author','originalTitle']){
        if(!fields[key]&&imported[key])fields[key]=imported[key];
       }
       if(imported.tags?.length){
        fields.tags=mergeEpubTags(fields.tags,imported.tags);
        if(id<=962)fields.tagsCombinedFromNu=true;
       }
       if(imported.genres?.length){
        fields.genres=mergeEpubTags(fields.genres,imported.genres);
        if(id<=962)fields.genresCombinedFromNu=true;
       }
       if(!fields.cover&&imported.cover&&privateNuImageUrl(imported.cover)){
        fields.cover=imported.cover;fields.privateCover=true;
        fields.coverCredit=imported.coverCredit||'Novel Updates source cover, private reference';
       }
       if(imported.nuCoverUrl)fields.nuCoverUrl=imported.nuCoverUrl;
       // Source progress is displayed separately, never promoted to curated status.
       for(const key of ['nuTranslationSourceStatus','nuOriginalSourceStatus','nuChapterSourceText']){
        if(!fields[key]&&imported[key])fields[key]=imported[key];
       }
       if(!fields.metadataReview&&imported.metadataOrigin==='nu'){
        fields.metadataOrigin='nu';
        fields.metadataSource=imported.metadataSource||'Novel Updates (private)';
       }
      }
      return respond({edits,additional,homepage:setting?JSON.parse(setting.value):{},configured:true});
    }catch{return respond({error:'Database unavailable'},503);}
  }
  if(path.startsWith('/media/')&&method==='GET'){
    if(!env.IMAGES)return new Response('Image storage is not configured',{status:404});
    const key=path.slice('/media/'.length);
    if(!/^[a-f0-9-]{36}\.(png|jpe?g|webp|gif)$/.test(key))return new Response('Not found',{status:404});
    const image=await env.IMAGES.get(key);if(!image)return new Response('Not found',{status:404});
    return new Response(image.body,{headers:{'content-type':image.httpMetadata?.contentType||'image/jpeg','cache-control':'private,max-age=3600','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"}});
  }
  if(path.startsWith('/admin/')||path==='/admin'){
    if(!isEditor(role))return respond({error:'Only authorized editors can use the dashboard'},403);
    if(path==='/admin')return Response.redirect(url.origin+'/admin/',302);
    const res=await env.ASSETS.fetch(request);
    const head=new Headers(res.headers);head.set('cache-control','private,no-store');head.set('x-robots-tag','noindex,nofollow');
    return new Response(res.body,{status:res.status,statusText:res.statusText,headers:head});
  }
  if(path.startsWith('/api/admin/')){
    if(!isEditor(role))return respond({error:'Editor access required'},403);
    if(!env.DB)return respond({error:'D1 DB is not configured'},503);
    if(path==='/api/admin/editors'&&method==='GET'){
      if(role!=='owner')return respond({error:'Owner access required'},403);
      const rows=await env.DB.prepare('SELECT email,added_at,added_by FROM editor_roles ORDER BY email').all();
      return respond({editors:rows.results||[],owner:emailNorm(env.OWNER_EMAIL)});
    }
    if(path==='/api/admin/epub-readers'&&method==='GET'){
      if(role!=='owner')return respond({error:'Owner access required'},403);
      const rows=await env.DB.prepare("SELECT key FROM site_settings WHERE key LIKE 'epub-reader:%' AND value='true' ORDER BY key").all();
      const readers=(rows.results||[]).map(r=>r.key.slice('epub-reader:'.length)).filter(emailValid);
      return respond({readers,sharingEnabled:await epubSharingEnabled(env)});
    }
    if(path==='/api/admin/history'&&method==='GET'){
      const rows=await env.DB.prepare('SELECT actor_email,action,target,details,created_at FROM audit_log ORDER BY id DESC LIMIT 40').all();
      return respond({history:rows.results||[]});
    }
    if(method!=='POST')return respond({error:'Method not allowed'},405);
    if(!sameOrigin(request))return respond({error:'Wrong origin'},403);
    try{
      if(path==='/api/admin/editors'){
        if(role!=='owner')return respond({error:'Owner access required'},403);
        const body=await getJson(request);const target=emailNorm(body.email);
        if(!emailValid(target))return respond({error:'Enter a valid email address'},400);
        if(target===emailNorm(env.OWNER_EMAIL))return respond({error:'The owner is configured separately'},400);
        if(body.action==='add'){
          await env.DB.prepare("INSERT INTO editor_roles(email,role,added_by) VALUES (?,'editor',?) ON CONFLICT(email) DO UPDATE SET role='editor',added_by=excluded.added_by")
            .bind(target,email).run();
          await audit(env,email,'editor.add',target);
        } else if(body.action==='remove') {
          await env.DB.prepare('DELETE FROM editor_roles WHERE email=?').bind(target).run();
          await audit(env,email,'editor.remove',target);
        } else return respond({error:'Unknown editor action'},400);
        return respond({ok:true,email:target,action:body.action});
      }
      if(path==='/api/admin/epub-readers'){
        if(role!=='owner')return respond({error:'Owner access required'},403);
        const body=await getJson(request);
        if(body.action==='sharing'){
          if(typeof body.enabled!=='boolean')return respond({error:'Invalid sharing setting'},400);
          if(body.enabled && body.rightsConfirmed!==true)return respond({error:'Confirm you have permission to share the EPUBs before enabling.'},400);
          await env.DB.prepare("INSERT INTO site_settings(key,value) VALUES ('epub-sharing-enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
            .bind(body.enabled?'true':'false').run();
          await audit(env,email,'epub.sharing.set','library',body.enabled?'enabled':'disabled');
          return respond({ok:true,sharingEnabled:body.enabled});
        }
        const target=emailNorm(body.email);
        if(!emailValid(target))return respond({error:'Enter a valid email address'},400);
        if(target===emailNorm(env.OWNER_EMAIL))return respond({error:'The owner always has access'},400);
        const key='epub-reader:'+target;
        if(body.action==='add'){
          await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP').bind(key,'true').run();
          await audit(env,email,'epub.reader.add',target);
        }else if(body.action==='remove'){
          await env.DB.prepare('DELETE FROM site_settings WHERE key=?').bind(key).run();
          await audit(env,email,'epub.reader.remove',target);
        }else return respond({error:'Unknown reader action'},400);
        return respond({ok:true,email:target,action:body.action});
      }
      if(path==='/api/admin/novel'){
        const body=await getJson(request),id=Number(body.id);
        if(!Number.isSafeInteger(id)||id<1||id>100000)return respond({error:'Invalid novel ID'},400);
        const patch=cleanPatch(body.patch);
        if(!Object.keys(patch).length)return respond({error:'No fields to save'},400);
        const prior=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(id).first();
        const combined={...(prior?JSON.parse(prior.patch):{}),...patch};
        await env.DB.prepare('INSERT INTO novel_edits(id,patch) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET patch=excluded.patch,updated_at=CURRENT_TIMESTAMP')
          .bind(id,JSON.stringify(combined)).run();
        await audit(env,email,'novel.update',id,Object.keys(patch).join(','));
        try {if(editionBook(id))await followersNotice(env,id,(combined.translations||[])[0]?.name||combined.translator||'',`Novel #${id} received an editorial update.`,'novel');}catch{}
        return respond({ok:true,id,patch:combined});
      }
      if(path==='/api/admin/homepage'){
        const body=await getJson(request);
        const heroImage=textField(body.heroImage,600);
        const home={heroTitle:textField(body.heroTitle,130),heroDescription:textField(body.heroDescription,500),featuredTitle:textField(body.featuredTitle,100),announcement:textField(body.announcement,300),heroImage:(heroImage.startsWith('/media/')||heroImage.startsWith('https://')||heroImage.startsWith('http://'))?heroImage:'',featuredIds:(Array.isArray(body.featuredIds)?body.featuredIds:[]).map(Number).filter(x=>Number.isSafeInteger(x)&&x>0).slice(0,12)};
        await env.DB.prepare("INSERT INTO site_settings(key,value) VALUES ('homepage',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP")
          .bind(JSON.stringify(home)).run();
        await audit(env,email,'homepage.update','homepage',Object.keys(home).join(','));
        return respond({ok:true,homepage:home});
      }
      if(path==='/api/admin/upload'){
        if(!env.IMAGES)return respond({error:'Create an R2 bucket and bind it as IMAGES'},503);
        const type=(request.headers.get('content-type')||'').split(';')[0].trim();
        const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[type];
        if(!ext)return respond({error:'Use JPG, PNG, GIF, or WebP'},415);
        const length=Number(request.headers.get('content-length')||0);
        if(length>6000000)return respond({error:'Maximum 6 MB per image'},413);
        const bytes=await request.arrayBuffer();
        if(bytes.byteLength>6000000||bytes.byteLength<100)return respond({error:'Invalid image size'},413);
        const b=new Uint8Array(bytes);
        const magic=ext==='jpg'?(b[0]===255&&b[1]===216):ext==='png'?(b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71):ext==='webp'?(String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP'):String.fromCharCode(...b.slice(0,3))==='GIF';
        if(!magic)return respond({error:'Invalid image data'},415);
        const key=crypto.randomUUID()+'.'+ext;
        await env.IMAGES.put(key,bytes,{httpMetadata:{contentType:type}});
        await audit(env,email,'cover.upload',key);
        return respond({ok:true,url:'/media/'+key});
      }
      return respond({error:'Not found'},404);
    }catch(error){return respond({error:String(error.message||'Invalid request').slice(0,150)},400);}
  }
  return respond({error:'Not found'},404);
}
// V3: private EPUB editions, multipart imports, follows, in-app notifications,
// editor-approved one-click publication. This code runs ONLY after the existing
// Cloudflare Access JWT and private membership gates.
const EDITION_PART_BYTES=8*1024*1024;
const EDITION_MAX_BYTES=2*1024*1024*1024;
const editionText=(v,n=160)=>String(v??'').trim().slice(0,n);
const editionBook=v=>Number.isSafeInteger(Number(v))&&Number(v)>=1?Number(v):null;
const editionTable=id=>id>962?'additional_epub_editions':'epub_editions';
const sessionTable=id=>id>962?'additional_epub_upload_sessions':'epub_upload_sessions';
const editionUuid=v=>/^[0-9a-f-]{36}$/.test(String(v||''))?String(v):'';
const strictOrigin=r=>r.headers.get('Origin')===new URL(r.url).origin;
const editionHeaders={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const editionJson=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:editionHeaders});
const translationRef=v=>String(v||'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ').slice(0,120);
const safeEdition=e=>({id:e.id,novelId:e.novel_id,label:e.label,translator:e.translator,language:e.language,filename:e.filename,size:e.bytes,createdAt:e.created_at,legacy:false});
async function getEditions(env,id){
 const r=await env.DB.prepare('SELECT id,novel_id,label,translator,language,filename,bytes,created_at FROM '+editionTable(id)+' WHERE novel_id=? ORDER BY created_at ASC,id ASC').bind(id).all();
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

/* Owner-confirmed legacy EPUBs are frozen as verified at first inventory use.
   Each new uploaded object key starts unverified. Per-file owner overrides win. */
const EPUB_VERIFY_BASELINE='epub-verification-baseline-v1';
const epubVerifyFileKey=k=>/^(?:private-epubs|private-epub-editions)\/[0-9a-f-]{36}\.epub$/.test(String(k||''));
async function epubVerificationInventory(env){
 const [main,extra,legacy]=await Promise.all([
  env.DB.prepare('SELECT id,novel_id,object_key,filename FROM epub_editions').all(),
  env.DB.prepare('SELECT id,novel_id,object_key,filename FROM additional_epub_editions').all(),
  env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'private-epub:%'").all()
 ]);
 const entries=[];
 for(const row of [...(main.results||[]),...(extra.results||[])]){
  if(!epubVerifyFileKey(row.object_key))continue;
  const novelId=Number(row.novel_id);
  if(!Number.isSafeInteger(novelId)||novelId<1)continue;
  entries.push({kind:'edition',novelId,editionId:String(row.id),fileKey:row.object_key,filename:String(row.filename||'EPUB').slice(0,160)});
 }
 for(const row of legacy.results||[]){
  const match=/^private-epub:([1-9][0-9]*)$/.exec(row.key||'');
  if(!match||Number(match[1])>962)continue;
  try{
   const meta=JSON.parse(row.value||'{}');
   if(epubVerifyFileKey(meta.key)&&meta.key.startsWith('private-epubs/'))
    entries.push({kind:'legacy',novelId:Number(match[1]),editionId:null,fileKey:meta.key,filename:String(meta.name||'EPUB').slice(0,160)});
  }catch{}
 }
 return entries;
}
async function epubVerificationState(env,entries){
 let base=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(EPUB_VERIFY_BASELINE).first();
 if(!base){
  const data=JSON.stringify({createdAt:new Date().toISOString(),keys:entries.map(x=>x.fileKey)});
  await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').bind(EPUB_VERIFY_BASELINE,data).run();
  base=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(EPUB_VERIFY_BASELINE).first();
 }
 if(!base)throw Error('EPUB verification baseline unavailable');
 let parsed;try{parsed=JSON.parse(base.value)}catch{throw Error('EPUB verification baseline is invalid')}
 if(!Array.isArray(parsed.keys))throw Error('EPUB verification baseline is incomplete');
 const existing=new Set(parsed.keys.filter(epubVerifyFileKey));
 const reviewRows=await env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'epub-verification:%'").all();
 const review=new Map();
 for(const row of reviewRows.results||[]){
  const key=String(row.key||'').slice('epub-verification:'.length);
  if(!epubVerifyFileKey(key))continue;
  try{const value=JSON.parse(row.value);if(typeof value.verified==='boolean')review.set(key,value.verified)}catch{}
 }
 return entries.map(item=>({...item,verified:review.has(item.fileKey)?review.get(item.fileKey):existing.has(item.fileKey)}));
}
async function ensureEpubVerificationBaseline(env){
 const base=await env.DB.prepare('SELECT key FROM site_settings WHERE key=?').bind(EPUB_VERIFY_BASELINE).first();
 if(base)return;
 const entries=await epubVerificationInventory(env);
 await epubVerificationState(env,entries);
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
   const row=await env.DB.prepare('SELECT object_key FROM '+editionTable(id)+' WHERE novel_id=? AND id=?').bind(id,edition).first();
   if(!row||!/^private-epub-editions\/[0-9a-f-]{36}\.epub$/.test(row.object_key))return editionJson({error:'Edition not found'},404);
   if(!env.IMAGES)return editionJson({error:'Private R2 storage missing'},503);
   const object=await env.IMAGES.get(row.object_key);if(!object)return editionJson({error:'EPUB missing from storage'},404);
   return new Response(object.body,{headers:{'content-type':'application/epub+zip','cache-control':'private,no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex,nofollow','content-disposition':u.searchParams.has('download')?'attachment; filename="private-edition.epub"':'inline'}});
 }
 if(!isOwner)return editionJson({error:'Owner permission required'},403);
 if(method==='GET'&&path==='/api/private/edition/inventory'){
   const novels=await env.DB.prepare('SELECT novel_id AS id,COUNT(*) AS count FROM epub_editions GROUP BY novel_id').all();
   const extraNovels=await env.DB.prepare('SELECT novel_id AS id,COUNT(*) AS count FROM additional_epub_editions GROUP BY novel_id').all();
   const editions=await env.DB.prepare('SELECT novel_id AS id,id AS editionId,filename,bytes,label,translator FROM epub_editions ORDER BY novel_id,created_at').all();
   const extraEditions=await env.DB.prepare('SELECT novel_id AS id,id AS editionId,filename,bytes,label,translator FROM additional_epub_editions ORDER BY novel_id,created_at').all();
   return editionJson({novels:[...(novels.results||[]),...(extraNovels.results||[])],editions:[...(editions.results||[]),...(extraEditions.results||[])]});
 }
 if(method==='GET'&&path==='/api/private/edition/resume'){
   const session=editionUuid(u.searchParams.get('session'));
   const row=await env.DB.prepare('SELECT id,novel_id,bytes,filename,created_at FROM epub_upload_sessions WHERE id=? AND owner_email=?').bind(session,email).first() || await env.DB.prepare('SELECT id,novel_id,bytes,filename,created_at FROM additional_epub_upload_sessions WHERE id=? AND owner_email=?').bind(session,email).first();
   if(!row)return editionJson({error:'Upload session expired or unavailable'},404);
   const parts=await env.DB.prepare('SELECT part_number FROM epub_upload_parts WHERE session_id=? ORDER BY part_number').bind(session).all();
   return editionJson({session:row,uploadedParts:(parts.results||[]).map(x=>x.part_number),partSize:EDITION_PART_BYTES});
 }
 if(method!=='POST'||!strictOrigin(request))return editionJson({error:'Cross-origin request rejected'},403);
 if(path==='/api/private/edition/start'){
   await ensureEpubVerificationBaseline(env);
   if(!env.IMAGES)return editionJson({error:'Private R2 bucket not configured'},503);
   const b=await getJson(request),id=editionBook(b.novelId),size=Number(b.size);
   const filename=editionText(b.filename,160).replace(/[\\/\x00-\x1f]/g,'_');
   if(!id||!Number.isSafeInteger(size)||size<100||size>EDITION_MAX_BYTES||!/\.epub$/i.test(filename))
     return editionJson({error:'Choose an EPUB under 2 GiB and match it to an existing novel.'},400);
   if(id>962&&!await extraNovelExists(env,id))return editionJson({error:'Add the novel entry before uploading EPUBs'},404);
   const count=Math.ceil(size/EDITION_PART_BYTES);if(count>10000)return editionJson({error:'Too many chunks'},400);
   const idPart=crypto.randomUUID(),key='private-epub-editions/'+idPart+'.epub';
   const mpu=await env.IMAGES.createMultipartUpload(key,{httpMetadata:{contentType:'application/epub+zip'}});
   try{
     await env.DB.prepare('INSERT INTO '+sessionTable(id)+'(id,novel_id,owner_email,object_key,upload_id,filename,bytes,label,translator,language) VALUES (?,?,?,?,?,?,?,?,?,?)')
       .bind(idPart,id,email,key,mpu.uploadId,filename,size,editionText(b.label,100)||'Translation edition',editionText(b.translator,130),editionText(b.language,45)||'English').run();
   }catch(e){await mpu.abort();throw e;}
   return editionJson({sessionId:idPart,partSize:EDITION_PART_BYTES,totalParts:count,maxBytes:EDITION_MAX_BYTES});
 }
 if(path==='/api/private/edition/remove'){
   const body=await getJson(request),id=editionBook(body.novelId),edition=editionUuid(body.editionId);
   if(!id||!edition)return editionJson({error:'Choose a stored edition'},400);
   const row=await env.DB.prepare('SELECT object_key,filename FROM '+editionTable(id)+' WHERE novel_id=? AND id=?').bind(id,edition).first();
   if(!row||!/^private-epub-editions\/[0-9a-f-]{36}\.epub$/.test(row.object_key))return editionJson({error:'Edition not found'},404);
   await env.IMAGES.delete(row.object_key);
   await env.DB.prepare('DELETE FROM '+editionTable(id)+' WHERE novel_id=? AND id=?').bind(id,edition).run();
   await audit(env,email,'epub.edition.remove',id,row.filename);
   return editionJson({ok:true,removed:edition});
 }
 const bSession=editionUuid(u.searchParams.get('session'));
 if(!bSession)return editionJson({error:'Invalid upload session'},400);
 const session=await env.DB.prepare('SELECT * FROM epub_upload_sessions WHERE id=? AND owner_email=?').bind(bSession,email).first() || await env.DB.prepare('SELECT * FROM additional_epub_upload_sessions WHERE id=? AND owner_email=?').bind(bSession,email).first();
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
   try{await env.DB.prepare('INSERT INTO '+editionTable(session.novel_id)+'(id,novel_id,label,translator,language,filename,object_key,bytes,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)')
     .bind(session.id,session.novel_id,session.label,session.translator,session.language,session.filename,session.object_key,session.bytes,email).run();}
   catch(e){await env.IMAGES.delete(session.object_key);throw e;}
   await env.DB.prepare('DELETE FROM epub_upload_parts WHERE session_id=?').bind(bSession).run();
   await env.DB.prepare('DELETE FROM '+sessionTable(session.novel_id)+' WHERE id=?').bind(bSession).run();
   await audit(env,email,'epub.edition.upload',session.novel_id,session.filename);
   try{await followersNotice(env,session.novel_id,session.translator,`A new ${session.label} EPUB edition was added to novel #${session.novel_id}.`,'edition');}catch{}
   return editionJson({ok:true,edition:{id:session.id,novelId:session.novel_id,label:session.label,translator:session.translator,language:session.language,filename:session.filename,size:session.bytes}});
 }
 if(path==='/api/private/edition/abort'){
   try{await mpu.abort()}catch{}
   await env.DB.prepare('DELETE FROM epub_upload_parts WHERE session_id=?').bind(bSession).run();
   await env.DB.prepare('DELETE FROM '+sessionTable(session.novel_id)+' WHERE id=?').bind(bSession).run();
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
const PUBLISH_FIELDS=new Set(['tags','nuUrl','translatorUrl','translatorLinks','synopsis','translation','title','cover']);
// Extracted artwork transfer is strictly one-way: image bytes only. An editor
// selects images locally in the browser. The EPUB file is never sent here.
async function epubArtworkProposal(request,env,email,role){
 if(!isEditor(role))return communityJson({error:'Editor permission required'},403);
 if(!env.COMMUNITY_DB||!env.COMMUNITY_IMAGES)return communityJson({error:'Community database and artwork storage must be bound'},503);
 if(request.method!=='POST'||!strictOrigin(request))return communityJson({error:'Forbidden request origin'},403);
 if(!(request.headers.get('content-type')||'').startsWith('multipart/form-data'))return communityJson({error:'Upload using the artwork form'},415);
 const contentLength=Number(request.headers.get('content-length')||0);
 if(contentLength>3500000)return communityJson({error:'Image is too large (3 MB maximum)'},413);
 const fd=await request.formData();
 const id=editionBook(fd.get('novel_id')),credit=communityText(fd.get('image_credit'),150);
 const note=communityText(fd.get('caption'),600),file=fd.get('image');
 if(!id)return communityJson({error:'Choose a catalogue novel'},400);
 if(fd.get('rights')!=='on'||credit.length<2)return communityJson({error:'Confirm you have public-display permission and supply artist credit'},400);
 if(!(file instanceof File)||file.size<80||file.size>3000000||!['image/png','image/jpeg','image/webp'].includes(file.type))return communityJson({error:'Choose a JPEG, PNG or WebP under 3 MB'},415);
 const bytes=await file.arrayBuffer();
 if(!communityMagic(file.type,bytes))return communityJson({error:'Image format validation failed'},415);
 const proposalId=crypto.randomUUID(),ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[file.type];
 const key='community-submissions/'+proposalId+'.'+ext;
 try{
  await env.COMMUNITY_IMAGES.put(key,bytes,{httpMetadata:{contentType:file.type}});
  await env.COMMUNITY_DB.prepare('INSERT INTO community_entries(id,scope,novel_id,kind,display_name,author_identity,body,rating,spoiler,tags_json,external_url,image_key,image_credit,parent_id,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .bind(proposalId,'public',id,'image','Editor-submitted EPUB artwork',email,note,null,0,'[]','',key,credit,'','pending').run();
  await audit(env,email,'public.artwork.proposed',id,proposalId);
  return communityJson({ok:true,id:proposalId,status:'pending'},201);
 }catch(e){try{await env.COMMUNITY_IMAGES.delete(key)}catch{}return communityJson({error:'Image proposal could not be saved'},500)}
}


// Owner-uploaded EPUB covers are auto-published; a manual selection always wins.
// Only approved image bytes are placed in the shared artwork bucket. Never pass
// EPUB bytes or the private R2 object key into the public catalogue.
async function setEpubPublicCover(env,email,novelId,submissionId,imageKey,credit,force=false){
 const cover='/api/community/image?id='+submissionId;
 let published=false,skipped=false;
 for(let n=0;n<5;n++){
  const row=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(novelId).first();
  const old=row?JSON.parse(row.patch_json):{};
  if(old.cover&&!force){skipped=true;break;}
  const patch={...old,cover,coverCredit:credit||'Cover from EPUB · creator not supplied',coverRights:'Cover from locally uploaded EPUB; rights belong to the original creator'};
  const value=JSON.stringify(patch);let result;
  if(!row){result=await env.COMMUNITY_DB.prepare('INSERT INTO published_catalogue_overrides(novel_id,patch_json,source_entry_id,published_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING').bind(novelId,value,submissionId,email).run();}
  else{result=await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=?,source_entry_id=?,published_by=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?').bind(value,submissionId,email,novelId,row.patch_json).run();}
  if((result.meta?.changes??0)>0){published=true;break;}
 }
 if(!published)return {published:false,skipped};
 await env.COMMUNITY_DB.prepare('INSERT INTO published_correction_history(id,source_entry_id,novel_id,field_name,published_value,actor_email) VALUES (?,?,?,?,?,?)')
 .bind(crypto.randomUUID(),submissionId,novelId,'cover',JSON.stringify(cover),email).run();
 let privateSynced=true;
 try{
  if(!env.IMAGES)throw Error('Private image bucket not configured');
  const img=await env.COMMUNITY_IMAGES.get(imageKey);if(!img)throw Error('Cover image missing');
  const privateKey=crypto.randomUUID()+'.jpg';
  await env.IMAGES.put(privateKey,img.body,{httpMetadata:{contentType:'image/jpeg'}});
  const old=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(novelId).first();
  const patch={...(old?JSON.parse(old.patch):{}),cover:'/media/'+privateKey,coverRights:true};
  await env.DB.prepare('INSERT INTO novel_edits(id,patch) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET patch=excluded.patch,updated_at=CURRENT_TIMESTAMP').bind(novelId,JSON.stringify(patch)).run();
  await audit(env,email,'cover.auto.published',novelId,submissionId);
 }catch{privateSynced=false}
 return {published:true,skipped:false,privateSynced};
}

// One-time legacy COVER IMAGE backfill. Does not list, fetch, or expose EPUB objects.
// Source is an already assigned private cover (/media/<uuid>.jpg/png/webp).
// Destination is the same public-safe R2 bucket and metadata database that both
// Conservatory sites already use. Explicitly published covers always win.
const COVER_SYNC_KEY=/^\/media\/([a-f0-9-]{36}\.(?:jpe?g|png|webp))$/i;
function coverSyncImageKey(value){const m=COVER_SYNC_KEY.exec(String(value||''));return m?m[1]:null;}
function coverSyncPatch(raw){try{const p=JSON.parse(raw||'{}');return p&&typeof p==='object'?p:{}}catch{return {}}}
async function coverSyncRoutes(request,env,email,role){
  if(role!=='owner')return communityJson({error:'Only the library owner can synchronize covers'},403);
  if(!env.DB||!env.IMAGES||!env.COMMUNITY_DB||!env.COMMUNITY_IMAGES)return communityJson({error:'Both databases and both image buckets are required'},503);
  const path=new URL(request.url).pathname;
  if(path==='/api/admin/cover-sync/preview'&&request.method==='GET'){
    const [edits,publicRows]=await Promise.all([
      env.DB.prepare('SELECT id,patch FROM novel_edits WHERE id BETWEEN 1 AND 962 ORDER BY id LIMIT 1000').all(),
      env.COMMUNITY_DB.prepare('SELECT novel_id,patch_json FROM published_catalogue_overrides WHERE novel_id BETWEEN 1 AND 962 LIMIT 1000').all()
    ]);
    const published=new Set((publicRows.results||[]).filter(r=>Boolean(coverSyncPatch(r.patch_json).cover)).map(r=>Number(r.novel_id)));
    const ready=[],other=[];
    for(const row of edits.results||[]){
      const p=coverSyncPatch(row.patch);if(!p.cover)continue;
      if(published.has(Number(row.id)))continue;
      if(coverSyncImageKey(p.cover))ready.push(Number(row.id));
      else other.push(Number(row.id));
    }
    return communityJson({readyCount:ready.length,readyIds:ready,publishedCount:published.size,publishedIds:[...published],unsupportedCount:other.length,unsupportedIds:other.slice(0,30),message:'Only already stored private /media/ images can be copied. EPUBs are never read.'});
  }
  if(path!=='/api/admin/cover-sync/run'||request.method!=='POST')return communityJson({error:'Not found'},404);
  if(!strictOrigin(request))return communityJson({error:'Cross-origin request rejected'},403);
  let body;try{body=await getJson(request)}catch{return communityJson({error:'Invalid request'},400)}
  const cursor=Number(body.cursor||0),limit=Math.min(10,Math.max(1,Number(body.limit)||8));
  if(!Number.isInteger(cursor)||cursor<0||cursor>962)return communityJson({error:'Invalid cursor'},400);
  if(!Number.isInteger(limit))return communityJson({error:'Invalid batch size'},400);
  const scan=await env.DB.prepare('SELECT id,patch FROM novel_edits WHERE id>? AND id<=962 ORDER BY id LIMIT ?').bind(cursor,limit).all();
  const rows=scan.results||[],counts={copied:0,alreadyPublished:0,notCover:0,missing:0,tooLarge:0,failed:0},errors=[];
  for(const row of rows){
    const novelId=Number(row.id),privateKey=coverSyncImageKey(coverSyncPatch(row.patch).cover);
    if(!privateKey){counts.notCover++;continue;}
    let publicRow;try{publicRow=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(novelId).first();}
    catch{counts.failed++;errors.push('Novel #'+novelId+': public metadata unavailable');continue}
    if(coverSyncPatch(publicRow?.patch_json).cover){counts.alreadyPublished++;continue;}
    let object;try{object=await env.IMAGES.get(privateKey)}catch{}
    if(!object){counts.missing++;errors.push('Novel #'+novelId+': original image not found');continue;}
    const ext=privateKey.split('.').pop().toLowerCase();
    const mime=ext==='png'?'image/png':ext==='webp'?'image/webp':'image/jpeg';
    if(object.size>5000000||object.size<80){counts.tooLarge++;continue;}
    let entryId=null,sharedKey=null;
    try{
      const bytes=await object.arrayBuffer();
      if(!communityMagic(mime,bytes))throw Error('Image format check failed');
      entryId=crypto.randomUUID();sharedKey='community-submissions/'+entryId+'.'+ext;
      await env.COMMUNITY_IMAGES.put(sharedKey,bytes,{httpMetadata:{contentType:mime}});
      await env.COMMUNITY_DB.prepare('INSERT INTO community_entries(id,scope,novel_id,kind,display_name,author_identity,body,rating,spoiler,tags_json,external_url,image_key,image_credit,parent_id,status,moderated_by,moderated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
        .bind(entryId,'public',novelId,'image','Existing private cover · synchronized',email,'Previously selected private catalogue cover',null,0,'["__epub_auto_cover__","__legacy_private_cover_sync__"]','',sharedKey,'Existing catalogue cover · original artist credit not verified','','approved',email).run();
      const cover='/api/community/image?id='+entryId;
      const old=coverSyncPatch(publicRow?.patch_json);
      const patch=JSON.stringify({...old,cover,coverCredit:'Existing catalogue cover · attribution not verified',coverRights:'Rights remain with original creator'});
      const update=publicRow
       ? await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=?,source_entry_id=?,published_by=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?')
           .bind(patch,entryId,email,novelId,publicRow.patch_json).run()
       : await env.COMMUNITY_DB.prepare('INSERT INTO published_catalogue_overrides(novel_id,patch_json,source_entry_id,published_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING')
           .bind(novelId,patch,entryId,email).run();
      if((update.meta?.changes??0)===0){counts.alreadyPublished++;continue;}
      counts.copied++;
      await env.COMMUNITY_DB.prepare('INSERT INTO published_correction_history(id,source_entry_id,novel_id,field_name,published_value,actor_email) VALUES (?,?,?,?,?,?)')
       .bind(crypto.randomUUID(),entryId,novelId,'cover',JSON.stringify(cover),email).run();
      await audit(env,email,'cover.bulk.synced',novelId,'Shared cover approved');
    }catch(e){counts.failed++;errors.push('Novel #'+novelId+': '+String(e?.message||'Could not copy').slice(0,100));}
  }
  const nextCursor=rows.length?Number(rows[rows.length-1].id):962;
  return communityJson({ok:true,counts,cursor:nextCursor,done:rows.length<limit||nextCursor>=962,errors:errors.slice(0,8)});
}

async function epubArtworkAutoRoutes(request,env,email,role){
 if(!isEditor(role))return communityJson({error:'Editor permission required'},403);
 if(!env.COMMUNITY_DB||!env.COMMUNITY_IMAGES||!env.DB)return communityJson({error:'Community and private storage must be connected'},503);
 if(request.method==='GET'&&new URL(request.url).pathname==='/api/admin/epub-artwork/auto/list'){
  const novelId=editionBook(new URL(request.url).searchParams.get('id'));
  if(!novelId)return communityJson({error:'Invalid novel ID'},400);
  const [rows,current]=await Promise.all([
   env.COMMUNITY_DB.prepare("SELECT id,image_credit,body,created_at FROM community_entries WHERE scope='public' AND novel_id=? AND kind='image' AND status='approved' AND tags_json LIKE '%__epub_auto_cover__%' ORDER BY created_at DESC LIMIT 80").bind(novelId).all(),
   env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(novelId).first()
  ]);
  let cover='';try{cover=JSON.parse(current?.patch_json||'{}').cover||''}catch{}
  return communityJson({covers:(rows.results||[]).map(r=>({id:r.id,credit:r.image_credit,caption:r.body,date:r.created_at,url:'/api/community/image?id='+r.id})),currentCover:cover});
 }
 if(request.method!=='POST'||!strictOrigin(request))return communityJson({error:'Forbidden'},403);
 if(new URL(request.url).pathname==='/api/admin/epub-artwork/set-cover'){
   let b;try{b=await getJson(request)}catch{return communityJson({error:'Invalid request'},400)}
   const novelId=editionBook(b.novelId),id=editionUuid(b.submissionId);
   if(!novelId||!id)return communityJson({error:'Invalid cover selection'},400);
   const row=await env.COMMUNITY_DB.prepare("SELECT image_key,image_credit FROM community_entries WHERE id=? AND novel_id=? AND scope='public' AND kind='image' AND status='approved'").bind(id,novelId).first();
   if(!row?.image_key)return communityJson({error:'Approved cover not found'},404);
   const result=await setEpubPublicCover(env,email,novelId,id,row.image_key,row.image_credit,true);
   return communityJson({ok:true,...result});
 }
 if(role!=='owner')return communityJson({error:'Only the owner can auto-publish EPUB covers'},403);
 if(!(request.headers.get('content-type')||'').startsWith('multipart/form-data'))return communityJson({error:'Upload an image'},415);
 const size=Number(request.headers.get('content-length')||0);if(size>3300000)return communityJson({error:'Image exceeds 3 MB'},413);
 let fd;try{fd=await request.formData()}catch{return communityJson({error:'Invalid multipart submission'},400)}
 const novelId=editionBook(fd.get('novel_id')),file=fd.get('image');
 if(!novelId||!(file instanceof File)||file.type!=='image/jpeg'||file.size<80||file.size>2800000)return communityJson({error:'Image must be a JPEG under 2.8 MB for an existing novel'},400);
 const bytes=await file.arrayBuffer();if(!communityMagic('image/jpeg',bytes))return communityJson({error:'Invalid JPEG'},415);
 const source=editionText(fd.get('source'),130),credit=editionText(fd.get('credit'),150)||'Cover from EPUB · original artist not specified';
 const id=crypto.randomUUID(),key='community-submissions/'+id+'.jpg';
 try{
   await env.COMMUNITY_IMAGES.put(key,bytes,{httpMetadata:{contentType:'image/jpeg'}});
   await env.COMMUNITY_DB.prepare('INSERT INTO community_entries(id,scope,novel_id,kind,display_name,author_identity,body,rating,spoiler,tags_json,external_url,image_key,image_credit,parent_id,status,moderated_by,moderated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
   .bind(id,'public',novelId,'image','EPUB cover · automatic',email,source||'Cover from owner-uploaded EPUB',null,0,'["__epub_auto_cover__"]','',key,credit,'','approved',email).run();
   const pub=await setEpubPublicCover(env,email,novelId,id,key,credit,fd.get('replace')==='1');
   return communityJson({ok:true,id,status:'approved',imageUrl:'/api/community/image?id='+id,...pub},201);
 }catch(e){try{await env.COMMUNITY_IMAGES.delete(key)}catch{}return communityJson({error:'Cover could not be published; EPUB is still saved'},500)}
}

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
 if(field==='translatorLinks'){
   let markers=[];try{markers=JSON.parse(entry.tags_json||'[]')}catch{}
   if(entry.scope!=='public'||!markers.includes('__translator_link__'))return editionJson({error:'Only an approved public translator link may be published here'},400);
 }
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
   value='/api/community/image?id='+entry.id;extra.coverRights=true;extra.coverCredit=editionText(entry.image_credit,150);
 }else if(field==='translatorLinks'){
   let markers=[];try{markers=JSON.parse(entry.tags_json||'[]')}catch{}
   const url=safeLink(entry.external_url),name=editionText(b.value,100);
   if(!/^https:\/\//.test(url||'')||!name)return editionJson({error:'Provide a reviewed translator name and HTTPS link'},400);
   value={name,url,type:markers.includes('__reading_page__')?'reading-page':'homepage',sourceEntryId:id};
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
 if(field==='synopsis'||field==='tags'){extra.metadataReview='editor-reviewed';if(field==='synopsis'&&entry.external_url)extra.metadataSource=safeLink(entry.external_url)||null;}
 const patch={[field]:value,...extra};
 // First update the shared public-only override. Both sites read that source;
 // then apply the same safe field to private D1. These databases cannot share a transaction.
 let updated=false;
 for(let attempt=0;attempt<3&&!updated;attempt++){
   const row=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(entry.novel_id).first();
   const existing=row?JSON.parse(row.patch_json):{};
   const combined={...existing,...patch};
   if(field==='translatorLinks'){
     const prior=Array.isArray(existing.translatorLinks)?existing.translatorLinks.filter(x=>x&&typeof x.url==='string').slice(0,29):[];
     const duplicate=prior.some(x=>x.url===value.url);
     if(duplicate)return editionJson({error:'That translator URL is already published for this book'},409);
     combined.translatorLinks=[...prior,value];
   }
   const val=JSON.stringify(combined);
   if(!row){const r=await env.COMMUNITY_DB.prepare('INSERT INTO published_catalogue_overrides(novel_id,patch_json,source_entry_id,published_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING').bind(entry.novel_id,val,id,email).run();updated=(r.meta?.changes??0)>0;}
   else{const r=await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=?,source_entry_id=?,published_by=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?').bind(val,id,email,entry.novel_id,row.patch_json).run();updated=(r.meta?.changes??0)>0;}
 }
 if(!updated)return editionJson({error:'Another editor published simultaneously; refresh and retry'},409);
 if(field==='translatorLinks'){
   // Store the complete approved list in the private catalogue without replacing
   // the original translator / translation-edition records.
   const row=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(entry.novel_id).first();
   value=JSON.parse(row.patch_json).translatorLinks;
 }
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

// D1-backed editorial CMS. One deployed route means future tags and synopsis edits
// change both catalogues without a redeployment. The public project never sees DB.
async function liveCatalogueEditorRoute(request,env,email,role){
 if(!isEditor(role))return respond({error:'Editor access required'},403);
 if(!env.DB||!env.COMMUNITY_DB)return respond({error:'Both databases must be configured'},503);
 const url=new URL(request.url);
 const id=Number(request.method==='GET'?url.searchParams.get('id'):0);
 if(request.method==='GET'){
  if(!Number.isSafeInteger(id)||id<1||id>962)return respond({error:'Choose an existing novel'},400);
  try{
   const [pub,pri]=await Promise.all([
    env.COMMUNITY_DB.prepare('SELECT patch_json,updated_at FROM published_catalogue_overrides WHERE novel_id=?').bind(id).first(),
    env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(id).first()
   ]);
   return respond({id,published:pub?JSON.parse(pub.patch_json):{},privatePatch:pri?JSON.parse(pri.patch):{},updatedAt:pub?.updated_at||null});
  }catch{return respond({error:'Could not load the book metadata'},503)}
 }
 if(request.method!=='POST')return respond({error:'Method not allowed'},405);
 if(!sameOrigin(request))return respond({error:'Wrong origin'},403);
 if(!(request.headers.get('content-type')||'').includes('application/json'))return respond({error:'Expected JSON'},415);
 let body;
 try{const raw=await request.text();if(raw.length>6000)return respond({error:'Request too large'},413);body=JSON.parse(raw)}catch{return respond({error:'Invalid JSON'},400)}
 const bookId=Number(body.id);
 if(!Number.isSafeInteger(bookId)||bookId<1||bookId>962)return respond({error:'Choose a novel from your catalogue'},400);
 // Verify this ID belongs to the immutable 962-record seed, not an arbitrary ID.
 const seed=await env.ASSETS.fetch(new Request(new URL('/admin/catalogue.json',request.url)));
 if(!seed.ok)return respond({error:'Catalogue is unavailable'},503);
 const entries=await seed.json();
 if(!(Array.isArray(entries)?entries:entries.books||[]).some(x=>x.id===bookId))return respond({error:'Novel not found'},404);
 if(typeof body.synopsis!=='string'||body.synopsis.length>2000)return respond({error:'Synopsis must be at most 2,000 characters'},400);
 if(!Array.isArray(body.tags)||body.tags.length>30)return respond({error:'Too many tags'},400);
 const tags=[];const seen=new Set();
 for(const item of body.tags){
  if(typeof item!=='string'||item.length>70)return respond({error:'Each tag must be 70 characters or fewer'},400);
  const tag=item.normalize('NFKC').trim();if(!tag)continue;
  const key=tag.toLocaleLowerCase('en');if(seen.has(key))continue;seen.add(key);tags.push(tag);
 }
 const synopsis=body.synopsis.trim();
 // Never auto-copy third-party synopses. Admin must attest original/authorized text.
 if(synopsis&&body.rightsConfirmed!==true)return respond({error:'Confirm the summary is your own writing or authorized for reuse'},400);
 const src=String(body.sourceUrl||'').trim();let source='';
 if(src){try{const u=new URL(src);if(u.protocol!=='https:'||u.username||u.password)throw Error();source=u.href.slice(0,750)}catch{return respond({error:'Source must be an HTTPS URL'},400)}}
 const patch={synopsis,tags,metadataReview:'editor-reviewed',metadataSource:source||null};
 // Merging into current public override protects translator links and cover changes.
 let wrote=false;
 try{
  for(let tries=0;tries<4&&!wrote;tries++){
   const old=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(bookId).first();
   const value=JSON.stringify({...(old ? JSON.parse(old.patch_json) : {}),...patch});
   let result;
   if(old)result=await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=?,source_entry_id=?,published_by=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?').bind(value,'editor-direct',email,bookId,old.patch_json).run();
   else result=await env.COMMUNITY_DB.prepare('INSERT INTO published_catalogue_overrides(novel_id,patch_json,source_entry_id,published_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING').bind(bookId,value,'editor-direct',email).run();
   wrote=(result.meta?.changes??0)>0;
  }
  if(!wrote)return respond({error:'Another editor changed this book; refresh and try again'},409);
  for(const field of ['synopsis','tags']){
   await env.COMMUNITY_DB.prepare('INSERT INTO published_correction_history(id,source_entry_id,novel_id,field_name,published_value,actor_email) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),'editor-direct',bookId,field,JSON.stringify(patch[field]),email).run();
  }
 }catch{return respond({error:'Could not publish the update to the public catalogue'},503)}
 let privateSynced=false;
 try{
  const prev=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(bookId).first();
  const next={...(prev?JSON.parse(prev.patch):{}),...patch};
  await env.DB.prepare('INSERT INTO novel_edits(id,patch) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET patch=excluded.patch,updated_at=CURRENT_TIMESTAMP').bind(bookId,JSON.stringify(next)).run();
  await audit(env,email,'catalogue.editor.publish',bookId,'synopsis,tags');
  privateSynced=true;
 }catch{}
 return respond({ok:true,id:bookId,publicPublished:true,privateSynced});
}


// Secure, quarantined EPUB donation inbox. This is private-only and NEVER
// copied to the public Worker or auto-attached to published book records.
async function privateEpubSubmissionRoutes(request,env,email,role){
 const url=new URL(request.url),path=url.pathname,method=request.method.toUpperCase();
 if(!env.DB||!env.IMAGES)return respond({error:'Private EPUB intake is not configured'},503);
 const id=String(url.searchParams.get('id')||'');
 const validId=/^[a-f0-9-]{36}$/.test(id);
 const setting=id=>'epub-submission:'+id;
 const owner=role==='owner';
 if(method==='POST'&&request.headers.get('origin')!==new URL(request.url).origin)return respond({error:'Wrong origin'},403);
 try{
  if(path==='/api/epub-submissions/upload'&&method==='POST'){
   const length=Number(request.headers.get('content-length')||0);
   const limit=15*1024*1024;
   if(length>limit)return respond({error:'EPUB submissions must be 15 MB or smaller'},413);
   const type=(request.headers.get('content-type')||'').split(';')[0].toLowerCase().trim();
   if(!['application/epub+zip','application/octet-stream','application/zip'].includes(type))return respond({error:'Choose an EPUB file'},415);
   if(request.headers.get('x-epub-rights')!=='yes')return respond({error:'Confirm that you have permission to submit this EPUB'},400);
   let filename='submission.epub';
   try{filename=decodeURIComponent(request.headers.get('x-epub-filename')||'submission.epub').replace(/[/\\\x00-\x1f]/g,'_').trim().slice(0,140)}catch{return respond({error:'Invalid EPUB filename'},400)}
   if(!/\.epub$/i.test(filename))return respond({error:'Only EPUB files are accepted'},415);
   let title='',notes='';
   try{title=decodeURIComponent(request.headers.get('x-epub-title')||'').trim().slice(0,180);notes=decodeURIComponent(request.headers.get('x-epub-notes')||'').trim().slice(0,420)}catch{return respond({error:'Invalid title or note encoding'},400)}
   const rawNovel=String(request.headers.get('x-epub-novel-id')||'').trim();
   const novelId=rawNovel&&/^[1-9]\d{0,8}$/.test(rawNovel)?Number(rawNovel):null;
   if(rawNovel&&!novelId)return respond({error:'Use a valid catalogue ID or leave it blank'},400);
   if(title.length<2)return respond({error:'Enter the novel title'},400);
   const recent=await env.DB.prepare("SELECT value FROM site_settings WHERE key LIKE 'epub-submission:%' ORDER BY updated_at DESC LIMIT 500").all();
   let recentCount=0;const dayAgo=Date.now()-24*60*60*1000;
   for(const item of recent.results||[]){
    try{const data=JSON.parse(item.value);if(data.submitter===email&&Date.parse(data.createdAt)>dayAgo)recentCount++}catch{}
   }
   if(recentCount>=8)return respond({error:'Limit of 8 EPUB submissions per account per 24 hours. Try again tomorrow.'},429);
   // Hard cap stream even when a client omits/forges Content-Length.
   const chunks=[];let n=0;const reader=request.body?.getReader();
   if(!reader)return respond({error:'Empty file upload'},400);
   for(;;){const part=await reader.read();if(part.done)break;n+=part.value.byteLength;if(n>limit){await reader.cancel();return respond({error:'EPUB exceeds the 15 MB limit'},413)}chunks.push(part.value)}
   if(n<100)return respond({error:'EPUB file is empty or invalid'},415);
   const bytes=await new Blob(chunks).arrayBuffer(),head=new Uint8Array(bytes,0,4);
   if(head[0]!==80||head[1]!==75||![3,5,7].includes(head[2]))return respond({error:'EPUB archive signature did not pass validation'},415);
   const uid=crypto.randomUUID(),key='private-epub-submissions/'+uid+'.epub';
   const metadata={id:uid,submitter:email,novelId,title,notes,filename,size:n,createdAt:new Date().toISOString(),status:'pending',key};
   await env.IMAGES.put(key,bytes,{httpMetadata:{contentType:'application/octet-stream'}});
   try{
    await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?)').bind(setting(uid),JSON.stringify(metadata)).run();
   }catch(e){await env.IMAGES.delete(key);throw e}
   return respond({ok:true,id:uid,status:'pending',message:'EPUB submitted privately for owner review. It has not been published or linked to a novel.'},201);
  }
  if(path==='/api/epub-submissions/list'&&method==='GET'){
   if(!owner)return respond({error:'Owner access required'},403);
   const rows=await env.DB.prepare("SELECT value FROM site_settings WHERE key LIKE 'epub-submission:%' ORDER BY updated_at DESC LIMIT 200").all();
   const items=[];
   for(const r of rows.results||[]){try{const v=JSON.parse(r.value);delete v.key;items.push(v)}catch{}}
   return respond({items});
  }
  if(path==='/api/epub-submissions/download'&&method==='GET'){
   if(!owner)return respond({error:'Owner access required'},403);
   if(!validId)return respond({error:'Invalid submission ID'},400);
   const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(setting(id)).first();
   if(!row)return respond({error:'Submission not found'},404);
   const meta=JSON.parse(row.value);
   if(meta.key!=='private-epub-submissions/'+id+'.epub')return respond({error:'Invalid private object reference'},409);
   const obj=await env.IMAGES.get(meta.key);if(!obj)return respond({error:'Stored submission missing'},404);
   const safeName=String(meta.filename||'submission.epub').replace(/[^a-zA-Z0-9_. -]/g,'_').slice(0,120);
   return new Response(obj.body,{headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="'+safeName+'"','cache-control':'private,no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'x-robots-tag':'noindex,nofollow'}});
  }
  if(path==='/api/epub-submissions/review'&&method==='POST'){
   if(!owner)return respond({error:'Owner access required'},403);
   let body;try{body=await getJson(request)}catch{return respond({error:'Expected JSON'},415)}
   const uid=String(body.id||''),decision=String(body.decision||'');
   if(!/^[a-f0-9-]{36}$/.test(uid)||!['reviewed','reject'].includes(decision))return respond({error:'Invalid review request'},400);
   const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(setting(uid)).first();
   if(!row)return respond({error:'Submission not found'},404);
   const meta=JSON.parse(row.value);
   if(decision==='reject'){
    // Do not keep unreviewed file bytes after rejection.
    if(meta.key==='private-epub-submissions/'+uid+'.epub')await env.IMAGES.delete(meta.key);
    await env.DB.prepare('DELETE FROM site_settings WHERE key=?').bind(setting(uid)).run();
   }else{
    meta.status='reviewed';meta.reviewedAt=new Date().toISOString();
    await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=?').bind(JSON.stringify(meta),setting(uid)).run();
   }
   await audit(env,email,'private.epub.submission.'+decision,uid,meta.title||'');
   return respond({ok:true,status:decision});
  }
  return respond({error:'Not found'},404);
 }catch{return respond({error:'EPUB submission could not be processed; please try again or contact the owner'},500)}
}

export default {
  async fetch(request,env,ctx){
    // All paths, including the static website, fail closed unless Access has
    // issued a signature-verified token for this exact production/preview app.
    let email,role;
    try {email=await verifyAccess(request,env);role=await roleFor(email,env);}
    catch(e){return respond({error:'Access verification failed. Check your login and Access settings.'},403);}
    const path=new URL(request.url).pathname;
    // Cloudflare Access's signed JWT and its application policy are the only
    // authorization gates for general browsing. No second invitation or D1
    // approved-reader list is needed.
    if(path==='/join'||path==='/join/'||path==='/join/index.html')
      return Response.redirect(new URL('/',request.url),302);
    if(path==='/admin/invitations.html')
      return Response.redirect(new URL('/admin/',request.url),302);
    if(path.startsWith('/api/invitations/')||path==='/api/admin/invitations')
      return respond({error:'Website invitations have been retired. Access is managed through Cloudflare Zero Trust.'},410);
    if(path==='/read'||path.startsWith('/read/')){
      if(!await canReadEpubs(email,role,env))return respond({error:'You do not have permission to open private EPUBs.'},403);
      if(path==='/read')return Response.redirect(new URL('/read/',request.url),302);
      const asset=await env.ASSETS.fetch(request);const head=new Headers(asset.headers);
      head.set('cache-control','private,no-store');head.set('x-robots-tag','noindex,nofollow');
      return new Response(asset.body,{status:asset.status,statusText:asset.statusText,headers:head});
    }
    // Static page shared by all novel IDs. The URL remains stable across
    // re-cataloguing; API resolver redirects archived IDs to canonical ones.
    if(/^\/novel\/[1-9]\d{0,10}\/?$/.test(path)){
      const asset=await env.ASSETS.fetch(new Request(new URL('/novel/index.html',request.url)));
      const headers=new Headers(asset.headers);
      headers.set('content-type','text/html; charset=utf-8');
      headers.set('cache-control','private,no-store');
      headers.set('x-robots-tag','noindex,nofollow,noarchive');
      headers.set('referrer-policy','no-referrer');
      return new Response(asset.body,{status:asset.status,headers});
    }
    if(path.startsWith('/api/')||path.startsWith('/media/')||path.startsWith('/admin/')||path==='/admin')
      return routes(request,env,ctx,email,role);
    const res=await env.ASSETS.fetch(request);
    const headers=new Headers(res.headers);
    headers.set('cache-control','private,no-store');
    headers.set('x-robots-tag','noindex,nofollow');
    headers.set('referrer-policy','no-referrer');
    return new Response(res.body,{status:res.status,statusText:res.statusText,headers});
  }
};


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
   try{
    await env.COMMUNITY_DB.prepare('INSERT INTO community_entries(id,scope,novel_id,kind,display_name,author_identity,body,rating,spoiler,tags_json,external_url,image_key,image_credit,parent_id,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
     .bind(id,scope,book,kind,name,identity?.email||'',body,rating,spoiler,JSON.stringify(tags),url,imageKey,imageCredit,parentId,'pending').run();
   }catch(e){if(imageKey&&env.COMMUNITY_IMAGES)await env.COMMUNITY_IMAGES.delete(imageKey);throw e;}
   return communityJson({ok:true,id,status:'pending'},201);
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
 const key=String(raw.publicBannerKey||'');
 result.publicBannerKey=/^[a-f0-9-]{36}\.(?:png|jpg|webp)$/.test(key)?key:'';
 result.publicBannerX=Number.isFinite(Number(raw.publicBannerX))?Math.max(0,Math.min(100,Math.round(Number(raw.publicBannerX)))):50;
 result.publicBannerY=Number.isFinite(Number(raw.publicBannerY))?Math.max(0,Math.min(100,Math.round(Number(raw.publicBannerY)))):50;
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
 if(path==='/api/admin/public-banner-preview'){
  if(method!=='GET')return siteOut({error:'Method not allowed'},405);
  if(!env.COMMUNITY_IMAGES)return siteOut({error:'Artwork storage unavailable'},503);
  const key=String(url.searchParams.get('key')||'');
  if(!/^[a-f0-9-]{36}\.(?:png|jpg|webp)$/.test(key))return siteOut({error:'Invalid image key'},400);
  const image=await env.COMMUNITY_IMAGES.get('public-banners/'+key);
  if(!image)return siteOut({error:'Image not found'},404);
  return new Response(image.body,{headers:{'content-type':image.httpMetadata?.contentType||'application/octet-stream','cache-control':'private,no-store','x-content-type-options':'nosniff'}});
 }
 if(path==='/api/admin/public-banner'){
  if(method!=='POST')return siteOut({error:'Method not allowed'},405);
  if(request.headers.get('Origin')!==url.origin)return siteOut({error:'Wrong origin'},403);
  if(!env.COMMUNITY_IMAGES)return siteOut({error:'Shared artwork storage unavailable'},503);
  const ct=(request.headers.get('content-type')||'').split(';')[0].trim();
  const ext=({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'})[ct];
  if(!ext)return siteOut({error:'Choose a PNG, JPG or WebP image'},415);
  if(Number(request.headers.get('content-length')||0)>3000000)return siteOut({error:'Maximum 3 MB'},413);
  const bytes=await request.arrayBuffer();
  if(bytes.byteLength<90||bytes.byteLength>3000000)return siteOut({error:'Image must be 90 bytes to 3 MB'},413);
  const b=new Uint8Array(bytes);
  const valid=ext==='png'?(b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71&&b[4]===13&&b[5]===10&&b[6]===26&&b[7]===10):
   ext==='jpg'?(b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217):
   (String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP');
  if(!valid)return siteOut({error:'Image format check failed'},415);
  const key=crypto.randomUUID()+'.'+ext;
  await env.COMMUNITY_IMAGES.put('public-banners/'+key,bytes,{httpMetadata:{contentType:ct}});
  return siteOut({ok:true,key,url:'https://'+url.host+'/banner-media/'+key});
 }
 if(path==='/api/admin/site-copy-from-private'&&method==='POST'){
  if(request.headers.get('Origin')!==url.origin)return siteOut({error:'Wrong origin'},403);
  if(!env.DB)return siteOut({error:'Private homepage database unavailable'},503);
  const row=await env.DB.prepare("SELECT value FROM site_settings WHERE key='homepage'").first();
  let home={};try{home=JSON.parse(row?.value||'{}')}catch{return siteOut({error:'Invalid private homepage'},503)}
  const old=await siteGet(env,'public');
  const updated=siteClean({...old,homeHeadline:siteTrim(home.heroTitle||'',110),homeFlavor:siteTrim(home.heroDescription||'',350)});
  await env.COMMUNITY_DB.prepare('INSERT INTO conservatory_site_config(scope,config_json,updated_by) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET config_json=excluded.config_json,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP')
    .bind('public',JSON.stringify(updated),email).run();
  return siteOut({ok:true,settings:updated});
 }
 if(path==='/api/admin/public-banner-copy'&&method==='POST'){
  if(request.headers.get('Origin')!==url.origin)return siteOut({error:'Wrong origin'},403);
  if(!env.DB||!env.IMAGES||!env.COMMUNITY_IMAGES)return siteOut({error:'Required private and public-safe storage unavailable'},503);
  const row=await env.DB.prepare("SELECT value FROM site_settings WHERE key='homepage'").first();
  let home={};try{home=JSON.parse(row?.value||'{}')}catch{return siteOut({error:'Private homepage settings unavailable'},503)}
  const match=/^\/media\/([a-f0-9-]{36}\.(?:png|jpg|webp))$/.exec(home.heroImage||'');
  if(!match)return siteOut({error:'Private banner is not a saved JPG/PNG/WebP. Use the public website editor to upload the image instead.'},400);
  const oldFile=await env.IMAGES.get(match[1]);
  if(!oldFile)return siteOut({error:'Stored private banner was not found'},404);
  const mime=oldFile.httpMetadata?.contentType||'';
  if(!['image/png','image/jpeg','image/webp'].includes(mime)||oldFile.size<100||oldFile.size>3000000)
   return siteOut({error:'Private banner must be JPG, PNG, or WebP under 3 MB'},400);
  const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg';
  const bytes=await oldFile.arrayBuffer();
  if(!communityMagic(mime,bytes))return siteOut({error:'Private banner validation failed'},415);
  const key=crypto.randomUUID()+'.'+ext;
  await env.COMMUNITY_IMAGES.put('public-banners/'+key,bytes,{httpMetadata:{contentType:mime}});
  try{
   const previous=await siteGet(env,'public');
   const next=siteClean({...previous,publicBannerKey:key});
   await env.COMMUNITY_DB.prepare('INSERT INTO conservatory_site_config(scope,config_json,updated_by) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET config_json=excluded.config_json,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP')
    .bind('public',JSON.stringify(next),email).run();
   await audit(env,email,'public.banner.copy-private',key);
  }catch(e){await env.COMMUNITY_IMAGES.delete('public-banners/'+key);return siteOut({error:'Could not publish public banner'},503)}
  return siteOut({ok:true,image:'/banner-media/'+key});
 }
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
const extraTags=x=>[...new Set((Array.isArray(x)?x:String(x||'').split(/[,;\n]/)).map(t=>extraTxt(t,65)).filter(Boolean))].slice(0,100);
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
 // Automatically catalogued private EPUBs have source-derived metadata, not
 // editor-reviewed metadata. Preserve that provenance so tags become
 // discoverable without falsely claiming a person verified them.
 const fromPrivateEpub=visibility==='private'&&
  /^EPUB (?:embedded metadata|filename)$/i.test(String(payload.metadataSource||''));
 payload={...payload,metadataReview:fromPrivateEpub?false:true,
  ...(fromPrivateEpub?{metadataOrigin:'epub'}:{})};
 const key=payload.title.toLocaleLowerCase().replace(/\s+/g,' ').trim();
 if(!payload.title||payload.title.length<2)throw Error('Enter a novel title');
 const duplicate=await env.COMMUNITY_DB.prepare("SELECT id,title FROM additional_catalogue_novels WHERE normalized_title=? AND source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%' LIMIT 1").bind(key).first();
 if(duplicate)throw Error('This title may already exist as #'+duplicate.id+'. Check before submitting again.');
 const existing=await canonicalPrivateOwner(env,payload);
 if(existing)throw Error('This novel is already registered as #'+existing+'. Update that entry instead.');
 for(let i=0;i<5;i++){
  const id=100000+crypto.getRandomValues(new Uint32Array(1))[0];
  const reservation=await canonicalPrivateClaim(env,payload,id);
  if(!reservation.ok)throw Error('A matching novel was added as #'+reservation.owner+'. Retry to update the existing entry.');
  try{
   await env.COMMUNITY_DB.prepare('INSERT INTO additional_catalogue_novels(id,normalized_title,title,payload_json,cover_key,visibility,source_submission_id,created_by) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id,key,payload.title,JSON.stringify(payload),coverKey,visibility,submissionId,who).run();
   return id;
  }catch(e){
   for(const claimed of reservation.claimed)await env.COMMUNITY_DB.prepare('DELETE FROM canonical_novel_keys WHERE identity_key=? AND novel_id=?').bind(claimed,id).run().catch(()=>{});
   if(!/unique|constraint.*id/i.test(String(e?.message||'')))throw e;
  }
 }
 throw Error('Could not assign novel ID; please retry');
}

// Single canonical entry point for manually created novels. Reuse/merge an
// unambiguous existing additional record instead of creating another card.
// Never infer sameness solely from a title when authors differ or are unknown.

// Direct Editor changes take effect immediately. The same append-only history
// used by Novel Updates merges enables Undo without a moderation queue.
async function extraEditWithUndo(env,email,row,patch,visibility){
 await nuEnsureJournal(env);
 const id=Number(row.id),before=row.payload_json;
 if(String(row.source_submission_id||'').startsWith('merged-into:')||
    String(row.source_submission_id||'').startsWith('reverted-create:'))
  throw Error('This record was merged or reverted. Open its surviving entry.');
 let old;try{old=JSON.parse(before||'{}')}catch{throw Error('Existing metadata could not be parsed')}
 const next=extraPayload({...old,...patch}),after=JSON.stringify(next);
 if(next.title.length<2)throw Error('A novel title is required');
 if(after===before&&visibility===row.visibility)return {ok:true,id,unchanged:true};
 // Changing a title must not accidentally create two active, identical entries.
 if(nuIdentity(next.title)!==nuIdentity(row.title)){
  const duplicate=await env.COMMUNITY_DB.prepare("SELECT id FROM additional_catalogue_novels WHERE normalized_title=? AND id<>? AND source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%' LIMIT 1")
   .bind(nuStoredTitleKey(next.title),id).first();
  if(duplicate)throw Error('A novel with this title already exists as #'+duplicate.id+'. Use Merge duplicates instead.');
 }
 const eventId=crypto.randomUUID(),snapshot={
  targetKind:'extra',beforeTarget:before,afterTarget:after,sourceId:null,
  beforeSourceMarker:null,afterSourceMarker:null,beforePrivate:null,afterPrivate:null,
  beforeVisibility:row.visibility,afterVisibility:visibility
 };
 const result=await env.COMMUNITY_DB.prepare(
  "UPDATE additional_catalogue_novels SET title=?,normalized_title=?,payload_json=?,visibility=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payload_json=? AND visibility=? AND source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%'"
 ).bind(next.title,nuStoredTitleKey(next.title),after,visibility,id,before,row.visibility).run();
 if((result.meta?.changes||0)!==1)throw Error('Another editor changed the book. Refresh and retry.');
 try{
  await env.COMMUNITY_DB.prepare('INSERT INTO catalogue_edit_events(id,operation,target_id,duplicate_id,before_json,after_json,source_url,actor_email) VALUES(?,?,?,?,?,?,?,?)')
   .bind(eventId,'metadata_sync',id,null,JSON.stringify(snapshot),JSON.stringify({target:after}),nuCanon(next.nuUrl),email).run();
 }catch(error){
  await env.COMMUNITY_DB.prepare("UPDATE additional_catalogue_novels SET title=?,normalized_title=?,payload_json=?,visibility=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payload_json=? AND visibility=?")
   .bind(row.title,nuStoredTitleKey(row.title),before,row.visibility,id,after,visibility).run().catch(()=>{});
  throw Error('Could not save edit history. The metadata change was rolled back: '+String(error.message||error).slice(0,100));
 }
 try{await audit(env,email,'catalogue.direct.edit',id,eventId)}catch{}
 return {ok:true,id,eventId,changed:true,visibility};
}

// Save one reversible creation event before returning the new entry to a
// client. A failed history write also removes the not-yet-used entry.
async function extraRecordCreationUndo(env,email,id){
 let row=null;
 try{
  await nuEnsureJournal(env);
  row=await env.COMMUNITY_DB.prepare('SELECT payload_json,visibility,source_submission_id FROM additional_catalogue_novels WHERE id=?').bind(id).first();
  if(!row||row.source_submission_id!=='')throw Error('The new novel was changed before history was recorded.');
  const eventId=crypto.randomUUID(),snap={
   targetKind:'created',beforeTarget:null,afterTarget:row.payload_json,
   sourceId:null,beforeSourceMarker:'',afterSourceMarker:'reverted-create:'+id,
   beforePrivate:null,afterPrivate:null,beforeVisibility:null,afterVisibility:row.visibility
  };
  await env.COMMUNITY_DB.prepare('INSERT INTO catalogue_edit_events(id,operation,target_id,duplicate_id,before_json,after_json,source_url,actor_email) VALUES(?,?,?,?,?,?,?,?)')
   .bind(eventId,'create',id,null,JSON.stringify(snap),JSON.stringify({target:row.payload_json}),
    nuCanon(JSON.parse(row.payload_json||'{}').nuUrl),email).run();
  return eventId;
 }catch(error){
  // Even if journal initialization failed before the SELECT, roll back the
  // fresh row. A client must never receive "failed" for a live new duplicate.
  if(!row)try{row=await env.COMMUNITY_DB.prepare('SELECT payload_json,visibility,source_submission_id FROM additional_catalogue_novels WHERE id=?').bind(id).first()}catch{}
  if(row?.source_submission_id==='')await env.COMMUNITY_DB.prepare(
   "DELETE FROM additional_catalogue_novels WHERE id=? AND payload_json=? AND visibility=? AND source_submission_id=''"
  ).bind(id,row.payload_json,row.visibility).run().catch(()=>{});
  throw Error('Could not record Undo history for this new entry; creation was not completed. '+String(error.message||error).slice(0,120));
 }
}

async function extraCreateOrReuse(env,url,email,p,visibility){
 const found=await nuFindCandidates(env,url,p,null);
 const safe=[],uncertain=[];
 for(const candidate of found){
  const existing=await nuGetExisting(env,url,candidate.id);
  const current=existing.data;
  const sourceA=nuCanon(p.nuUrl),sourceB=nuCanon(current.nuUrl);
  const sameSource=!!sourceA&&sourceA===sourceB;
  const sameTitle=!!nuIdentity(p.title)&&nuIdentity(p.title)===nuIdentity(current.title);
  const sameAuthor=!!nuIdentity(p.author)&&nuIdentity(p.author)===nuIdentity(current.author);
  const item={id:existing.id,title:current.title,author:current.author||'',kind:existing.kind,
    visibility:existing.kind==='extra'?existing.row.visibility:'published',
    reason:sameSource?'Identical Novel Updates URL':sameTitle?'Matching title':'Related title'};
  // Different canonical series URLs can identify distinct works even if title and author match.
  const conflictingUrls=!!sourceA&&!!sourceB&&sourceA!==sourceB;
  if(!conflictingUrls&&(sameSource||(sameTitle&&sameAuthor)))safe.push(item);
  else uncertain.push(item);
 }
 if(safe.length>1)return {ok:false,needsChoice:true,candidates:safe,
  error:'Several existing entries match this novel. Use Merge duplicates so no EPUBs or edits are lost.'};
 if(safe.length===1){
  const matched=safe[0];
  // Reuse the canonical ID even if the user came through the wrong add form.
  // A private submission cannot silently change an already-published record,
  // and a publish request cannot silently promote an existing private entry.
  if(matched.visibility!==visibility){
   return {ok:true,id:matched.id,reused:true,changed:[],notUpdated:true,
    note:'Existing novel reused. Its '+matched.visibility+' visibility and current metadata were preserved. Edit that existing entry to make changes.'};
  }
  const result=await nuSaveEdit(env,url,email,matched.id,p);
  return {ok:true,id:matched.id,reused:true,eventId:result.eventId,changed:result.changed||[],
   conflicts:result.conflicts||[],note:'Merged with an existing novel. The earlier metadata was preserved; Undo is available in history.'};
 }
 // Ambiguous same-title entries must not be accidentally hidden or overwritten.
 const sameTitle=uncertain.filter(x=>nuIdentity(x.title)===nuIdentity(p.title));
 if(sameTitle.length)return {ok:false,needsChoice:true,candidates:sameTitle,
  error:'A novel with this title already exists. Check the author and Novel Updates URL before adding another.'};
 const id=await extraInsert(env,p,'',visibility,email);
 return {ok:true,id,reused:false};
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
  if(path==='/api/additional/projection-cover'&&method==='GET'&&scope==='private'){
   const id=extraId(new URL(request.url).searchParams.get('id'));
   if(!id||!env.COMMUNITY_IMAGES)return new Response('Not found',{status:404});
   await canonicalEnsurePrivate(env);
   const projection=await env.COMMUNITY_DB.prepare('SELECT cover_key FROM public_novel_projections WHERE novel_id=?').bind(id).first();
   if(!projection?.cover_key)return new Response('Not found',{status:404});
   const file=await env.COMMUNITY_IMAGES.get(projection.cover_key);
   if(!file)return new Response('Not found',{status:404});
   return new Response(file.body,{headers:{'content-type':file.httpMetadata?.contentType||'image/jpeg','cache-control':'private,no-store','x-content-type-options':'nosniff'}});
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
   const p=extraPayload(JSON.parse(extraTxt(fd.get('payload'),18000)||'{}'));
   if(!p.title||!p.author||!p.synopsis||(!p.sourceUrl&&!p.nuUrl&&!p.originalUrl))return extraJson({error:'Provide the title, author, synopsis, and a source URL'},400);
   let coverKey='';if(fd.get('cover') instanceof File&&fd.get('cover').size){if(!p.coverCredit||!p.coverRights)return extraJson({error:'Cover requires source credit and confirmation you can display it'},400);coverKey=await extraPhoto(fd.get('cover'),env);}
   const id=crypto.randomUUID();
   try{await env.COMMUNITY_DB.prepare('INSERT INTO additional_novel_submissions(id,payload_json,cover_key,display_name,contact_email) VALUES (?,?,?,?,?)')
    .bind(id,JSON.stringify(p),coverKey,extraTxt(fd.get('displayName'),80)||'Anonymous',extraTxt(fd.get('contactEmail'),140)).run();}
   catch(e){if(coverKey)await env.COMMUNITY_IMAGES.delete(coverKey);throw e;}
   return extraJson({ok:true,message:'Novel suggested. An editor will review it before publication.'});
  }
  if(path==='/api/admin/additional/submission-cover'&&method==='GET'){
   if(!editor)return new Response('Forbidden',{status:403});
   const id=extraTxt(new URL(request.url).searchParams.get('id'),36);
   if(!/^[0-9a-f-]{36}$/.test(id)||!env.COMMUNITY_IMAGES)return new Response('Not found',{status:404});
   const row=await env.COMMUNITY_DB.prepare('SELECT cover_key FROM additional_novel_submissions WHERE id=?').bind(id).first();
   if(!row?.cover_key||!/^additional-novel-covers\/[a-f0-9-]{36}\.(?:png|jpg|webp)$/.test(row.cover_key))return new Response('Not found',{status:404});
   const obj=await env.COMMUNITY_IMAGES.get(row.cover_key);
   if(!obj)return new Response('Not found',{status:404});
   return new Response(obj.body,{headers:{'content-type':obj.httpMetadata?.contentType||'application/octet-stream','cache-control':'private,no-store','x-content-type-options':'nosniff','x-robots-tag':'noindex,nofollow'}});
  }
  if(path==='/api/admin/additional/submissions'&&method==='GET'){
   if(!editor)return extraJson({error:'Editor access required'},403);
   const rows=await env.COMMUNITY_DB.prepare("SELECT * FROM additional_novel_submissions WHERE status='pending' ORDER BY created_at DESC LIMIT 200").all();
   return extraJson({items:(rows.results||[]).map(r=>({id:r.id,...JSON.parse(r.payload_json),hasCover:!!r.cover_key,displayName:r.display_name,contactEmail:r.contact_email,submittedAt:r.created_at}))});
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
   if(!editor||!extraOrigin(request))return extraJson({error:'Editor permission required'},403);
   const b=await request.json(),p=extraPayload(b),visibility=b.publish===true?'published':'private';
   let result;
   // A contributor can explicitly choose an existing novel from the live
   // duplicate preview. Never let an unconfirmed fuzzy match overwrite data.
   if(b.targetId!==undefined&&b.targetId!==null&&String(b.targetId)!==''){
    const targetId=editionBook(b.targetId);
    if(!targetId)return extraJson({error:'Select a valid existing novel'},400);
    const target=await nuGetExisting(env,new URL(request.url),targetId);
    const candidates=await nuFindCandidates(env,new URL(request.url),p,null);
    const sourceURL=nuCanon(p.nuUrl)||nuCanon(p.sourceUrl);
    const targetURL=nuCanon(target.data.nuUrl)||nuCanon(target.data.sourceUrl);
    const sameSeries=!!sourceURL&&sourceURL===targetURL;
    const conflictingSeries=!!sourceURL&&!!targetURL&&sourceURL!==targetURL;
    const sameTitle=!!nuIdentity(p.title)&&(
     nuIdentity(p.title)===nuIdentity(target.data.title)||
     nuIdentity(p.title)===nuIdentity(target.data.originalTitle));
    const sameAuthor=!!nuIdentity(p.author)&&nuIdentity(p.author)===nuIdentity(target.data.author);
    const safe=!conflictingSeries&&(sameSeries||sameTitle&&sameAuthor);
    if(!safe&&b.confirmIdentity!==true)
     return extraJson({ok:false,needsIdentityConfirmation:true,candidates,
      error:'The title, author, or series URL does not reliably match the chosen novel. Confirm both records refer to the same work before merging.'},409);
    const changed=await nuSaveEdit(env,new URL(request.url),email,targetId,p);
    result={...changed,reused:true,matchedExisting:true,
     visibility:target.kind==='extra'?target.row.visibility:'published',
     note:'Merged into your selected existing novel. Its publication status was preserved. Undo is available.'};
   }else result=await extraCreateOrReuse(env,new URL(request.url),email,p,visibility);
   if(result.ok&&!result.reused)result.eventId=await extraRecordCreationUndo(env,email,result.id);
   return extraJson(result,result.ok?200:409);
  }
  if(path==='/api/admin/additional/bulk'&&method==='POST'){
   if(!owner||!extraOrigin(request))return extraJson({error:'Owner permission required'},403);
   const body=await request.json();if(!Array.isArray(body.novels)||body.novels.length===0||body.novels.length>100)return extraJson({error:'Import 1–100 novels per batch'},400);
   const results=[];
   for(const raw of body.novels){try{
    const p=extraPayload(raw);
    const result=await extraCreateOrReuse(env,new URL(request.url),email,p,body.publish===true?'published':'private');
    if(result.ok&&!result.reused)result.eventId=await extraRecordCreationUndo(env,email,result.id);
    results.push({title:p.title,...result});
   }catch(e){results.push({title:extraTxt(raw?.title,100),error:String(e.message||e),ok:false});}}
   return extraJson({ok:results.every(x=>x.ok),results});
  }
  if(path==='/api/admin/additional/edit'&&method==='POST'){
   if(!editor||!extraOrigin(request))return extraJson({error:'Editor permission required'},403);
   const b=await request.json(),id=extraId(b.id);if(!id)return extraJson({error:'Invalid additional novel ID'},400);
   const row=await env.COMMUNITY_DB.prepare('SELECT * FROM additional_catalogue_novels WHERE id=?').bind(id).first();if(!row)return extraJson({error:'Novel not found'},404);
   if(!b.patch||typeof b.patch!=='object'||Array.isArray(b.patch))return extraJson({error:'Provide the metadata changes to save'},400);
   const vis=b.publish===true?'published':b.publish===false?'private':row.visibility;
   const result=await extraEditWithUndo(env,email,row,b.patch,vis);
   return extraJson(result);
  }
  if(path==='/api/admin/additional/auto-cover'&&method==='POST'){
   if(!editor||!extraOrigin(request))return extraJson({error:'Editor permission required'},403);
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



// Reversible editor reconciliation. Only attached to the authenticated private
// API. Never delete an EPUB-bearing book or publish an extracted EPUB.
async function nuEnsureJournal(env){
 if(!env.COMMUNITY_DB)throw Error('Shared community database unavailable');
 await env.COMMUNITY_DB.prepare("CREATE TABLE IF NOT EXISTS catalogue_edit_events (id TEXT PRIMARY KEY,operation TEXT NOT NULL CHECK(operation IN ('merge','metadata_sync','create')),target_id INTEGER NOT NULL,duplicate_id INTEGER,before_json TEXT NOT NULL,after_json TEXT NOT NULL,source_url TEXT NOT NULL DEFAULT '',actor_email TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,undone_at TEXT,undone_by TEXT NOT NULL DEFAULT '',CHECK(target_id >= 1))").run();
 await env.COMMUNITY_DB.prepare('CREATE INDEX IF NOT EXISTS idx_catalogue_edit_events_recent ON catalogue_edit_events(created_at DESC)').run();
 await env.COMMUNITY_DB.prepare('CREATE INDEX IF NOT EXISTS idx_catalogue_edit_events_target ON catalogue_edit_events(target_id,created_at DESC)').run();
}
const NU_EDITABLE=['title','author','originalTitle','synopsis','genres','tags','contentWarnings','nuUrl','translator','translatorUrl','originalLanguage','translation'];
const NU_LIST_FIELDS=new Set(['genres','tags','contentWarnings']);
const nuIdentity=x=>String(x||'').normalize('NFKD').toLocaleLowerCase()
 .replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]/gu,'');
const nuStoredTitleKey=x=>String(x||'').toLocaleLowerCase().replace(/\s+/g,' ').trim();
const nuCanon=x=>{
 try{const u=new URL(String(x||''));
  if(u.protocol!=='https:'||!['novelupdates.com','www.novelupdates.com'].includes(u.hostname)||u.port||u.username||u.password||u.search||u.hash)return '';
  const m=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/.exec(u.pathname);
  return m?'https://www.novelupdates.com/series/'+m[1]+'/':'';
 }catch{return ''}
};
const nuBlank=x=>x===undefined||x===null||x===''||(Array.isArray(x)&&!x.length);
function nuMergeData(before,source,prefer=[]){
 const choice=new Set(prefer),after={...before},conflicts=[],changed=[];
 for(const key of NU_EDITABLE){
  const incoming=source[key],old=before[key];
  if(nuBlank(incoming))continue;
  if(NU_LIST_FIELDS.has(key)){
   const a=extraTags(old),b=extraTags(incoming);
   const combined=[...a,...b.filter(y=>!a.some(x=>nuIdentity(x)===nuIdentity(y)))].slice(0,100);
   if(JSON.stringify(a)!==JSON.stringify(combined)){after[key]=combined;changed.push(key)}
   continue;
  }
  if(nuBlank(old)||key==='translation'&&old==='unconfirmed'){
   after[key]=incoming;changed.push(key);continue;
  }
  if(String(old)===String(incoming))continue;
  conflicts.push({field:key,current:old,incoming});
  if(choice.has(key)){after[key]=incoming;changed.push(key)}
 }
 if(changed.length){after.metadataReview=true;after.metadataSource=source.metadataSource||'Editorial metadata merge';}
 return {after,conflicts,changed};
}
async function nuBaseCatalogue(env,url){
 const res=await env.ASSETS.fetch(new Request(new URL('/admin/catalogue.json',url.origin)));
 if(!res.ok)throw Error('Original catalogue unavailable');
 const raw=await res.json();return Array.isArray(raw)?raw:(raw.books||[]);
}
// Shared identity identifiers never contain EPUB content, private covers or
// private annotations. The same COMMUNITY_DB key registry serves both sites.
const canonicalPrivateKeys=book=>{
 const series=nuCanon(book?.nuUrl)||nuCanon(book?.sourceUrl);
 const title=nuIdentity(book?.title),author=nuIdentity(book?.author);
 return series?['nu:'+series]:title&&author?['ta:'+title+'|'+author]:[];
};
async function canonicalEnsurePrivate(env){
 await env.COMMUNITY_DB.prepare('CREATE TABLE IF NOT EXISTS canonical_novel_keys (identity_key TEXT PRIMARY KEY,novel_id INTEGER NOT NULL CHECK(novel_id >= 1),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)').run();
 await env.COMMUNITY_DB.prepare('CREATE INDEX IF NOT EXISTS idx_canonical_novel_id ON canonical_novel_keys(novel_id)').run();
 await env.COMMUNITY_DB.prepare('CREATE TABLE IF NOT EXISTS canonical_novel_aliases (source_id INTEGER PRIMARY KEY CHECK(source_id >= 100000),target_id INTEGER NOT NULL CHECK(target_id >= 1),event_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)').run();
 await env.COMMUNITY_DB.prepare('CREATE INDEX IF NOT EXISTS idx_canonical_alias_target ON canonical_novel_aliases(target_id)').run();
 await env.COMMUNITY_DB.prepare("CREATE TABLE IF NOT EXISTS public_novel_projections (novel_id INTEGER PRIMARY KEY CHECK(novel_id >= 100000),payload_json TEXT NOT NULL,cover_key TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
}
async function canonicalPrivateResolve(env,raw){
 let id=editionBook(raw);
 if(!id)return null;
 await canonicalEnsurePrivate(env);
 for(let i=0;i<8;i++){
  const alias=await env.COMMUNITY_DB.prepare('SELECT target_id FROM canonical_novel_aliases WHERE source_id=?').bind(id).first();
  if(!alias)return id;
  if(!editionBook(alias.target_id)||id===Number(alias.target_id))return null;
  id=Number(alias.target_id);
 }
 return null;
}
async function canonicalPrivateDecorate(env,rows){
 await canonicalEnsurePrivate(env);
 const publicRows=await env.COMMUNITY_DB.prepare('SELECT novel_id,payload_json,cover_key FROM public_novel_projections LIMIT 5000').all();
 const byId=new Map((publicRows.results||[]).map(x=>[Number(x.novel_id),x]));
 return rows.map(row=>{
  const privateBook=extraDecorate(row,'private');
  const projection=byId.get(Number(row.id));
  if(!projection||row.visibility==='published')return privateBook;
  let publicFields={};try{publicFields=JSON.parse(projection.payload_json||'{}')}catch{return privateBook}
  const combined=nuMergeData(privateBook,publicFields,[]).after;
  return {...combined,id:row.id,visibility:'private',
   cover:privateBook.cover||(projection.cover_key?'/api/additional/projection-cover?id='+row.id:''),
   coverRights:!!privateBook.cover||(!!projection.cover_key)};
 });
}
async function canonicalPrivateOwner(env,book){
 const keys=canonicalPrivateKeys(book);
 if(!keys.length)return null;
 await canonicalEnsurePrivate(env);
 const where=keys.map(()=>'?').join(',');
 const r=await env.COMMUNITY_DB.prepare('SELECT novel_id FROM canonical_novel_keys WHERE identity_key IN ('+where+')').bind(...keys).all();
 const ids=[...new Set((r.results||[]).map(x=>Number(x.novel_id)))];
 if(ids.length!==1)return ids.length? -1:null;
 return canonicalPrivateResolve(env,ids[0]);
}
async function canonicalPrivateClaim(env,book,id){
 const keys=canonicalPrivateKeys(book),claimed=[];
 if(!keys.length)return {ok:true,claimed};
 await canonicalEnsurePrivate(env);
 for(const key of keys){
  const row=await env.COMMUNITY_DB.prepare('INSERT INTO canonical_novel_keys(identity_key,novel_id) VALUES(?,?) ON CONFLICT DO NOTHING').bind(key,id).run();
  if(row.meta?.changes===1)claimed.push(key);
  const match=await env.COMMUNITY_DB.prepare('SELECT novel_id FROM canonical_novel_keys WHERE identity_key=?').bind(key).first();
  const resolved=await canonicalPrivateResolve(env,match?.novel_id);
  if(Number(resolved)!==id){
   for(const added of claimed)await env.COMMUNITY_DB.prepare('DELETE FROM canonical_novel_keys WHERE identity_key=? AND novel_id=?').bind(added,id).run().catch(()=>{});
   return {ok:false,owner:resolved};
  }
 }
 return {ok:true,claimed};
}

async function nuAdditionalRows(env){
 const list=await env.COMMUNITY_DB.prepare("SELECT * FROM additional_catalogue_novels WHERE source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%' ORDER BY created_at DESC LIMIT 5000").all();
 return list.results||[];
}
function nuAdditionalData(row){
 try{return {...JSON.parse(row.payload_json||'{}'),title:row.title,id:row.id}}catch{return {id:row.id,title:row.title}}
}
async function nuGetExisting(env,url,id){
 const bookId=editionBook(id);
 if(!bookId)throw Error('Choose a valid catalogue ID');
 if(bookId<=962){
  const base=(await nuBaseCatalogue(env,url)).find(x=>x.id===bookId);
  if(!base)throw Error('Original novel not found');
  const row=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(bookId).first();
  let patch={};try{patch=JSON.parse(row?.patch_json||'{}')}catch{throw Error('Published metadata is invalid')}
  return {id:bookId,kind:'seed',base,beforeRaw:row?.patch_json??null,data:{...base,...patch},title:base.title};
 }
 const row=await env.COMMUNITY_DB.prepare('SELECT * FROM additional_catalogue_novels WHERE id=?').bind(bookId).first();
 if(!row)throw Error('Additional novel not found');
 if(String(row.source_submission_id||'').startsWith('merged-into:'))
  throw Error('This is an already-merged duplicate. Undo that merge to edit it separately.');
 return {id:bookId,kind:'extra',row,beforeRaw:row.payload_json,data:nuAdditionalData(row),title:row.title};
}
async function nuFindCandidates(env,url,source,excludedId){
 const key=nuIdentity(source.title),canonical=nuCanon(source.nuUrl)||nuCanon(source.sourceUrl),matches=[];
 const base=await nuBaseCatalogue(env,url),added=await nuAdditionalRows(env);
 // Include existing published editorial changes; a novel's source URL or
 // displayed title may differ from its original static catalogue snapshot.
 const overrides=await env.COMMUNITY_DB.prepare('SELECT novel_id,patch_json FROM published_catalogue_overrides LIMIT 2500').all();
 const edits=new Map();
 for(const row of overrides.results||[]){try{edits.set(Number(row.novel_id),JSON.parse(row.patch_json||'{}'))}catch{}}
 const baseWithEdits=base.map(b=>({...b,...(edits.get(Number(b.id))||{})}));
 const originalKey=nuIdentity(source.originalTitle);
 for(const x of [...baseWithEdits,...added.map(nuAdditionalData)]){
  if(x.id===excludedId)continue;
  const exactTitle=!!key&&(nuIdentity(x.title)===key||nuIdentity(x.originalTitle)===key)
   ||!!originalKey&&(nuIdentity(x.title)===originalKey||nuIdentity(x.originalTitle)===originalKey);
  const exactUrl=!!canonical&&(nuCanon(x.nuUrl)===canonical||nuCanon(x.sourceUrl)===canonical);
  if(exactTitle||exactUrl)matches.push({id:x.id,title:x.title,matchedBy:exactUrl?'Novel Updates URL':'Exact normalized title',kind:x.id<=962?'original':'added'});
 }
 return matches;
}

// Analyze all existing records without changing anything. Only unequivocal
// matches are candidates; files and cover objects must never be orphaned.
async function nuSafeDuplicateScan(env,url){
 const base=await nuBaseCatalogue(env,url),added=await nuAdditionalRows(env);
 const current=(await env.COMMUNITY_DB.prepare('SELECT novel_id,patch_json FROM published_catalogue_overrides LIMIT 5000').all()).results||[];
 const edited=new Map();for(const row of current){try{edited.set(Number(row.novel_id),JSON.parse(row.patch_json||'{}'))}catch{}}
 const items=[
  ...base.map(x=>({...x,...(edited.get(x.id)||{}),kind:'original',visibility:'published'})),
  ...added.map(x=>({...nuAdditionalData(x),kind:'added',visibility:x.visibility,coverKey:x.cover_key||''}))
 ];
 // Only metadata, never EPUB bytes, is inspected here.
 const [extraFiles,originalFiles]=await Promise.all([
  env.DB.prepare('SELECT novel_id AS id FROM additional_epub_editions GROUP BY novel_id').all(),
  env.DB.prepare('SELECT novel_id AS id FROM epub_editions GROUP BY novel_id').all()
 ]);
 const fileIds=new Set([...(extraFiles.results||[]),...(originalFiles.results||[])].map(x=>Number(x.id)));
 const byUrl=new Map(),byTitleAuthor=new Map(),byTitle=new Map();
 const group=(map,key,item)=>{if(!key)return;let a=map.get(key);if(!a){a=[];map.set(key,a)}a.push(item)};
 for(const item of items){
  item.nuKey=nuCanon(item.nuUrl)||nuCanon(item.sourceUrl);
  item.titleKey=nuIdentity(item.title);
  group(byTitle,item.titleKey,item);
  item.authorKey=nuIdentity(item.author);
  item.hasEpub=fileIds.has(Number(item.id));
  group(byUrl,item.nuKey,item);
  if(item.titleKey&&item.authorKey)group(byTitleAuthor,item.titleKey+'|'+item.authorKey,item);
 }
 const proposals=[],skipped=[],seen=new Set();
 const quality=x=>(x.synopsis?8:0)+(extraTags(x.tags).length*2)+extraTags(x.genres).length+
  (x.author?2:0)+(x.nuUrl?3:0);
 const best=(a,b)=>{
  if(a.kind!==b.kind)return a.kind==='original'?a:b;
  if(a.visibility!==b.visibility)return a.visibility==='published'?a:b;
  if(a.hasEpub!==b.hasEpub)return a.hasEpub?a:b;
  return quality(a)!==quality(b)?quality(a)>quality(b)?a:b:Number(a.id)<Number(b.id)?a:b;
 };
 for(const x of items.filter(item=>item.kind==='added')){
  const set=new Map();
  for(const item of [...(byUrl.get(x.nuKey)||[]),...(byTitleAuthor.get(x.titleKey+'|'+x.authorKey)||[])]){
   if(item.id===x.id)continue;
   const equalUrl=!!x.nuKey&&x.nuKey===item.nuKey;
   const equalName=!!x.titleKey&&!!x.authorKey&&x.titleKey===item.titleKey&&x.authorKey===item.authorKey;
   if(!equalUrl&&!equalName)continue;
   if(x.nuKey&&item.nuKey&&x.nuKey!==item.nuKey)continue;
   set.set(item.id,item);
  }
  if(!set.size){
   const tentative=(byTitle.get(x.titleKey)||[]).filter(item=>item.id!==x.id);
   if(tentative.length)skipped.push({id:x.id,title:x.title,
    targetId:tentative.length===1?tentative[0].id:null,
    reason:'Possible title match but author or series URL is missing or conflicts; compare manually'});
   continue;
  }
  if(set.size>1){skipped.push({id:x.id,title:x.title,reason:'More than one possible match; no automatic merge'});continue}
  const y=[...set.values()][0],pair=[x.id,y.id].sort((a,b)=>a-b).join(':');
  if(seen.has(pair))continue;seen.add(pair);
  const target=best(x,y),source=target.id===x.id?y:x;
  if(source.kind!=='added')continue;
  let reason='';
  const privateToOriginal=source.visibility==='private'&&target.kind==='original';
  if(source.visibility!==target.visibility&&!privateToOriginal)
   reason='Private/public visibility differs; automatic merging only supports private into an original public record.';
  let assetSummary={editionCount:0,coverPreserved:!!source.coverKey};
  if(!reason)try{
   const plan=await nuAssetPlan(env,source.id,target.id,{cover_key:source.coverKey});
   assetSummary={editionCount:plan.editions.length,coverPreserved:!!plan.coverKey};
  }catch(error){reason=String(error.message||error).slice(0,190);}
  if(reason){skipped.push({id:source.id,title:source.title,targetId:target.id,reason});continue}
  proposals.push({sourceId:source.id,targetId:target.id,sourceTitle:source.title,
   targetTitle:target.title,privateOnly:privateToOriginal,assets:assetSummary,
   match:x.nuKey&&x.nuKey===y.nuKey?'Exact Novel Updates URL':'Same normalized title and author'});
 }
 return {proposals,skipped};
}

async function nuHasPrivateEpub(env,sourceId){
 if(!env.DB)return true; // Do not hide a duplicate when we cannot inspect files.
 const a=await env.DB.prepare('SELECT id FROM additional_epub_editions WHERE novel_id=? LIMIT 1').bind(sourceId).first();
 const b=await env.DB.prepare('SELECT id FROM epub_editions WHERE novel_id=? LIMIT 1').bind(sourceId).first();
 return !!(a||b);
}
// Metadata-only D1 movement. R2 EPUB bytes are never copied, deleted, exposed,
// or rewritten. One private DB batch is atomic across the two edition tables.
const nuAssetColumns='id,novel_id,label,translator,language,filename,object_key,bytes,uploaded_by,created_at';
const nuAssetSignature=row=>JSON.stringify(Object.fromEntries(
 ['id','label','translator','language','filename','object_key','bytes','uploaded_by','created_at'].map(k=>[k,row[k]])));
async function nuAssetPlan(env,sourceId,targetId,sourceRow){
 if(!sourceId||sourceId<100000||!editionBook(targetId))throw Error('Invalid asset merge IDs');
 await canonicalEnsurePrivate(env);
 // A public projection is distinct from the private source payload.
 // Do not archive its owner until the projected public metadata can be moved
 // with its own Undo history; otherwise the public title would disappear.
 const publicProjection=await env.COMMUNITY_DB.prepare(
  'SELECT novel_id FROM public_novel_projections WHERE novel_id=?'
 ).bind(sourceId).first();
 if(publicProjection)throw Error('This novel has its own public metadata projection. Reconcile the public contribution before archiving its private record.');
 const active=await env.DB.prepare('SELECT id FROM additional_epub_upload_sessions WHERE novel_id=? LIMIT 1').bind(sourceId).first();
 if(active)throw Error('An EPUB upload is still in progress for this duplicate. Finish or cancel it before merging.');
 const legacy=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind('private-epub:'+sourceId).first();
 if(legacy)throw Error('This duplicate has a legacy EPUB attachment that needs a separate transfer.');
 const misplaced=await env.DB.prepare('SELECT id FROM epub_editions WHERE novel_id=? LIMIT 1').bind(sourceId).first();
 if(misplaced)throw Error('An older EPUB record needs reconciliation before merging.');
 const rows=await env.DB.prepare('SELECT '+nuAssetColumns+' FROM additional_epub_editions WHERE novel_id=? ORDER BY id').bind(sourceId).all();
 const editions=rows.results||[];
 if(editions.length>250)throw Error('More than 250 editions. Transfer these in smaller audited batches.');
 return {sourceId,targetId,editions:editions.map(x=>({id:x.id,object_key:x.object_key,signature:nuAssetSignature(x)})),
  coverKey:sourceRow?.cover_key||'',targetTable:targetId<=962?'epub_editions':'additional_epub_editions'};
}
async function nuVerifyAssetPlan(env,plan,undo=false){
 if(!plan?.editions?.length)return;
 const table=undo?plan.targetTable:'additional_epub_editions';
 const id=undo?plan.targetId:plan.sourceId;
 for(const item of plan.editions){
  const row=await env.DB.prepare('SELECT '+nuAssetColumns+' FROM '+table+' WHERE novel_id=? AND id=?').bind(id,item.id).first();
  if(!row||row.object_key!==item.object_key||nuAssetSignature(row)!==item.signature)
   throw Error('A transferred EPUB was changed or removed. Undo the newer change or reconcile this edition first.');
 }
}
async function nuMoveAssetReferences(env,plan,undo=false){
 if(!plan?.editions?.length)return;
 await nuVerifyAssetPlan(env,plan,undo);
 const commands=[];
 for(const item of plan.editions){
  if(plan.targetTable==='epub_editions'){
   const from=undo?'epub_editions':'additional_epub_editions',to=undo?'additional_epub_editions':'epub_editions';
   const origin=undo?plan.targetId:plan.sourceId,dest=undo?plan.sourceId:plan.targetId;
   commands.push(env.DB.prepare('INSERT INTO '+to+' ('+nuAssetColumns+') SELECT id,?,label,translator,language,filename,object_key,bytes,uploaded_by,created_at FROM '+from+' WHERE novel_id=? AND id=? AND object_key=?').bind(dest,origin,item.id,item.object_key));
   commands.push(env.DB.prepare('DELETE FROM '+from+' WHERE novel_id=? AND id=? AND object_key=?').bind(origin,item.id,item.object_key));
  }else{
   const origin=undo?plan.targetId:plan.sourceId,dest=undo?plan.sourceId:plan.targetId;
   commands.push(env.DB.prepare('UPDATE additional_epub_editions SET novel_id=? WHERE novel_id=? AND id=? AND object_key=?').bind(dest,origin,item.id,item.object_key));
  }
 }
 // Cloudflare D1 batch statements execute transactionally, so an insert
 // conflict cannot strand half the editions in the wrong table.
 const results=await env.DB.batch(commands);
 if(results.some((x)=>x.meta&&x.meta.changes!==1))
  throw Error('An edition reference changed during the transfer. Inspect and reconcile before continuing.');
}

async function nuSaveEdit(env,url,email,targetId,source,opts={}){
 if(!env.COMMUNITY_DB||!env.DB)throw Error('Private and shared databases are required');
 await nuEnsureJournal(env);
 const target=await nuGetExisting(env,url,targetId),sourceId=extraId(opts.sourceId);
 if(sourceId===target.id)throw Error('A novel cannot be merged into itself');
 let sourceRow=null;
 if(sourceId){
  sourceRow=await env.COMMUNITY_DB.prepare('SELECT * FROM additional_catalogue_novels WHERE id=?').bind(sourceId).first();
  if(!sourceRow)throw Error('Duplicate entry not found');
  if(String(sourceRow.source_submission_id||'').startsWith('merged-into:'))throw Error('This duplicate was already merged');
  if(await nuHasPrivateEpub(env,sourceId)&&opts.transferAssets!==true)
   throw Error('This duplicate has EPUB editions. Choose asset-safe merging to transfer their references with Undo.');
 }
 // Private duplicates may be merged into ORIGINAL public catalogue IDs, but
 // their details can only alter the private overlay. No private value is
 // copied into published_catalogue_overrides or made accessible publicly.
 const privateSourceOnly=!!sourceRow&&sourceRow.visibility==='private'&&target.kind==='seed';
 const targetVisibility=target.kind==='seed'?'published':target.row.visibility;
 if(sourceRow&&sourceRow.visibility!==targetVisibility&&!privateSourceOnly)
  throw Error('These novels have different visibility. Choose the original public catalogue record to keep private details private.');
 const assetPlan=sourceRow&&opts.transferAssets===true?
  await nuAssetPlan(env,sourceId,target.id,sourceRow):null;
 if(privateSourceOnly&&sourceRow.cover_key&&!assetPlan)
  throw Error('This duplicate has a private cover. Use asset-safe merging to preserve its artwork.');
 const computed=nuMergeData(target.data,source,opts.preferSourceFields||[]);
 const modified=computed.after;
 // Keep source cover assets intact. An editor-driven merge may reuse a
 // licensed/authorized cover, but never deletes either original R2 object.
 const sourceCoverData=sourceRow?nuAdditionalData(sourceRow):null;
 const canShareCover=!!sourceRow?.cover_key&&sourceCoverData?.coverRights===true;
 const canAdoptExtra=!!sourceRow?.cover_key&&target.kind==='extra'&&
  !target.row.cover_key&&sourceRow.visibility===target.row.visibility&&
  (target.row.visibility==='private'||canShareCover);
 const canAdoptSeed=canShareCover&&target.kind==='seed'&&
  sourceRow.visibility==='published'&&!target.data.cover;
 const adoptedCoverKey=canAdoptExtra?sourceRow.cover_key:'';
 if(canAdoptExtra||canAdoptSeed){
  modified.coverRights=sourceCoverData.coverRights===true;
  modified.coverCredit=sourceCoverData.coverCredit||'Source record cover';
  if(canAdoptSeed)modified.cover='/api/additional/cover?id='+sourceId;
 }
 let resultRaw,previousPrivate=null,nextPrivate=null;
 if(target.kind==='seed'){
  const patch={};for(const k of Object.keys(modified)){
   if(k==='id'||k==='visibility')continue;
   if(JSON.stringify(modified[k])!==JSON.stringify(target.base[k])||k==='metadataReview'||k==='metadataSource')
    patch[k]=modified[k];
  }
  resultRaw=privateSourceOnly?target.beforeRaw:JSON.stringify(patch);
  // Keep separately-curated private fields unless they are missing.
  const row=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(target.id).first();
  previousPrivate=row?.patch??null;
  let privateOld={};try{privateOld=JSON.parse(previousPrivate||'{}')}catch{throw Error('Private edit patch invalid')}
  const privateMerged=nuMergeData({...target.base,...privateOld},source,opts.preferSourceFields||[]).after;
  const privatePatch={...privateOld};
  for(const key of [...NU_EDITABLE,'metadataReview','metadataSource'])
   if(Object.prototype.hasOwnProperty.call(privateMerged,key)
     &&(JSON.stringify(privateMerged[key])!==JSON.stringify(target.base[key])||key==='metadataReview'||key==='metadataSource'))
    privatePatch[key]=privateMerged[key];
  if(privateSourceOnly&&sourceRow.cover_key&&!privatePatch.cover&&!target.base.cover){
   privatePatch.cover='/api/additional/cover?id='+sourceId;
   privatePatch.coverCredit=sourceCoverData.coverCredit||'Private duplicate cover (preserved)';
   privatePatch.coverRights=sourceCoverData.coverRights===true;
  }
  nextPrivate=JSON.stringify(privatePatch);
 }else{
  // A source sync must never silently promote a private novel to public.
  resultRaw=JSON.stringify({...target.data,...extraPayload(modified)});
 }
 const eventId=crypto.randomUUID(),oldSourceMarker=sourceRow?.source_submission_id??null;
 const afterSourceMarker=sourceRow?'merged-into:'+target.id:null;
 const stageLinks=sourceId?(await env.COMMUNITY_DB.prepare('SELECT slug,published_id FROM nu_staged_series WHERE published_id=?').bind(sourceId).all()).results||[]:[];
 const snapshot={targetKind:target.kind,beforeTarget:target.beforeRaw,afterTarget:resultRaw,
  privateSourceOnly,sourceId:sourceId||null,beforeSourceMarker:oldSourceMarker,afterSourceMarker,stageLinks,
  assetPlan,aliasCreated:!!sourceRow,
  beforePrivate:previousPrivate,afterPrivate:nextPrivate,
  beforeCoverKey:target.kind==='extra'?(target.row.cover_key||''):null,
  afterCoverKey:target.kind==='extra'?(adoptedCoverKey||target.row.cover_key||''):null};
 if(resultRaw===target.beforeRaw&&!sourceRow)return {ok:true,alreadyUpToDate:true,id:target.id,conflicts:computed.conflicts,changed:[]};
 // Optimistic write rejects subsequent updates since preview was loaded.
 if(opts.expectedBefore!==undefined&&opts.expectedBefore!==target.beforeRaw)
  throw Error('Another editor changed this book. Refresh the preview to resolve the latest conflict.');
 // This write is conditional. A concurrent private edit must not be overwritten.
 // When archiving a private duplicate, the source only affects private D1.
 let privatePrewritten=false;
 if(privateSourceOnly&&nextPrivate!==previousPrivate){
  const writePrivate=previousPrivate===null
   ?await env.DB.prepare('INSERT INTO novel_edits(id,patch) VALUES(?,?) ON CONFLICT DO NOTHING').bind(target.id,nextPrivate).run()
   :await env.DB.prepare('UPDATE novel_edits SET patch=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND patch=?')
      .bind(nextPrivate,target.id,previousPrivate).run();
  if((writePrivate.meta?.changes||0)!==1)throw Error('The private novel was edited concurrently. Refresh and retry.');
  privatePrewritten=true;
 }
 let write;
 if(privateSourceOnly){
  // Synthetic confirmation: public D1 has intentionally not been mutated.
  write={meta:{changes:1}};
 }else if(target.kind==='seed'){
  if(target.beforeRaw===null){
   write=await env.COMMUNITY_DB.prepare(
    'INSERT INTO published_catalogue_overrides(novel_id,patch_json,source_entry_id,published_by) VALUES(?,?,?,?) ON CONFLICT DO NOTHING'
   ).bind(target.id,resultRaw,eventId,email).run();
  }else{
   write=await env.COMMUNITY_DB.prepare(
    'UPDATE published_catalogue_overrides SET patch_json=?,source_entry_id=?,published_by=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?'
   ).bind(resultRaw,eventId,email,target.id,target.beforeRaw).run();
  }
 }else{
  write=await env.COMMUNITY_DB.prepare(
   "UPDATE additional_catalogue_novels SET payload_json=?,title=?,normalized_title=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payload_json=? AND source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%'"
  ).bind(resultRaw,modified.title,nuStoredTitleKey(modified.title),target.id,target.beforeRaw).run();
 }
 if((write.meta?.changes||0)!==1)throw Error('The novel changed while saving. Refresh and retry.');
 let archiveDone=false,coverAdopted=false,assetsMoved=false,aliasCreated=false;
 try{
  if(assetPlan?.editions.length){
   await nuMoveAssetReferences(env,assetPlan);
   assetsMoved=true;
  }
  if(adoptedCoverKey){
   const copied=await env.COMMUNITY_DB.prepare(
    "UPDATE additional_catalogue_novels SET cover_key=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND COALESCE(cover_key,'')='' AND payload_json=?"
   ).bind(adoptedCoverKey,target.id,resultRaw).run();
   if((copied.meta?.changes||0)!==1)throw Error('The target cover changed while merging. Refresh to retry.');
   coverAdopted=true;
  }
  if(sourceRow){
   const arch=await env.COMMUNITY_DB.prepare(
    "UPDATE additional_catalogue_novels SET source_submission_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND source_submission_id=?"
   ).bind(afterSourceMarker,sourceId,oldSourceMarker).run();
   if((arch.meta?.changes||0)!==1)throw Error('Duplicate was changed by another editor. Retry after refresh.');
   archiveDone=true;
   if(stageLinks.length)await env.COMMUNITY_DB.prepare('UPDATE nu_staged_series SET published_id=?,updated_at=CURRENT_TIMESTAMP WHERE published_id=?')
    .bind(target.id,sourceId).run();
   await canonicalEnsurePrivate(env);
   const alias=await env.COMMUNITY_DB.prepare('INSERT INTO canonical_novel_aliases(source_id,target_id,event_id) VALUES(?,?,?) ON CONFLICT DO NOTHING')
    .bind(sourceId,target.id,eventId).run();
   if((alias.meta?.changes||0)!==1)throw Error('A canonical redirect already exists for this duplicate. Retry after resolving it.');
   aliasCreated=true;
  }
  await env.COMMUNITY_DB.prepare(
   'INSERT INTO catalogue_edit_events(id,operation,target_id,duplicate_id,before_json,after_json,source_url,actor_email) VALUES(?,?,?,?,?,?,?,?)'
  ).bind(eventId,sourceId?'merge':'metadata_sync',target.id,sourceId||null,JSON.stringify(snapshot),JSON.stringify({target:resultRaw,sourceMarker:afterSourceMarker}),nuCanon(source.nuUrl),email).run();
 }catch(err){
  // No edit should be left invisible if the audit journal cannot be written.
  if(aliasCreated)await env.COMMUNITY_DB.prepare('DELETE FROM canonical_novel_aliases WHERE source_id=? AND event_id=?').bind(sourceId,eventId).run().catch(()=>{});
  if(assetsMoved)await nuMoveAssetReferences(env,assetPlan,true).catch(e=>console.error('Asset rollback needs recovery',e));
  if(privatePrewritten){
   if(previousPrivate===null)await env.DB.prepare('DELETE FROM novel_edits WHERE id=? AND patch=?')
    .bind(target.id,nextPrivate).run().catch(()=>{});
   else await env.DB.prepare('UPDATE novel_edits SET patch=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND patch=?')
    .bind(previousPrivate,target.id,nextPrivate).run().catch(()=>{});
  }
  if(coverAdopted)await env.COMMUNITY_DB.prepare(
   'UPDATE additional_catalogue_novels SET cover_key=? WHERE id=? AND cover_key=?'
  ).bind(snapshot.beforeCoverKey,target.id,adoptedCoverKey).run().catch(()=>{});
  if(archiveDone){
   await env.COMMUNITY_DB.prepare('UPDATE additional_catalogue_novels SET source_submission_id=? WHERE id=? AND source_submission_id=?')
    .bind(oldSourceMarker,sourceId,afterSourceMarker).run().catch(()=>{});
   for(const stage of stageLinks)await env.COMMUNITY_DB.prepare(
    'UPDATE nu_staged_series SET published_id=? WHERE slug=? AND published_id=?'
   ).bind(stage.published_id,stage.slug,target.id).run().catch(()=>{});
  }
  if(target.kind==='seed'&&!privateSourceOnly){
   if(target.beforeRaw===null)await env.COMMUNITY_DB.prepare('DELETE FROM published_catalogue_overrides WHERE novel_id=? AND patch_json=?').bind(target.id,resultRaw).run().catch(()=>{});
   else await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=? WHERE novel_id=? AND patch_json=?').bind(target.beforeRaw,target.id,resultRaw).run().catch(()=>{});
  }else if(target.kind==='extra')await env.COMMUNITY_DB.prepare('UPDATE additional_catalogue_novels SET payload_json=?,title=?,normalized_title=? WHERE id=? AND payload_json=?').bind(target.beforeRaw,target.title,nuStoredTitleKey(target.title),target.id,resultRaw).run().catch(()=>{});
  throw err;
 }
 let privateSynced=true;
 if(target.kind==='seed'&&!privateSourceOnly&&nextPrivate!==previousPrivate){
  try{
   await env.DB.prepare('INSERT INTO novel_edits(id,patch) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET patch=excluded.patch,updated_at=CURRENT_TIMESTAMP').bind(target.id,nextPrivate).run();
  }catch{privateSynced=false}
 }
 try{await audit(env,email,sourceId?'nu.duplicate.merge':'nu.metadata.sync',target.id,eventId)}catch{}
 return {ok:true,id:target.id,eventId,mergedFrom:sourceId||null,privateOnly:privateSourceOnly,
  conflicts:computed.conflicts,changed:computed.changed,privateSynced,
  movedEditions:assetPlan?.editions?.length||0,coverPreserved:!!sourceRow?.cover_key};
}
async function nuSyncSource(env,url,email,source,options={}){
 const safe=extraPayload({...source,metadataReview:true,metadataSource:source.metadataSource||'Novel Updates source'});
 safe.nuUrl=nuCanon(source.nuUrl);
 if(!safe.nuUrl||safe.title.length<2)throw Error('Use a valid Novel Updates series URL and a title.');
 if(!safe.synopsis&&!safe.genres.length&&!safe.tags.length)
  throw Error('No actual synopsis, genres or tags were retrieved. Nothing was saved.');
 const candidates=await nuFindCandidates(env,url,safe,null);
 const chosen=editionBook(options.targetId),exact=candidates.find(x=>x.id===chosen);
 if(chosen&&!exact&&options.confirmDifferent!==true)
  return {ok:false,needsIdentityConfirmation:true,candidates,selected:chosen,
   message:'The chosen novel does not match the source URL or normalized title. Confirm its identity before merging.'};
 if(!chosen&&candidates.length>1)
  return {ok:false,needsChoice:true,candidates,
   message:'Several catalogue entries match this source. Choose the correct novel instead of making another copy.'};
 const targetId=chosen||(candidates.length===1?candidates[0].id:null);
 if(targetId){
  // A shared title is not proof of a shared work. Different series URLs
  // or conflicting/unknown authors must be checked by an editor.
  const existing=await nuGetExisting(env,url,targetId);
  const a=nuCanon(safe.nuUrl),b=nuCanon(existing.data.nuUrl)||nuCanon(existing.data.sourceUrl);
  const sameSeries=!!a&&a===b;
  const differentSeries=!!a&&!!b&&a!==b;
  const titleMatches=nuIdentity(safe.title)===nuIdentity(existing.data.title)
   ||!!nuIdentity(safe.originalTitle)&&nuIdentity(safe.originalTitle)===nuIdentity(existing.data.originalTitle);
  const authorMatches=!!nuIdentity(safe.author)&&nuIdentity(safe.author)===nuIdentity(existing.data.author);
  if((differentSeries||!sameSeries&&!(titleMatches&&authorMatches))&&options.confirmDifferent!==true)
   return {ok:false,needsIdentityConfirmation:true,selected:targetId,candidates,
    message:'A matching title does not confirm this is the same novel. Check both authors and Novel Updates URLs before combining their metadata.'};
  const result=await nuSaveEdit(env,url,email,targetId,safe,{
   preferSourceFields:options.preferSourceFields||[],expectedBefore:options.expectedBefore
  });
  return {...result,matchedExisting:true,candidates};
 }
 const created=await nuCreateEdited(env,email,safe);
 return {...created,matchedExisting:false,candidates:[]};
}
async function nuCreateEdited(env,email,source){
 await nuEnsureJournal(env);
 const data=extraPayload({...source,metadataReview:true,metadataSource:source.metadataSource||'Novel Updates source'});
 if(data.title.length<2)throw Error('A title is required');
 if(!data.nuUrl)throw Error('Use a canonical Novel Updates series URL');
 const id=await extraInsert(env,data,'','published',email);
 const eventId=crypto.randomUUID(),row=await env.COMMUNITY_DB.prepare('SELECT payload_json FROM additional_catalogue_novels WHERE id=?').bind(id).first();
 const snap={targetKind:'created',beforeTarget:null,afterTarget:row.payload_json,
  sourceId:null,beforeSourceMarker:'',afterSourceMarker:'reverted-create:'+id,
  beforePrivate:null,afterPrivate:null};
 try{
  await env.COMMUNITY_DB.prepare('INSERT INTO catalogue_edit_events(id,operation,target_id,duplicate_id,before_json,after_json,source_url,actor_email) VALUES(?,?,?,?,?,?,?,?)')
   .bind(eventId,'create',id,null,JSON.stringify(snap),JSON.stringify({target:row.payload_json}),data.nuUrl,email).run();
 }catch(e){
  await env.COMMUNITY_DB.prepare("DELETE FROM additional_catalogue_novels WHERE id=? AND payload_json=? AND source_submission_id=''").bind(id,row.payload_json).run().catch(()=>{});
  throw e;
 }
 try{await audit(env,email,'nu.direct.create',id,eventId)}catch{}
 return {ok:true,id,eventId,created:true,changed:NU_EDITABLE.filter(k=>!nuBlank(data[k])),privateSynced:true};
}
async function nuUndoEdit(env,email,eventId){
 await nuEnsureJournal(env);
 const id=String(eventId||'');
 if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Choose a valid change to undo');
 const event=await env.COMMUNITY_DB.prepare('SELECT * FROM catalogue_edit_events WHERE id=?').bind(id).first();
 if(!event)throw Error('Change history entry not found');
 if(event.undone_at)throw Error('This change has already been undone');
 const snap=JSON.parse(event.before_json),targetId=Number(event.target_id);
 if(snap.targetKind==='public_projection'){
  // Public contributors can add metadata to an existing private canonical ID,
  // but Undo must never change the private source record.
  await canonicalEnsurePrivate(env);
  const current=await env.COMMUNITY_DB.prepare('SELECT payload_json,cover_key FROM public_novel_projections WHERE novel_id=?').bind(targetId).first();
  if(current?.payload_json!==snap.afterTarget||(current?.cover_key||'')!==snap.afterCoverKey)
   throw Error('The public projection changed since this contribution. Undo newer edits first.');
  if(snap.beforeTarget===null){
   const deleted=await env.COMMUNITY_DB.prepare('DELETE FROM public_novel_projections WHERE novel_id=? AND payload_json=? AND cover_key=?')
    .bind(targetId,snap.afterTarget,snap.afterCoverKey).run();
   if((deleted.meta?.changes||0)!==1)throw Error('Public metadata changed during Undo.');
  }else{
   const restored=await env.COMMUNITY_DB.prepare('UPDATE public_novel_projections SET payload_json=?,cover_key=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND payload_json=? AND cover_key=?')
    .bind(snap.beforeTarget,snap.beforeCoverKey,targetId,snap.afterTarget,snap.afterCoverKey).run();
   if((restored.meta?.changes||0)!==1)throw Error('Public metadata changed during Undo.');
  }
  await env.COMMUNITY_DB.prepare("UPDATE catalogue_edit_events SET undone_at=CURRENT_TIMESTAMP,undone_by=? WHERE id=? AND undone_at IS NULL")
   .bind(email,id).run();
  return {ok:true,undone:true,eventId:id,targetId,publicProjection:true,privateSourceUnchanged:true};
 }
 if(snap.targetKind==='created'){
  const row=await env.COMMUNITY_DB.prepare('SELECT payload_json,source_submission_id,visibility,cover_key FROM additional_catalogue_novels WHERE id=?').bind(targetId).first();
  if(row?.payload_json!==snap.afterTarget||row.source_submission_id!==''||
     snap.afterVisibility!==undefined&&row.visibility!==snap.afterVisibility)
   throw Error('The new book changed or was published since creation. Undo any later edits first.');
  if(await nuHasPrivateEpub(env,targetId))throw Error('This book now has EPUBs. Unlink or transfer them safely before undoing creation.');
  // The cover originally submitted with this newly created book belongs
  // to the same reversible creation event. Hide the book without deleting the
  // cover object; only block Undo if the cover was subsequently replaced.
  if(row.cover_key&&row.cover_key!==(snap.afterCoverKey||''))
   throw Error('This book has a newer cover. Undo the later cover change first.');
  const result=await env.COMMUNITY_DB.prepare("UPDATE additional_catalogue_novels SET source_submission_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payload_json=? AND source_submission_id=''")
   .bind('reverted-create:'+targetId,targetId,snap.afterTarget).run();
  if((result.meta?.changes||0)!==1)throw Error('Creation changed while undoing; refresh first.');
  await env.COMMUNITY_DB.prepare("UPDATE catalogue_edit_events SET undone_at=CURRENT_TIMESTAMP,undone_by=? WHERE id=? AND undone_at IS NULL").bind(email,id).run();
  try{await audit(env,email,'nu.create.undo',targetId,id)}catch{}
  return {ok:true,undone:true,eventId:id,targetId,hiddenCreated:true,privateSynced:true};
 }
 if(snap.targetKind==='seed'){
  const current=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(targetId).first();
  if((current?.patch_json??null)!==snap.afterTarget)throw Error('The book was edited again. Resolve those newer changes before undoing this one.');
  // Check private state BEFORE bringing the duplicate back. This prevents
  // a partially undone merge if somebody has since edited private fields.
  if(snap.privateSourceOnly&&snap.afterPrivate!==snap.beforePrivate){
   const currentPrivate=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(targetId).first();
   if((currentPrivate?.patch??null)!==snap.afterPrivate)
    throw Error('Private book metadata changed since this merge. Undo the newer change first.');
  }
 }else{
  const row=await env.COMMUNITY_DB.prepare('SELECT payload_json,visibility,cover_key FROM additional_catalogue_novels WHERE id=?').bind(targetId).first();
  if(row?.payload_json!==snap.afterTarget||
    snap.afterVisibility!==undefined&&row.visibility!==snap.afterVisibility||
    snap.afterCoverKey!==undefined&&snap.afterCoverKey!==null&&(row.cover_key||'')!==snap.afterCoverKey)
   throw Error('The book was edited or published again. Undo the newer edit first.');
 }
 if(snap.sourceId){
  const extra=await env.COMMUNITY_DB.prepare('SELECT source_submission_id FROM additional_catalogue_novels WHERE id=?').bind(snap.sourceId).first();
  if(extra?.source_submission_id!==snap.afterSourceMarker)throw Error('The duplicate changed since merging. Undo the newer change first.');
 }
 if(snap.aliasCreated){
  await canonicalEnsurePrivate(env);
  const alias=await env.COMMUNITY_DB.prepare('SELECT target_id,event_id FROM canonical_novel_aliases WHERE source_id=?').bind(snap.sourceId).first();
  if(!alias||Number(alias.target_id)!==targetId||alias.event_id!==id)
   throw Error('The canonical redirect was updated since this merge. Reconcile it before Undo.');
 }
 if(snap.assetPlan?.editions?.length)await nuVerifyAssetPlan(env,snap.assetPlan,true);
 let restoredAssets=false;
 try{
  if(snap.assetPlan?.editions?.length){
   await nuMoveAssetReferences(env,snap.assetPlan,true);
   restoredAssets=true;
  }
 if(snap.targetKind==='seed'){
  if(!snap.privateSourceOnly){
   if(snap.beforeTarget===null)await env.COMMUNITY_DB.prepare('DELETE FROM published_catalogue_overrides WHERE novel_id=? AND patch_json=?').bind(targetId,snap.afterTarget).run();
   else await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?').bind(snap.beforeTarget,targetId,snap.afterTarget).run();
  }
 }else{
  const before=JSON.parse(snap.beforeTarget||'{}');
  let restored;
  const coverChanged=snap.afterCoverKey!==undefined&&snap.afterCoverKey!==null&&snap.beforeCoverKey!==snap.afterCoverKey;
  if(snap.beforeVisibility!==undefined){
   if(coverChanged){
    restored=await env.COMMUNITY_DB.prepare('UPDATE additional_catalogue_novels SET payload_json=?,title=?,normalized_title=?,visibility=?,cover_key=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payload_json=? AND visibility=? AND cover_key=?')
     .bind(snap.beforeTarget,before.title,nuStoredTitleKey(before.title),snap.beforeVisibility,snap.beforeCoverKey,targetId,snap.afterTarget,snap.afterVisibility,snap.afterCoverKey).run();
   }else{
    restored=await env.COMMUNITY_DB.prepare('UPDATE additional_catalogue_novels SET payload_json=?,title=?,normalized_title=?,visibility=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payload_json=? AND visibility=?')
     .bind(snap.beforeTarget,before.title,nuStoredTitleKey(before.title),snap.beforeVisibility,targetId,snap.afterTarget,snap.afterVisibility).run();
   }
  }else{
   if(coverChanged){
    restored=await env.COMMUNITY_DB.prepare('UPDATE additional_catalogue_novels SET payload_json=?,title=?,normalized_title=?,cover_key=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payload_json=? AND cover_key=?')
     .bind(snap.beforeTarget,before.title,nuStoredTitleKey(before.title),snap.beforeCoverKey,targetId,snap.afterTarget,snap.afterCoverKey).run();
   }else{
    restored=await env.COMMUNITY_DB.prepare('UPDATE additional_catalogue_novels SET payload_json=?,title=?,normalized_title=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND payload_json=?')
     .bind(snap.beforeTarget,before.title,nuStoredTitleKey(before.title),targetId,snap.afterTarget).run();
   }
  }
  if((restored.meta?.changes||0)!==1)throw Error('A newer edit changed the record while Undo was running.');
 }
 if(snap.sourceId){
  await env.COMMUNITY_DB.prepare('UPDATE additional_catalogue_novels SET source_submission_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND source_submission_id=?')
   .bind(snap.beforeSourceMarker,snap.sourceId,snap.afterSourceMarker).run();
  for(const stage of snap.stageLinks||[])await env.COMMUNITY_DB.prepare(
   'UPDATE nu_staged_series SET published_id=?,updated_at=CURRENT_TIMESTAMP WHERE slug=? AND published_id=?'
  ).bind(stage.published_id,stage.slug,targetId).run();
  if(snap.aliasCreated)await env.COMMUNITY_DB.prepare('DELETE FROM canonical_novel_aliases WHERE source_id=? AND target_id=? AND event_id=?')
   .bind(snap.sourceId,targetId,id).run();
 }
 await env.COMMUNITY_DB.prepare("UPDATE catalogue_edit_events SET undone_at=CURRENT_TIMESTAMP,undone_by=? WHERE id=? AND undone_at IS NULL").bind(email,id).run();
 // A public contribution may introduce an image reference. Undo revokes its
 // public image endpoint while keeping R2 bytes available for recovery.
 if(snap.targetKind==='seed'){
  try{
   const after=JSON.parse(snap.afterTarget||'{}');
   const before=JSON.parse(snap.beforeTarget||'{}');
   const match=/^\/api\/community\/image\?id=([a-f0-9-]{36})$/.exec(String(after.cover||''));
   if(match&&before.cover!==after.cover){
    await env.COMMUNITY_DB.prepare(
     "UPDATE community_entries SET status='rejected',moderated_by=?,moderated_at=CURRENT_TIMESTAMP WHERE id=? AND scope='public' AND kind='image' AND status='approved'"
    ).bind(email,match[1]).run();
   }
  }catch(e){console.warn('A community cover needs manual access review after Undo',e)}
 }
 let privateSynced=true;
 if(snap.targetKind==='seed'&&snap.afterPrivate!==snap.beforePrivate){
  try{
   const curr=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(targetId).first();
   // Only restore private metadata if no subsequent private editor has changed it.
   if(curr?.patch!==snap.afterPrivate)privateSynced=false;
   else if(snap.beforePrivate===null)await env.DB.prepare('DELETE FROM novel_edits WHERE id=? AND patch=?').bind(targetId,snap.afterPrivate).run();
   else await env.DB.prepare('UPDATE novel_edits SET patch=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND patch=?').bind(snap.beforePrivate,targetId,snap.afterPrivate).run();
  }catch{privateSynced=false}
 }
 try{await audit(env,email,'nu.edit.undo',targetId,id)}catch{}
 return {ok:true,undone:true,eventId:id,targetId,restoredDuplicateId:snap.sourceId||null,privateSynced,
  restoredEditions:snap.assetPlan?.editions?.length||0};
 }catch(err){
  if(restoredAssets)await nuMoveAssetReferences(env,snap.assetPlan,false).catch(e=>console.error('Undo asset compensation needs recovery',e));
  throw err;
 }
}

// Novel Updates master staging: always private. No staging routes are registered on public Worker.
// Run database/NU_STAGING_MIGRATION.sql in COMMUNITY_DB before enabling.
function nuValidSlug(value){const s=String(value||'');return /^[a-z0-9][a-z0-9-]{0,190}$/.test(s)?s:'';}
function nuStageItem(row){
 let p={};try{p=JSON.parse(row.payload_json||'{}')}catch{}
 return {slug:row.slug,title:row.title,author:row.author,nuUrl:row.nu_url,
   coverUrl:row.cover_url,state:row.state,publishedId:row.published_id,
   customLocked:!!row.custom_locked,lastSeenAt:row.last_seen_at,metadata:p};
}
// A private-page NU link import must never write into public catalogue D1.
// Use only matching cached/captured NU data. Preserve manual fields and
// journal changes so an owner/editor can Undo without touching EPUB bytes.
const privateNuPageKey=id=>'private-nu-page:'+id;
function privateNuImageUrl(raw){
 try{
  const u=new URL(String(raw||'').trim());
  const host=u.hostname.toLowerCase();
  if(u.protocol!=='https:'||u.username||u.password||u.port||
     !host.includes('.')||host==='localhost'||host.endsWith('.local')||
     host.endsWith('.internal')||/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)||
     host.includes(':'))return '';
  return u.href.slice(0,850);
 }catch{return ''}
}
async function privateNuBookImport(request,env,email,role){
 if(!isEditor(role)||!sameOrigin(request)||request.method!=='POST')
  return respond({error:'An authorized editor must apply source metadata'},403);
 if(!env.COMMUNITY_DB||!env.DB)return respond({error:'Catalogue storage is unavailable'},503);
 try{
  const body=await getJson(request),id=editionBook(body.id),nuUrl=nuCanon(body.nuUrl);
  if(!id||!nuUrl)return respond({error:'Choose an existing novel and its complete Novel Updates series link'},400);
  const target=await nuGetExisting(env,new URL(request.url),id);
  const current={...target.data};
  if(id<=962){
   const edit=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(id).first();
   if(edit?.patch)try{Object.assign(current,JSON.parse(edit.patch))}catch{}
  }
  const canonicalExisting=nuCanon(current.nuUrl);
  if(canonicalExisting&&canonicalExisting!==nuUrl)
   return respond({error:'This novel already has a different Novel Updates series link. Compare identities before changing it.'},409);
  const candidates=await nuFindCandidates(env,new URL(request.url),{nuUrl,title:''},null);
  const conflict=candidates.find(x=>x.id!==id&&x.matchedBy==='Novel Updates URL');
  if(conflict)return respond({error:'That Novel Updates series is already linked to novel #'+conflict.id+'. Resolve the duplicate instead.'},409);
  const slug=nuUrl.split('/')[4];
  let raw=null,sourceName='',imageUrl='';
  const capture=body.capture;
  if(capture!==undefined){
   if(capture?.source!=='novelupdates-browser-v1'||!capture.novel||
      typeof capture.novel!=='object'||Array.isArray(capture.novel)||
      nuCanon(capture.novel.nuUrl)!==nuUrl)
    return respond({error:'Captured data must come from the same exact Novel Updates series page.'},400);
   raw=capture.novel;sourceName='Novel Updates (browser capture)';
   imageUrl=privateNuImageUrl(raw.coverUrl);
  }else{
   const row=await env.COMMUNITY_DB.prepare('SELECT title,author,nu_url,payload_json,cover_url FROM nu_staged_series WHERE slug=? LIMIT 1').bind(slug).first();
   if(row&&nuCanon(row.nu_url)===nuUrl){
    let fields={};try{fields=JSON.parse(row.payload_json||'{}')}catch{}
    raw={...fields,title:row.title,author:row.author,nuUrl};
    imageUrl=privateNuImageUrl(row.cover_url||fields.coverUrl);
    sourceName='Novel Updates (captured staging)';
   }
  }
  if(raw){
   const titleMatch=!!nuIdentity(raw.title)&&(nuIdentity(raw.title)===nuIdentity(current.title)||
      nuIdentity(raw.title)===nuIdentity(current.originalTitle));
   const authorMatch=!!nuIdentity(raw.author)&&!!nuIdentity(current.author)&&
      nuIdentity(raw.author)===nuIdentity(current.author);
   if(!canonicalExisting&&!(titleMatch&&authorMatch))
    return respond({error:'The source title and author do not both match this novel. Link only after resolving its identity.',
     needsIdentityReview:true},409);
  }
  const key=privateNuPageKey(id);
  const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(key).first();
  let old={};try{old=JSON.parse(row?.value||'{}')}catch{return respond({error:'Existing private metadata is unreadable; nothing changed'},409)}
  const next={...old,nuUrl},changed=[];
  if(old.nuUrl!==nuUrl)changed.push('nuUrl');
  if(raw){
   const synopsis=textField(raw.synopsis,6000),author=textField(raw.author,140),
    originalTitle=textField(raw.originalTitle,210);
   if(synopsis&&!current.synopsis&&!old.synopsis){next.synopsis=synopsis;changed.push('synopsis')}
   if(author&&!current.author&&!old.author){next.author=author;changed.push('author')}
   if(originalTitle&&!current.originalTitle&&!old.originalTitle){next.originalTitle=originalTitle;changed.push('originalTitle')}
   for(const field of ['tags','genres']){
    const oldList=mergeEpubTags(current[field],old[field]);
    const updated=mergeEpubTags(oldList,epubSubjects(raw[field]));
    if(updated.length>oldList.length){
     next[field]=updated;changed.push(field);
    }
   }
   // NU completion is a source observation, not an override of the catalogue's
   // translation status. Preserve any manually curated status and dates.
   const reported=String(raw.nuTranslationSourceStatus||'').trim().slice(0,80);
   if(/^(yes|no|completed|ongoing|fully translated|not fully translated)$/i.test(reported)
      &&!old.nuTranslationSourceStatus){
    next.nuTranslationSourceStatus=reported;
    changed.push('NU translation status reference');
   }
   // Country-of-origin completion is separate from English translation completion.
   const originalStatus=String(raw.nuOriginalSourceStatus||'').trim().slice(0,100);
   if(originalStatus&&/^[\p{L}\p{N}\s,().:–+/-]{1,100}$/u.test(originalStatus)
      &&!old.nuOriginalSourceStatus){
    next.nuOriginalSourceStatus=originalStatus;
    changed.push('NU original publication status');
   }
   const chapters=String(raw.nuChapterSourceText||'').trim().slice(0,120);
   if(chapters&&/^[\p{L}\p{N}\s,().:–+/-]{1,120}$/u.test(chapters)
      &&!old.nuChapterSourceText){
    next.nuChapterSourceText=chapters;
    changed.push('NU chapter reference');
   }
   if(imageUrl){
    next.nuCoverUrl=imageUrl;
    if(!current.cover&&!old.cover){
     const privateCover=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?')
      .bind('private-epub-cover:'+id).first();
     if(!privateCover){
      next.cover=imageUrl;next.privateCover=true;
      next.coverCredit='Novel Updates source image, private reference; rights not verified';
      changed.push('cover');
     }
    }
   }
   next.metadataSource=sourceName+' · private unreviewed import';
   // Existing curator-reviewed fields remain curator-reviewed; imported
   // fields are separately sourced, never represented as editor-approved.
   next.metadataOrigin='nu';
  }
  // When the mobile editor selects fields, import only those fields.
  // Legacy desktop callers without 'fields' retain the existing behavior.
  if(body.fields!==undefined){
   const allowed=new Set(['tags','genres','synopsis','author','originalTitle','cover',
    'nuChapterSourceText','nuTranslationSourceStatus','nuOriginalSourceStatus']);
   if(!Array.isArray(body.fields)||!body.fields.length||body.fields.length>9||
      body.fields.some(field=>!allowed.has(field)))
    return respond({error:'Choose at least one valid metadata field to update.'},400);
   const chosen=new Set(body.fields);
   const mapped={cover:['cover','privateCover','coverCredit','nuCoverUrl'],
    synopsis:['synopsis'],tags:['tags'],genres:['genres'],author:['author'],
    originalTitle:['originalTitle'],nuChapterSourceText:['nuChapterSourceText'],
    nuTranslationSourceStatus:['nuTranslationSourceStatus'],
    nuOriginalSourceStatus:['nuOriginalSourceStatus']};
   const keep=new Set(['nuUrl','metadataSource','metadataOrigin']);
   for(const field of chosen)for(const key of mapped[field])keep.add(key);
   for(const key of Object.keys(next)){
    if(keep.has(key))continue;
    if(Object.prototype.hasOwnProperty.call(old,key))next[key]=old[key];
    else delete next[key];
   }
   const labels={ 'NU translation status reference':'nuTranslationSourceStatus',
    'NU original publication status':'nuOriginalSourceStatus','NU chapter reference':'nuChapterSourceText'};
   const actual=changed.filter(name=>name==='nuUrl'||chosen.has(labels[name]||name));
   changed.splice(0,changed.length,...actual);
   if(!actual.some(v=>v!=='nuUrl')){
    if(Object.prototype.hasOwnProperty.call(old,'metadataSource'))next.metadataSource=old.metadataSource;
    else delete next.metadataSource;
    if(Object.prototype.hasOwnProperty.call(old,'metadataOrigin'))next.metadataOrigin=old.metadataOrigin;
    else delete next.metadataOrigin;
   }
  }
  const changedSource=raw?sourceName:'Novel Updates link only';
  // Preview must be read-only: no write, journal event, or public mutation.
  // Values are included so editors can see exactly what will be imported.
  if(body.preview===true){
   const fields={};
   for(const field of ['nuUrl','synopsis','author','originalTitle','tags','genres',
     'nuTranslationSourceStatus','nuOriginalSourceStatus','nuChapterSourceText','cover']){
    if(JSON.stringify(old[field])!==JSON.stringify(next[field])&&next[field]!==undefined)
     fields[field]=next[field];
   }
   return respond({ok:true,preview:true,id,changed,fields,nuUrl,source:changedSource,
    sourceFound:!!raw,needsCapture:!raw,privateOnly:true,published:false});
  }
  if(JSON.stringify(old)===JSON.stringify(next))return respond({
   ok:true,id,changed:[],nuUrl,source:changedSource,sourceFound:!!raw,
   needsCapture:!raw,privateOnly:true,published:false,message:'No new private details found.'});
  const after=JSON.stringify(next),eventId=crypto.randomUUID();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS epub_metadata_import_events (id TEXT PRIMARY KEY,novel_id INTEGER NOT NULL,setting_key TEXT NOT NULL,before_value TEXT,after_value TEXT NOT NULL,actor_email TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,undone_at TEXT)').run();
  const write=row?await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?')
    .bind(after,key,row.value).run():
    await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING')
    .bind(key,after).run();
  if((write.meta?.changes||0)!==1)return respond({error:'Metadata changed in another tab. Refresh and try again.'},409);
  try{
   await env.DB.prepare('INSERT INTO epub_metadata_import_events(id,novel_id,setting_key,before_value,after_value,actor_email) VALUES(?,?,?,?,?,?)')
    .bind(eventId,id,key,row?.value??null,after,email).run();
  }catch(e){
   if(row)await env.DB.prepare('UPDATE site_settings SET value=? WHERE key=? AND value=?').bind(row.value,key,after).run().catch(()=>{});
   else await env.DB.prepare('DELETE FROM site_settings WHERE key=? AND value=?').bind(key,after).run().catch(()=>{});
   return respond({error:'Could not save an Undo record. The metadata import was rolled back.'},503);
  }
  return respond({ok:true,id,changed,nuUrl,eventId,source:changedSource,
   sourceFound:!!raw,needsCapture:!raw,coverUrl:imageUrl||'',privateOnly:true,published:false});
 }catch(e){return respond({error:textField(e?.message||'Could not import Novel Updates metadata',200)},400)}
}
async function privateNuBookUndo(request,env,email,role){
 if(!isEditor(role)||!sameOrigin(request)||request.method!=='POST')
  return respond({error:'An authorized editor must undo this import'},403);
 if(!env.DB)return respond({error:'Private database unavailable'},503);
 try{
  const body=await getJson(request),eventId=String(body.eventId||'');
  if(!/^[a-f0-9-]{36}$/.test(eventId))return respond({error:'Invalid import event'},400);
  const event=await env.DB.prepare('SELECT * FROM epub_metadata_import_events WHERE id=? AND undone_at IS NULL').bind(eventId).first();
  if(!event||!String(event.setting_key).startsWith('private-nu-page:'))
   return respond({error:'This NU import was not found or already undone'},404);
  if(role!=='owner'&&event.actor_email!==email)
   return respond({error:'Only the original contributor or owner can undo this import'},403);
  const now=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(event.setting_key).first();
  if(now?.value!==event.after_value)return respond({error:'The book changed since that import. Undo newer changes first.'},409);
  const result=event.before_value===null?
   await env.DB.prepare('DELETE FROM site_settings WHERE key=? AND value=?').bind(event.setting_key,event.after_value).run():
   await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?')
    .bind(event.before_value,event.setting_key,event.after_value).run();
  if((result.meta?.changes||0)!==1)return respond({error:'A concurrent edit prevented Undo'},409);
  await env.DB.prepare('UPDATE epub_metadata_import_events SET undone_at=CURRENT_TIMESTAMP WHERE id=? AND undone_at IS NULL').bind(eventId).run();
  return respond({ok:true,id:event.novel_id,undone:true,privateOnly:true});
 }catch(e){return respond({error:textField(e?.message||'Undo failed',190)},400)}
}
async function nuAdminRoutes(request,env,email,role){
 if(!isEditor(role))return respond({error:'Editor permission required'},403);
 if(!env.COMMUNITY_DB)return respond({error:'Shared catalogue database is unavailable'},503);
 const url=new URL(request.url),path=url.pathname,method=request.method.toUpperCase();
 try{
  if(path==='/api/admin/nu/book-import')return privateNuBookImport(request,env,email,role);
  if(path==='/api/admin/nu/book-undo')return privateNuBookUndo(request,env,email,role);


  // Inline Novel Updates link editor for the selected book. Reuse the
  // reversible shared edit journal instead of an untracked private-only save.
  if(path==='/api/admin/nu/link-inline'&&method==='POST'){
   if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
   const b=await getJson(request),id=editionBook(b.id),series=nuCanon(b.nuUrl);
   if(!id)return respond({error:'Select a valid existing novel first'},400);
   if(!series)return respond({error:'Use an individual Novel Updates series URL (https://www.novelupdates.com/series/...)'},400);
   const matches=await nuFindCandidates(env,url,{title:'',nuUrl:series},null);
   const conflict=matches.find(x=>x.id!==id&&x.matchedBy==='Novel Updates URL');
   if(conflict)return respond({error:'This Novel Updates URL is already attached to novel #'+conflict.id+
    '. Open that novel or compare duplicates before linking it to another book.'},409);
   const target=await nuGetExisting(env,url,id);
   const result=await nuSaveEdit(env,url,email,id,
    {nuUrl:series,metadataSource:'Novel Updates link · editor',title:''},
    {preferSourceFields:['nuUrl']});
   return respond({...result,displayTitle:target.title,note:'Novel Updates link saved with Undo history.'});
  }

  if(path==='/api/admin/nu/canonical/backfill'&&method==='POST'){
   if(role!=='owner')return respond({error:'Owner permission required'},403);
   if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
   await canonicalEnsurePrivate(env);
   const base=await nuBaseCatalogue(env,url),rows=await nuAdditionalRows(env);
   const all=[...base,...rows.map(nuAdditionalData)];
   let created=0,already=0,unidentified=0;
   const conflicts=[];
   // Original catalogue IDs win over additional rows when identity keys
   // collide. Never rewrite or merge records during indexing.
   for(const item of all){
    const keys=canonicalPrivateKeys(item);
    if(!keys.length){unidentified++;continue}
    for(const key of keys){
     const result=await env.COMMUNITY_DB.prepare('INSERT INTO canonical_novel_keys(identity_key,novel_id) VALUES(?,?) ON CONFLICT DO NOTHING')
      .bind(key,item.id).run();
     if(result.meta?.changes===1){created++;continue}
     const existing=await env.COMMUNITY_DB.prepare('SELECT novel_id FROM canonical_novel_keys WHERE identity_key=?').bind(key).first();
     if(Number(existing?.novel_id)===Number(item.id)||(await canonicalPrivateResolve(env,existing?.novel_id))===Number(item.id))already++;
     else if(conflicts.length<100)conflicts.push({novelId:item.id,canonicalId:Number(existing?.novel_id),title:item.title||'',reason:'Identity key is already claimed. Compare duplicates before merging.'});
    }
   }
   return respond({ok:true,created,already,unidentified,conflicts,
    note:'Indexed existing canonical identities. No catalogue records, EPUB files, covers or publication settings changed.'});
  }
  if(path==='/api/admin/nu/health'&&method==='GET'){
   if(role!=='owner')return respond({error:'Owner permission required'},403);
   await canonicalEnsurePrivate(env);
   const [base,rows,projections,aliases,keys,epubs,extraEpubs,uploads]=await Promise.all([
    nuBaseCatalogue(env,url),
    nuAdditionalRows(env),
    env.COMMUNITY_DB.prepare('SELECT novel_id FROM public_novel_projections LIMIT 5000').all(),
    env.COMMUNITY_DB.prepare('SELECT source_id,target_id FROM canonical_novel_aliases LIMIT 5000').all(),
    env.COMMUNITY_DB.prepare('SELECT COUNT(*) AS n FROM canonical_novel_keys').first(),
    env.DB.prepare('SELECT novel_id,COUNT(*) AS n FROM epub_editions GROUP BY novel_id').all(),
    env.DB.prepare('SELECT novel_id,COUNT(*) AS n FROM additional_epub_editions GROUP BY novel_id').all(),
    env.DB.prepare('SELECT novel_id,COUNT(*) AS n FROM additional_epub_upload_sessions GROUP BY novel_id').all()
   ]);
   const known=new Set([...base,...rows].map(x=>Number(x.id)));
   const archived=(await env.COMMUNITY_DB.prepare("SELECT id,source_submission_id,cover_key FROM additional_catalogue_novels WHERE source_submission_id LIKE 'merged-into:%' LIMIT 5000").all()).results||[];
   const combined=[...(epubs.results||[]),...(extraEpubs.results||[])];
   const orphaned=combined.filter(x=>!known.has(Number(x.novel_id))&&
    !archived.some(a=>a.id===Number(x.novel_id)));
   const attachedArchived=combined.filter(x=>archived.some(a=>a.id===Number(x.novel_id)));
   const missing=rows.filter(x=>{
    const data=nuAdditionalData(x);
    return !data.synopsis||!extraTags(data.tags).length||!x.cover_key;
   }).slice(0,60).map(x=>{const d=nuAdditionalData(x);return {
    id:x.id,title:x.title,missing:[
     !d.synopsis?'synopsis':null,
     !extraTags(d.tags).length?'tags':null,
     !x.cover_key?'cover':null].filter(Boolean)
   }});
   const scan=await nuSafeDuplicateScan(env,url);
   const projectionIds=new Set((projections.results||[]).map(x=>Number(x.novel_id)));
   return respond({generatedAt:new Date().toISOString(),
    counts:{original:base.length,additional:rows.length,
     private:rows.filter(x=>x.visibility==='private').length,
     published:rows.filter(x=>x.visibility==='published').length,
     publicProjections:projectionIds.size,registeredIdentityKeys:Number(keys?.n)||0,
     canonicalAliases:(aliases.results||[]).length,
     epubEditions:combined.reduce((n,x)=>n+Number(x.n||0),0),
     activeUploads:(uploads.results||[]).reduce((n,x)=>n+Number(x.n||0),0),
     archivedDuplicates:archived.length},
    duplicates:{ready:scan.proposals.length,needsAttention:scan.skipped.length,
     readyItems:scan.proposals.slice(0,35).map(x=>({id:x.sourceId,targetId:x.targetId,title:x.sourceTitle,
      privateOnly:!!x.privateOnly,editions:x.assets?.editionCount||0,cover:!!x.assets?.coverPreserved})),
     skipped:scan.skipped.slice(0,50)},
    assets:{orphanedEditionGroups:orphaned.length,editionsOnArchivedRecords:attachedArchived.length,
     orphaned:orphaned.slice(0,30).map(x=>({id:Number(x.novel_id),count:Number(x.n)})),
     attachedArchived:attachedArchived.slice(0,30).map(x=>({id:Number(x.novel_id),count:Number(x.n)}))},
    incompleteMetadata:missing,
    backups:{databaseExportAvailable:true,epubR2BackupVerified:false,
     note:'A metadata CSV/JSON export does not back up the EPUB R2 bucket. Verify separate D1 and R2 backups.'}
   });
  }
  if(path==='/api/admin/nu/duplicates/scan'&&method==='GET'){
   const scan=await nuSafeDuplicateScan(env,url);
   return respond({ok:true,...scan,count:scan.proposals.length});
  }
  if(path==='/api/admin/nu/duplicates/merge-safe'&&method==='POST'){
   if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
   // One editor action merges a bounded batch of safe duplicates without
   // individual approval clicks. Recheck matches and all safety rules on save.
   const scan=await nuSafeDuplicateScan(env,url),results=[];
   for(const candidate of scan.proposals.slice(0,12)){
    try{
     const source=await nuGetExisting(env,url,candidate.sourceId);
     const target=await nuGetExisting(env,url,candidate.targetId);
     const privateOnly=source.row?.visibility==='private'&&target.kind==='seed';
     if(source.row?.visibility!==(target.kind==='seed'?'published':target.row.visibility)&&!privateOnly)
      throw Error('An unsafe visibility difference prevents this merge.');
     await nuAssetPlan(env,source.id,target.id,source.row);
     const check=await nuFindCandidates(env,url,source.data,source.id);
     if(check.length!==1||check[0].id!==target.id)
      throw Error('Match changed or is ambiguous; nothing was merged');
     const srcUrl=nuCanon(source.data.nuUrl),dstUrl=nuCanon(target.data.nuUrl);
     const sameURL=!!srcUrl&&srcUrl===dstUrl;
     const sameIdentity=nuIdentity(source.data.title)===nuIdentity(target.data.title)&&
      !!nuIdentity(source.data.author)&&nuIdentity(source.data.author)===nuIdentity(target.data.author);
     if(srcUrl&&dstUrl&&srcUrl!==dstUrl||!sameURL&&!sameIdentity)
      throw Error('Source identity no longer matches the destination');
     const merged=await nuSaveEdit(env,url,email,target.id,source.data,{sourceId:source.id,expectedBefore:target.beforeRaw,transferAssets:true});
     results.push({ok:true,sourceId:source.id,targetId:target.id,eventId:merged.eventId,privateOnly:merged.privateOnly,
      movedEditions:merged.movedEditions||0});
    }catch(e){results.push({ok:false,sourceId:candidate.sourceId,targetId:candidate.targetId,
      error:String(e.message||e).slice(0,190)})}
   }
   return respond({ok:true,processed:results.length,merged:results.filter(x=>x.ok).length,
    results,skipped:scan.skipped,remainingMayExist:scan.proposals.length>12,
    note:'All successful merges have independent Undo history records.'});
  }
  // Read-only duplicate preflight used by Add Novels. It sees both the
  // original 962 entries and all active additional entries, including drafts.
  // Actual writes still re-check identity server-side to prevent races.
  if(path==='/api/admin/nu/check-duplicate'&&method==='GET'){
   const source={
    title:extraTxt(url.searchParams.get('title'),210),
    originalTitle:extraTxt(url.searchParams.get('originalTitle'),210),
    author:extraTxt(url.searchParams.get('author'),140),
    nuUrl:extraUrl(url.searchParams.get('nuUrl')),
    sourceUrl:extraUrl(url.searchParams.get('sourceUrl'))
   };
   if(source.title.length<2&&!nuCanon(source.nuUrl)&&!nuCanon(source.sourceUrl))
    return respond({items:[],note:'Enter a title or a Novel Updates series URL.'});
   const matches=await nuFindCandidates(env,url,source,null);
   const entries=[];
   for(const x of matches.slice(0,20)){
    const existing=await nuGetExisting(env,url,x.id);
    entries.push({id:x.id,title:existing.data.title,author:existing.data.author||'',
     kind:existing.kind,visibility:existing.kind==='extra'?existing.row.visibility:'published',
     matchedBy:x.matchedBy,hasSynopsis:!!existing.data.synopsis,
     tagCount:extraTags(existing.data.tags).length});
   }
   return respond({items:entries,total:matches.length,
    note:'Existing entries are reused when a match is unambiguous. Conflicting records can be compared and merged with Undo.'});
  }
  if(path==='/api/admin/nu/search-books'&&method==='GET'){
   const q=String(url.searchParams.get('q')||'').trim().slice(0,120);
   if(q.length<2&&!/^[1-9]\d*$/.test(q))return respond({items:[],note:'Enter at least two characters or an ID'});
   const key=nuIdentity(q);
   const original=await nuBaseCatalogue(env,url),added=await nuAdditionalRows(env);
   const matches=[...original.map(x=>({...x,kind:'original'})),...added.map(x=>({...nuAdditionalData(x),kind:'added'}))]
    .filter(x=>String(x.id)===q||nuIdentity(x.title).includes(key)||nuIdentity(x.originalTitle).includes(key))
    .slice(0,50).map(x=>({id:x.id,title:x.title,kind:x.kind,nuUrl:x.nuUrl||'',
     tags:(x.tags||[]).length,genres:(x.genres||[]).length,hasSynopsis:!!x.synopsis}));
   return respond({items:matches});
  }
  if(path==='/api/admin/nu/merge-history'&&method==='GET'){
   await nuEnsureJournal(env);
   const rows=await env.COMMUNITY_DB.prepare(
    'SELECT id,operation,target_id,duplicate_id,source_url,actor_email,created_at,undone_at FROM catalogue_edit_events ORDER BY created_at DESC LIMIT 40'
   ).all();
   return respond({items:rows.results||[]});
  }
  if(path==='/api/admin/nu/merge-preview'&&method==='GET'){
   const sourceId=extraId(url.searchParams.get('sourceId')),targetId=editionBook(url.searchParams.get('targetId'));
   if(!sourceId||!targetId||sourceId===targetId)return respond({error:'Select different source and destination novel IDs'},400);
   const sourceRow=await env.COMMUNITY_DB.prepare('SELECT * FROM additional_catalogue_novels WHERE id=?').bind(sourceId).first();
   if(!sourceRow)return respond({error:'Source duplicate not found'},404);
   const target=await nuGetExisting(env,url,targetId),data=nuAdditionalData(sourceRow);
   const privateOnly=sourceRow.visibility==='private'&&target.kind==='seed';
   let previewData=target.data;
   if(privateOnly){
    const privateRow=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(targetId).first();
    let privatePatch={};try{privatePatch=JSON.parse(privateRow?.patch||'{}')}catch{throw Error('Invalid private record')}
    previewData={...target.base,...privatePatch};
   }
   const preview=nuMergeData(previewData,data,[]);
   let assetSummary={editionCount:0,coverPreserved:!!sourceRow.cover_key},blockedByAssets='';
   try{
    const plan=await nuAssetPlan(env,sourceId,targetId,sourceRow);
    assetSummary={editionCount:plan.editions.length,coverPreserved:!!plan.coverKey};
   }catch(error){blockedByAssets=String(error.message||error);}
   return respond({source:{id:sourceId,title:data.title,visibility:sourceRow.visibility,fields:data},
    target:{id:target.id,title:target.title,kind:target.kind,fields:target.data},
    alreadyMerged:String(sourceRow.source_submission_id||'').startsWith('merged-into:'),
    blockedByEpub:false,blockedByAssets,assets:assetSummary,privateOnly,
    visibilityConflict:sourceRow.visibility!==(target.kind==='seed'?'published':target.row.visibility)&&!privateOnly,
    changed:preview.changed,conflicts:preview.conflicts,
    expectedBefore:target.beforeRaw});
  }
  if(path==='/api/admin/nu/merge-apply'&&method==='POST'){
   if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
   const b=await getJson(request),sourceId=extraId(b.sourceId),targetId=editionBook(b.targetId);
   if(!sourceId||!targetId||sourceId===targetId)return respond({error:'Select two different existing books'},400);
   const sourceRow=await env.COMMUNITY_DB.prepare('SELECT * FROM additional_catalogue_novels WHERE id=?').bind(sourceId).first();
   if(!sourceRow)return respond({error:'Source book not found'},404);
   const fields=Array.isArray(b.preferSourceFields)?b.preferSourceFields.filter(x=>NU_EDITABLE.includes(x)):[];
   const result=await nuSaveEdit(env,url,email,targetId,nuAdditionalData(sourceRow),{
    sourceId,preferSourceFields:fields,expectedBefore:b.expectedBefore,transferAssets:true
   });
   return respond(result);
  }
  if(path==='/api/admin/nu/undo'&&method==='POST'){
   if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
   const b=await getJson(request);
   return respond(await nuUndoEdit(env,email,b.eventId));
  }
  if(path==='/api/admin/nu/sync-capture'&&method==='POST'){
   if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
   const b=await getJson(request),raw=b.capture?.novel;
   if(b.capture?.source!=='novelupdates-browser-v1'||!raw||typeof raw!=='object'||Array.isArray(raw))
    return respond({error:'Paste the original captured Novel Updates metadata'},400);
   if(raw.tags!==undefined&&!Array.isArray(raw.tags)||raw.genres!==undefined&&!Array.isArray(raw.genres))
    return respond({error:'Source tags and genres must be lists'},400);
   const source={...raw,metadataSource:'Novel Updates (browser capture)'};
   const result=await nuSyncSource(env,url,email,source,{
    targetId:b.targetId,confirmDifferent:b.confirmDifferent===true,
    preferSourceFields:Array.isArray(b.preferSourceFields)?b.preferSourceFields.filter(x=>NU_EDITABLE.includes(x)):[]});
   return respond(result);
  }
  // Keep older Publish-selected clients safe: use the same reversible merge
  // algorithm instead of making a new record beside an existing one.
  if(path==='/api/admin/nu/publish'&&method==='POST'){
   if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
   const b=await getJson(request),slugs=Array.isArray(b.slugs)?[...new Set(b.slugs.map(nuValidSlug).filter(Boolean))]:[];
   if(!slugs.length||slugs.length>20)return respond({error:'Choose 1–20 valid staged series'},400);
   const results=[];
   for(const slug of slugs){
    try{
     const row=await env.COMMUNITY_DB.prepare('SELECT * FROM nu_staged_series WHERE slug=?').bind(slug).first();
     if(!row)throw Error('Staged series not found');
     const source=JSON.parse(row.payload_json||'{}');
     const result=await nuSyncSource(env,url,email,{...source,title:row.title,author:row.author,nuUrl:row.nu_url,
      metadataSource:'Novel Updates (editor sync)'},{});
     if(result.needsChoice||result.needsIdentityConfirmation){
      results.push({slug,error:'Multiple matching novels. Select a destination in Resolve duplicates before syncing.',candidates:result.candidates||[]});
      continue;
     }
     if(!result.ok)throw Error(result.message||'Sync failed');
     await env.COMMUNITY_DB.prepare("UPDATE nu_staged_series SET state='published',published_id=?,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE slug=?")
      .bind(result.id,slug).run();
     results.push({slug,ok:true,id:result.id,linkedExisting:!!result.matchedExisting,eventId:result.eventId||null});
    }catch(e){results.push({slug,error:String(e.message||'Sync failed').slice(0,190)})}
   }
   return respond({ok:true,results});
  }
  if(path==='/api/admin/nu/sync-staged'&&method==='POST'){
   if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
   const b=await getJson(request),slug=nuValidSlug(b.slug);
   if(!slug)return respond({error:'Choose a staged Novel Updates series'},400);
   const row=await env.COMMUNITY_DB.prepare('SELECT * FROM nu_staged_series WHERE slug=?').bind(slug).first();
   if(!row)return respond({error:'Staged series not found'},404);
   const data=JSON.parse(row.payload_json||'{}');
   const result=await nuSyncSource(env,url,email,{...data,title:row.title,author:row.author,nuUrl:row.nu_url,metadataSource:'Novel Updates (editor sync)'},{
    targetId:b.targetId,confirmDifferent:b.confirmDifferent===true,
    preferSourceFields:Array.isArray(b.preferSourceFields)?b.preferSourceFields.filter(x=>NU_EDITABLE.includes(x)):[]});
   if(result.ok&&result.id){
    await env.COMMUNITY_DB.prepare("UPDATE nu_staged_series SET state='published',published_id=?,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE slug=?")
     .bind(result.id,slug).run();
   }
   return respond(result);
  }

  // An editor can import ONLY metadata previously captured from the submitted
  // Novel Updates URL. The guest supplies a URL, never the fields to publish.
  // Source data is staged by our existing fetch / authorized browser capture.
  if(path==='/api/admin/nu/import-submitted-metadata'&&method==='POST'){
   if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
   const body=await getJson(request);
   const submissionId=String(body?.submissionId||'');
   const allowedFields=new Set(['synopsis','tags','genres','author','originalTitle']);
   if(!/^[a-f0-9-]{36}$/.test(submissionId)||body?.confirm!==true
      ||!Array.isArray(body.fields)||body.fields.length>5||!body.fields.length
      ||body.fields.some(field=>!allowedFields.has(field)))
    return respond({error:'Select approved source fields and confirm the import'},400);
   const pending=await env.COMMUNITY_DB.prepare(
     "SELECT id,subject,message,status FROM conservatory_site_feedback WHERE id=? AND scope='public' AND kind='suggestion'"
   ).bind(submissionId).first();
   if(!pending||pending.status!=='pending'||!String(pending.subject||'').startsWith('Novel Updates link: '))
    return respond({error:'Pending Novel Updates link not found'},404);
   const match=/^Novel Updates series: (https:\/\/www\.novelupdates\.com\/series\/([a-z0-9][a-z0-9-]{0,190})\/)\nCatalogue ID: ([1-9][0-9]*)\nCatalogue title: ([^\n]{1,180})(?:\n|$)/.exec(pending.message||'');
   if(!match)return respond({error:'This request is not tied to an existing novel'},409);
   const link=match[1],slug=match[2],novelId=Number(match[3]);
   if(!Number.isSafeInteger(novelId)||novelId<1)return respond({error:'Invalid catalogue ID'},400);
   const staged=await env.COMMUNITY_DB.prepare(
    'SELECT title,author,payload_json,nu_url FROM nu_staged_series WHERE slug=?'
   ).bind(slug).first();
   if(!staged||staged.nu_url!==link)
    return respond({error:'Source metadata has not been retrieved yet. Use Retrieve or authorized Browser Capture first.'},409);
   let saved;try{saved=JSON.parse(staged.payload_json||'{}')}catch{return respond({error:'Source metadata is unreadable'},409)}
   // Never use user-supplied descriptions or tags. The only accepted
   // values come from the existing Novel Updates staging record.
   const source={
    synopsis:extraTxt(saved.synopsis,6000),
    tags:extraTags(saved.tags),
    genres:extraTags(saved.genres),
    author:extraTxt(staged.author||saved.author,140),
    originalTitle:extraTxt(saved.originalTitle,210)
   };
   if(!source.synopsis&&!source.tags.length&&!source.genres.length)
    return respond({error:'No usable synopsis, genres, or tags were retrieved from Novel Updates'},409);
   const chosen=[...new Set(body.fields)];
   const replaceFields=body.replaceFields===true;
   let existing={},prior=null,oldUrl='',name='',record=null,isSeed=novelId<=962;
   if(isSeed){
    const asset=await env.ASSETS.fetch(new Request(new URL('/admin/catalogue.json',url.origin)));
    if(!asset.ok)return respond({error:'Original catalogue unavailable'},503);
    const data=await asset.json(),base=(Array.isArray(data)?data:data.books||[]).find(x=>x.id===novelId);
    if(!base)return respond({error:'Novel not found'},404);
    name=String(base.title||'');
    prior=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(novelId).first();
    let override={};try{if(prior)override=JSON.parse(prior.patch_json)}catch{return respond({error:'Invalid published catalogue patch'},409)}
    existing={...base,...override};
   }else{
    record=await env.COMMUNITY_DB.prepare(
      "SELECT title,payload_json FROM additional_catalogue_novels WHERE id=? AND visibility='published'"
    ).bind(novelId).first();
    if(!record)return respond({error:'Published novel not found'},404);
    name=String(record.title||'');
    try{existing=JSON.parse(record.payload_json||'{}')}catch{return respond({error:'Existing novel metadata is invalid'},409)}
   }
   oldUrl=String(existing.nuUrl||'');
   if(oldUrl&&oldUrl!==link&&body.replaceExisting!==true)
    return respond({error:'This novel already has a Novel Updates link. Confirm replacement before importing metadata.',currentUrl:oldUrl},409);
   const update={},skipped=[];
   for(const field of chosen){
    const value=source[field];
    if(!value||(Array.isArray(value)&&!value.length)){skipped.push(field+' (missing at source)');continue;}
    const current=existing[field],hasCurrent=Array.isArray(current)?current.length>0:typeof current==='string'?!!current.trim():current!==null&&current!==undefined&&current!=='';
    if(hasCurrent&&!replaceFields){skipped.push(field+' (already has metadata)');continue;}
    update[field]=value;
   }
   const fields=Object.keys(update);
   if(!fields.length&&oldUrl===link)
    return respond({error:'All selected fields already have metadata. Choose replacement explicitly if needed.'},409);
   // Do not replace verified cover art, translator credits, translation status,
   // or the novel's title, all of which are distinct from the NU source.
   const patch={...update,nuUrl:link};
   if(fields.length){patch.metadataSource=link;patch.metadataReview='source-reviewed';}
   if(isSeed){
    const old=prior?JSON.parse(prior.patch_json||'{}'):{};
    const val=JSON.stringify({...old,...patch});
    const write=prior?
      await env.COMMUNITY_DB.prepare(
       'UPDATE published_catalogue_overrides SET patch_json=?,source_entry_id=?,published_by=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?'
      ).bind(val,submissionId,email,novelId,prior.patch_json).run():
      await env.COMMUNITY_DB.prepare(
       'INSERT INTO published_catalogue_overrides(novel_id,patch_json,source_entry_id,published_by) VALUES(?,?,?,?) ON CONFLICT DO NOTHING'
      ).bind(novelId,val,submissionId,email).run();
    if((write.meta?.changes||0)!==1)return respond({error:'Another editor changed this novel; refresh before importing'},409);
   }else{
    const val=JSON.stringify({...existing,...patch});
    const write=await env.COMMUNITY_DB.prepare(
     "UPDATE additional_catalogue_novels SET payload_json=? WHERE id=? AND payload_json=? AND visibility='published'"
    ).bind(val,novelId,record.payload_json).run();
    if((write.meta?.changes||0)!==1)return respond({error:'Another editor changed this novel; refresh before importing'},409);
   }
   for(const field of [...fields,...(oldUrl===link?[]:['nuUrl'])]){
    await env.COMMUNITY_DB.prepare(
      'INSERT INTO published_correction_history(id,source_entry_id,novel_id,field_name,published_value,actor_email) VALUES (?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(),submissionId,novelId,field,JSON.stringify(patch[field]),email).run();
   }
   let privateSynced=true;
   if(isSeed){
    try{
     if(!env.DB)throw Error('Private catalogue database unavailable');
     const priorPrivate=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(novelId).first();
     const before=priorPrivate?JSON.parse(priorPrivate.patch||'{}'):{};
     await env.DB.prepare(
      'INSERT INTO novel_edits(id,patch) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET patch=excluded.patch,updated_at=CURRENT_TIMESTAMP'
     ).bind(novelId,JSON.stringify({...before,...patch})).run();
    }catch{privateSynced=false}
   }
   await env.COMMUNITY_DB.prepare(
    "UPDATE conservatory_site_feedback SET status='resolved',moderated_by=?,moderated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'"
   ).bind(email,submissionId).run();
   try{await audit(env,email,'nu.metadata.imported',novelId,fields.join(',')+' from '+link)}catch{}
   return respond({ok:true,novelId,title:name,nuUrl:link,sourceTitle:staged.title,
    appliedFields:fields,skipped,privateSynced,metadataSource:link,
    notice:'Only retrieved Novel Updates fields were imported. No other novel information was changed.'});
  }

  if(path==='/api/admin/nu/apply-submitted-link'&&method==='POST'){
   if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
   const body=await getJson(request),submissionId=String(body?.submissionId||'');
   if(!/^[a-f0-9-]{36}$/.test(submissionId)||body?.confirm!==true)
    return respond({error:'Choose a pending link and confirm the correction'},400);
   const row=await env.COMMUNITY_DB.prepare("SELECT id,subject,message,status FROM conservatory_site_feedback WHERE id=? AND scope='public' AND kind='suggestion'").bind(submissionId).first();
   if(!row||row.status!=='pending'||!String(row.subject||'').startsWith('Novel Updates link: '))
    return respond({error:'Pending Novel Updates request not found'},404);
   const match=/^Novel Updates series: (https:\/\/www\.novelupdates\.com\/series\/([a-z0-9][a-z0-9-]{0,190})\/)\nCatalogue ID: ([1-9][0-9]*)\nCatalogue title: ([^\n]{1,180})(?:\n|$)/.exec(row.message||'');
   if(!match)return respond({error:'This is a new-series suggestion, not an existing-novel correction'},409);
   const novelId=Number(match[3]),link=match[1];
   if(!Number.isSafeInteger(novelId)||novelId<1)return respond({error:'Invalid novel ID'},400);
   let oldUrl='',title='',prior=null,privateSynced=true;
   if(novelId<=962){
    const baseResp=await env.ASSETS.fetch(new Request(new URL('/admin/catalogue.json',url.origin)));
    if(!baseResp.ok)return respond({error:'Catalogue unavailable'},503);
    const catalogue=await baseResp.json(),base=(Array.isArray(catalogue)?catalogue:catalogue.books||[]).find(x=>x.id===novelId);
    if(!base)return respond({error:'Novel not found'},404);
    title=String(base.title||'');
    prior=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(novelId).first();
    let patch={};try{if(prior)patch=JSON.parse(prior.patch_json)}catch{return respond({error:'Invalid current catalogue patch'},409)}
    oldUrl=String(patch.nuUrl||base.nuUrl||'');
    if(oldUrl===link){
     await env.COMMUNITY_DB.prepare("UPDATE conservatory_site_feedback SET status='resolved',moderated_by=?,moderated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(email,submissionId).run();
     return respond({ok:true,alreadyLinked:true,novelId,title,nuUrl:link,privateSynced:true});
    }
    if(oldUrl&&body.replaceExisting!==true)return respond({error:'This novel already has a Novel Updates link. Confirm replacement before approving.',currentUrl:oldUrl},409);
    const val=JSON.stringify({...patch,nuUrl:link});
    const result=prior?await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=?,source_entry_id=?,published_by=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?')
      .bind(val,submissionId,email,novelId,prior.patch_json).run()
     :await env.COMMUNITY_DB.prepare('INSERT INTO published_catalogue_overrides(novel_id,patch_json,source_entry_id,published_by) VALUES (?,?,?,?) ON CONFLICT DO NOTHING')
      .bind(novelId,val,submissionId,email).run();
    if((result.meta?.changes||0)!==1)return respond({error:'Another editor changed this entry. Refresh and retry.'},409);
    if(env.DB){
     try{
      const current=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(novelId).first();
      const priv=current?JSON.parse(current.patch||'{}'):{};
      await env.DB.prepare('INSERT INTO novel_edits(id,patch) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET patch=excluded.patch,updated_at=CURRENT_TIMESTAMP')
        .bind(novelId,JSON.stringify({...priv,nuUrl:link})).run();
     }catch{privateSynced=false}
    }else privateSynced=false;
    await env.COMMUNITY_DB.prepare('INSERT INTO published_correction_history(id,source_entry_id,novel_id,field_name,published_value,actor_email) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(),submissionId,novelId,'nuUrl',JSON.stringify(link),email).run();
   }else{
    const rowBook=await env.COMMUNITY_DB.prepare("SELECT title,payload_json FROM additional_catalogue_novels WHERE id=? AND visibility='published'").bind(novelId).first();
    if(!rowBook)return respond({error:'Published novel not found'},404);
    title=String(rowBook.title||'');
    let obj;try{obj=JSON.parse(rowBook.payload_json||'{}')}catch{return respond({error:'Invalid additional novel metadata'},409)}
    oldUrl=String(obj.nuUrl||'');
    if(oldUrl===link){
     await env.COMMUNITY_DB.prepare("UPDATE conservatory_site_feedback SET status='resolved',moderated_by=?,moderated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(email,submissionId).run();
     return respond({ok:true,alreadyLinked:true,novelId,title,nuUrl:link,privateSynced:true});
    }
    if(oldUrl&&body.replaceExisting!==true)return respond({error:'This novel already has a Novel Updates link. Confirm replacement before approving.',currentUrl:oldUrl},409);
    const updated=await env.COMMUNITY_DB.prepare("UPDATE additional_catalogue_novels SET payload_json=? WHERE id=? AND payload_json=? AND visibility='published'")
     .bind(JSON.stringify({...obj,nuUrl:link}),novelId,rowBook.payload_json).run();
    if((updated.meta?.changes||0)!==1)return respond({error:'Another editor changed the novel. Refresh and retry.'},409);
   }
   await env.COMMUNITY_DB.prepare("UPDATE conservatory_site_feedback SET status='resolved',moderated_by=?,moderated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(email,submissionId).run();
   try{await audit(env,email,'nu.link.correction.approved',novelId,'Submitted link #'+submissionId)}catch{}
   return respond({ok:true,novelId,title,nuUrl:link,replaced:!!oldUrl,privateSynced});
  }
  if(path==='/api/admin/nu/lookup'&&method==='GET'){
   const source=u=>{try{const x=new URL(u);if(x.protocol!=='https:'||x.hostname!=='www.novelupdates.com'||x.port||x.username||x.password||x.search||x.hash||!/^\/series\/[a-z0-9-]+\/?$/.test(x.pathname))return null;return x.href;}catch{return null;}};
   const target=source(url.searchParams.get('url'));
   if(!target)return respond({error:'Enter a valid HTTPS Novel Updates series URL'},400);
   let result;try{result=await fetch(target,{method:'GET',redirect:'manual',headers:{accept:'text/html'},signal:AbortSignal.timeout(12000)});}
   catch{return respond({error:'Novel Updates did not respond. Try again later or use its authorized data export.'},502)}
   if(result.status===403||result.status===429)return respond({error:'Novel Updates rejected the automatic request ('+result.status+'). No bypass is attempted. An authorized export/feed may be required.'},502);
   if(result.status>=300&&result.status<400)return respond({error:'Novel Updates redirected the request; confirm the canonical series URL.'},502);
   if(!result.ok)return respond({error:'Novel Updates returned '+result.status},502);
   const contentType=result.headers.get('content-type')||'';
   if(!/text\/html/i.test(contentType))return respond({error:'Novel Updates did not return an HTML series page'},502);
   if(Number(result.headers.get('content-length')||0)>1500000)return respond({error:'Series page is too large'},502);
   const page=await result.text();if(page.length>1500000)return respond({error:'Series page exceeds the safety limit'},502);
   // Return as JSON to avoid executing any untrusted third-party markup.
   return respond({url:target,html:page,source:'Novel Updates',retrievedAt:new Date().toISOString()});
  }
  if(path==='/api/admin/nu/status'&&method==='GET'){
   const [counts,progress]=await Promise.all([
    env.COMMUNITY_DB.prepare('SELECT state,COUNT(*) AS count FROM nu_staged_series GROUP BY state').all(),
    env.COMMUNITY_DB.prepare("SELECT * FROM nu_import_progress WHERE source='novelupdates'").first()
   ]);
   const result={draft:0,published:0};
   for(const r of counts.results||[])if(r.state in result)result[r.state]=Number(r.count)||0;
   return respond({counts:result,progress:progress||null});
  }
  if(path==='/api/admin/nu/staged-by-url'&&method==='GET'){
   let parsed;try{parsed=new URL(String(url.searchParams.get('url')||''))}catch{return respond({error:'Enter a Novel Updates series URL'},400)}
   const match=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/.exec(parsed.pathname);
   if(parsed.protocol!=='https:'||parsed.hostname!=='www.novelupdates.com'||parsed.port||parsed.username||parsed.password||parsed.search||parsed.hash||!match)
    return respond({error:'Use an exact https://www.novelupdates.com/series/... URL'},400);
   const canonical='https://www.novelupdates.com/series/'+match[1]+'/';
   const row=await env.COMMUNITY_DB.prepare('SELECT title,author,payload_json,nu_url,cover_url,custom_locked FROM nu_staged_series WHERE slug=? LIMIT 1').bind(match[1]).first();
   if(!row)return respond({error:'That Novel Updates series has not been captured yet. Use Capture Novel Updates on the series page, then stage it in the master catalogue.'},404);
   let metadata={};try{metadata=JSON.parse(row.payload_json||'{}')}catch{}
   return respond({metadata:{title:row.title,author:row.author,originalTitle:extraTxt(metadata.originalTitle,210),synopsis:extraTxt(metadata.synopsis,6000),tags:extraTags(metadata.tags),genres:extraTags(metadata.genres),coverUrl:extraUrl(row.cover_url),nuUrl:canonical},source:'Novel Updates (captured)',notice:'This is staged source metadata, not published catalogue content.'});
  }
  if(path==='/api/admin/nu/staging'&&method==='GET'){
   const q=String(url.searchParams.get('q')||'').trim().slice(0,100);
   const state=['draft','published','all'].includes(url.searchParams.get('state'))?url.searchParams.get('state'):'draft';
   const limit=Math.max(1,Math.min(50,Number(url.searchParams.get('limit'))||30));
   const offset=Math.max(0,Math.min(500000,Number(url.searchParams.get('offset'))||0));
   const where=[],args=[];
   if(state!=='all'){where.push('state=?');args.push(state);}
   // Literal substring search. The longest term also tolerates punctuation
   // and curly-apostrophe differences in very long source titles, without using
   // a SQL LIKE/GLOB pattern (which triggered the reported D1_ERROR).
   if(q){
    const terms=q.normalize('NFKD').replace(/\p{M}/gu,'').split(/[^\p{L}\p{N}]+/u).filter(x=>x.length>1);
    const needle=terms.sort((a,b)=>b.length-a.length)[0]||q;
    where.push('(instr(lower(title),lower(?))>0 OR instr(lower(author),lower(?))>0 OR instr(lower(slug),lower(?))>0)');
    args.push(needle,needle,needle);
   }
   const sql=where.length?' WHERE '+where.join(' AND '):'';
   const [total,rows]=await Promise.all([
    env.COMMUNITY_DB.prepare('SELECT COUNT(*) AS n FROM nu_staged_series'+sql).bind(...args).first(),
    env.COMMUNITY_DB.prepare('SELECT * FROM nu_staged_series'+sql+' ORDER BY title COLLATE NOCASE,slug LIMIT ? OFFSET ?').bind(...args,limit,offset).all()
   ]);
   return respond({items:(rows.results||[]).map(nuStageItem),total:Number(total?.n)||0,limit,offset});
  }
  if(path==='/api/admin/nu/stage-browser'&&method==='POST'){
   if(!sameOrigin(request))return respond({error:'Cross-origin submission rejected'},403);
   // This endpoint receives metadata copied by a signed-in Editor from a
   // Novel Updates page that they have opened themselves. It never fetches
   // the external site, reads an EPUB, or exposes private files.
   const body=await getJson(request);
   if(!body||body.source!=='novelupdates-browser-v1'||!body.novel||typeof body.novel!=='object'||Array.isArray(body.novel))
    return respond({error:'Paste metadata copied using the Novel Conservatory bookmarklet'},400);
   const raw=body.novel;
   let u;try{u=new URL(String(raw.nuUrl||''))}catch{return respond({error:'Missing a valid Novel Updates series URL'},400)}
   const slugMatch=/^\/series\/([a-z0-9][a-z0-9-]{0,190})\/?$/.exec(u.pathname);
   if(u.protocol!=='https:'||u.hostname!=='www.novelupdates.com'||u.username||u.password||u.port||u.search||u.hash||!slugMatch)
    return respond({error:'Only canonical HTTPS Novel Updates series URLs are supported'},400);
   const slug=nuValidSlug(slugMatch[1]);
   if(!slug)return respond({error:'Invalid series slug'},400);
   if(!Array.isArray(raw.tags)&&raw.tags!==undefined)return respond({error:'Tags must be a list'},400);
   if(!Array.isArray(raw.genres)&&raw.genres!==undefined)return respond({error:'Genres must be a list'},400);
   const nuUrl='https://www.novelupdates.com/series/'+slug+'/';
   const data=extraPayload({
    title:raw.title,author:raw.author,synopsis:raw.synopsis,
    tags:raw.tags||[],genres:raw.genres||[],originalTitle:raw.originalTitle,
    nuUrl,sourceUrl:nuUrl,metadataSource:'Novel Updates (browser-assisted capture)',
    metadataReview:false
   });
   if(data.title.length<2)return respond({error:'Series title is missing from the copied metadata'},400);
   if(!data.synopsis&&!data.tags.length&&!data.genres.length)
    return respond({error:'No synopsis, genre, or tag was found on the page. Nothing was staged.'},400);
   let coverUrl='';
   try{
    const cover=new URL(String(raw.coverUrl||''));
    if(cover.protocol==='https:'&&!cover.username&&!cover.password&&!cover.port)coverUrl=cover.href.slice(0,900);
   }catch{}
   const prior=await env.COMMUNITY_DB.prepare('SELECT state,custom_locked FROM nu_staged_series WHERE slug=?').bind(slug).first();
   if(prior&&(prior.state==='published'||prior.custom_locked===1))
    return respond({error:prior.state==='published'?'This series is already published; edit the existing entry instead.':'This draft has manually protected changes. Edit the existing staged entry instead.'},409);
   const content=JSON.stringify(data);
   const bytes=new TextEncoder().encode(content+'|'+coverUrl);
   const digest=await crypto.subtle.digest('SHA-256',bytes);
   const hash=Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');
   const change=await env.COMMUNITY_DB.prepare(
    "INSERT INTO nu_staged_series(slug,nu_url,title,author,payload_json,cover_url,source_hash) VALUES(?,?,?,?,?,?,?) "+
    "ON CONFLICT(slug) DO UPDATE SET nu_url=excluded.nu_url,title=excluded.title,author=excluded.author,payload_json=excluded.payload_json,cover_url=excluded.cover_url,source_hash=excluded.source_hash,last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP "+
    "WHERE nu_staged_series.state='draft' AND nu_staged_series.custom_locked=0"
   ).bind(slug,nuUrl,data.title,data.author,content,coverUrl,hash).run();
   if(!change.meta?.changes)return respond({error:'The staged entry was protected or could not be saved'},409);
   await audit(env,email,'nu.stage.browser',slug,nuUrl);
   return respond({ok:true,slug,title:data.title,nuUrl,state:'draft',notice:'Retrieved metadata staged privately. Nothing has been published.'});
  }
  if(method!=='POST'||!['/api/admin/nu/update','/api/admin/nu/publish'].includes(path))
   return respond({error:'Not found'},404);
  if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
  const body=await getJson(request);
  if(path==='/api/admin/nu/update'){
   const slug=nuValidSlug(body.slug);
   const row=slug?await env.COMMUNITY_DB.prepare('SELECT * FROM nu_staged_series WHERE slug=?').bind(slug).first():null;
   if(!row)return respond({error:'Staged novel not found'},404);
   if(row.state==='published')return respond({error:'Already published. Use the live catalogue editor to update published entries.'},409);
   const raw=body.patch&&typeof body.patch==='object'?body.patch:{};
   const allowed=['title','author','synopsis','genres','tags','originalTitle','originalLanguage','novelOrigin','translation'];
   const patch={};for(const k of allowed)if(Object.prototype.hasOwnProperty.call(raw,k))patch[k]=raw[k];
   const p=extraPayload({...JSON.parse(row.payload_json||'{}'),...patch});
   if(p.title.length<2)return respond({error:'Title cannot be empty'},400);
   await env.COMMUNITY_DB.prepare("UPDATE nu_staged_series SET title=?,author=?,payload_json=?,custom_locked=1,updated_at=CURRENT_TIMESTAMP WHERE slug=? AND state='draft'")
     .bind(p.title,p.author,JSON.stringify(p),slug).run();
   await audit(env,email,'nu.staged.edit',slug,'locked from automatic overwrite');
   return respond({ok:true,slug});
  }
  const slugs=Array.isArray(body.slugs)?[...new Set(body.slugs.map(nuValidSlug).filter(Boolean))]:[];
  if(!slugs.length||slugs.length>20)return respond({error:'Choose 1–20 valid staged novels'},400);
  const baseAsset=await env.ASSETS.fetch(new Request(new URL('/admin/catalogue.json',url.origin)));
  const original=baseAsset.ok?await baseAsset.json():[];
  const base=Array.isArray(original)?original:original.books||[];
  const existingByUrl=new Map(),existingByTitle=new Map();
  for(const b of base){
   if(b.nuUrl)existingByUrl.set(String(b.nuUrl).replace(/\/+$/,''),b.id);
   if(b.title)existingByTitle.set(String(b.title).trim().toLowerCase(),b.id);
  }
  const results=[];
  for(const slug of slugs){
   try{
    const row=await env.COMMUNITY_DB.prepare('SELECT * FROM nu_staged_series WHERE slug=?').bind(slug).first();
    if(!row){results.push({slug,error:'Not found'});continue;}
    if(row.state==='published'){results.push({slug,ok:true,alreadyPublished:true,id:row.published_id});continue;}
    const p=extraPayload(JSON.parse(row.payload_json||'{}'));
    if(!p.title||!p.nuUrl)throw Error('Staged title or source URL is missing');
    let existing=existingByUrl.get(p.nuUrl.replace(/\/+$/,''))||null;
    if(!existing){
     const found=await env.COMMUNITY_DB.prepare("SELECT id FROM additional_catalogue_novels WHERE json_extract(payload_json,'$.nuUrl')=? LIMIT 1").bind(p.nuUrl).first();
     existing=found?.id||null;
    }
    if(!existing&&existingByTitle.has(p.title.trim().toLowerCase()))
     throw Error('Already in the original catalogue. Review it manually instead of making a duplicate.');
    let coverKey='';
    if(!existing&&row.cover_url&&env.COMMUNITY_IMAGES){
     try{
      const cover=new URL(row.cover_url);
      if(cover.protocol==='https:'&&(cover.hostname==='novelupdates.com'||cover.hostname.endsWith('.novelupdates.com'))){
       const res=await fetch(cover.href,{redirect:'error',signal:AbortSignal.timeout(7000)});
       const typ=(res.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
       if(res.ok&&['image/jpeg','image/png','image/webp'].includes(typ)&&Number(res.headers.get('content-length')||0)<2800000){
        const bytes=await res.arrayBuffer();
        if(bytes.byteLength<2800000)coverKey=await extraPhoto(new File([bytes],'nu-cover',{type:typ}),env);
       }
      }
     }catch{} // Cover failures must not block authorized catalogue publication.
    }
    let id=existing;
    if(!id){
     try{id=await extraInsert(env,{...p,metadataSource:'Novel Updates (authorized import)',coverRights:!!coverKey,coverCredit:coverKey?'Novel Updates':p.coverCredit},coverKey,'published',email);}
     catch(e){if(coverKey&&env.COMMUNITY_IMAGES)await env.COMMUNITY_IMAGES.delete(coverKey);throw e;}
    }
    await env.COMMUNITY_DB.prepare("UPDATE nu_staged_series SET state='published',published_id=?,published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE slug=? AND state='draft'")
      .bind(id,slug).run();
    await audit(env,email,'nu.publish',slug,String(id));
    results.push({slug,ok:true,id,linkedExisting:!!existing});
   }catch(e){results.push({slug,error:String(e?.message||'Publication failed').slice(0,180)});}
  }
  return respond({ok:true,results});
 }catch(e){
  const msg=String(e?.message||'Staging unavailable');
  if(/no such table.*catalogue_edit_events/i.test(msg))return respond({error:'Run database/CATALOGUE_MERGE_UNDO_MIGRATION.sql in the community D1 database before using Undo.'},503);
  if(/no such table/i.test(msg))return respond({error:'Run the relevant community D1 database migration first: '+msg.slice(0,120)},503);
  return respond({error:msg.slice(0,240)},400);
 }
}

const PRIVATE_EPUB_COVER_KEY='private-epub-cover:';
// EPUB metadata imports are private-only and additive. Do not push embedded
// descriptions, subject tags or fan-translator artwork to the public Worker.
const PRIVATE_EMBEDDED_KEY='private-epub-metadata:';
async function privateEpubLinked(env,id,uuid){
 const bookId=editionBook(id),edition=uuid==='legacy'?'legacy':editionUuid(uuid);
 if(!bookId||!edition)return false;
 if(edition==='legacy'&&bookId<=962){
  const old=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind('private-epub:'+bookId).first();
  return !!old;
 }
 if(edition==='legacy')return false;
 const row=await env.DB.prepare('SELECT id FROM '+editionTable(bookId)+' WHERE novel_id=? AND id=?').bind(bookId,edition).first();
 return !!row;
}
const epubSubjects=value=>Array.isArray(value)?[...new Set(value.filter(x=>typeof x==='string').map(x=>textField(x,70)).filter(Boolean))].slice(0,100):[];
const mergeEpubTags=(a,b)=>{const result=epubSubjects(a),known=new Set(result.map(x=>x.normalize('NFKD').toLowerCase()));
 for(const tag of epubSubjects(b)){
  const key=tag.normalize('NFKD').toLowerCase();
  if(!known.has(key)){result.push(tag);known.add(key)}
  if(result.length>=100)break;
 }
 return result;
};
async function privateEpubIngestRoute(request,env,email,role){
 if(role!=='owner')return respond({error:'Only the owner may import EPUB catalogue metadata'},403);
 if(request.method!=='POST'||!strictOrigin(request))return respond({error:'Invalid import or request origin'},403);
 if(!env.DB)return respond({error:'Private metadata database unavailable'},503);
 try{
  const body=await getJson(request),id=editionBook(body.id),edition=body.editionId==='legacy'?'legacy':editionUuid(body.editionId);
  if(!id||!edition||!await privateEpubLinked(env,id,edition))return respond({error:'First upload the selected EPUB edition to this novel'},409);
  const parsed=body.metadata&&typeof body.metadata==='object'?body.metadata:{};
  let synopsis=textField(parsed.synopsis,6000),tags=epubSubjects(parsed.tags),
   genres=epubSubjects(parsed.genres),author=textField(parsed.author,140);
  let source={};
  if(id<=962){
   const response=await env.ASSETS.fetch(new Request(new URL('/admin/catalogue.json',request.url)));
   if(!response.ok)throw Error('Original catalogue unavailable');
   const books=await response.json(),base=(Array.isArray(books)?books:books.books||[]).find(x=>Number(x.id)===id);
   if(!base)throw Error('Original novel not found');
   const row=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(id).first();
   let patch={};try{patch=JSON.parse(row?.patch||'{}')}catch{throw Error('Existing editorial metadata is unreadable')}
   source={...base,...patch};
  }else{
   if(!env.COMMUNITY_DB)throw Error('Shared novel identity is unavailable');
   const row=await env.COMMUNITY_DB.prepare('SELECT payload_json,title,source_submission_id FROM additional_catalogue_novels WHERE id=?').bind(id).first();
   if(!row||/^(merged-into:|reverted-create:)/.test(String(row.source_submission_id||'')))throw Error('Novel is missing or already merged');
   source={...JSON.parse(row.payload_json||'{}'),title:row.title};
  }
  // An EPUB's dc:identifier or the matched catalogue may carry the exact NU
  // series URL. We only import staged, previously captured NU metadata if
  // the known catalogue URL matches, or if title AND author both agree.
  // We never scrape Novel Updates or infer a series URL from a filename.
  let fromStaged=false,stagedSource='';
  const catalogueNu=nuCanon(source.nuUrl),epubNu=nuCanon(parsed.nuUrl);
  if(catalogueNu&&epubNu&&catalogueNu!==epubNu)
   return respond({error:'EPUB Novel Updates URL conflicts with the existing catalogue. Metadata was not changed.'},409);
  const candidateUrl=catalogueNu||epubNu;
  if(body.enrichFromStaged===true&&candidateUrl&&env.COMMUNITY_DB){
   const slug=candidateUrl.split('/')[4];
   const staged=await env.COMMUNITY_DB.prepare(
    'SELECT title,author,payload_json,nu_url FROM nu_staged_series WHERE slug=? LIMIT 1'
   ).bind(slug).first();
   if(staged&&nuCanon(staged.nu_url)===candidateUrl){
    const sameTitle=nuIdentity(staged.title)===nuIdentity(source.title)||
     nuIdentity(staged.title)===nuIdentity(parsed.title);
    const sameAuthor=!!nuIdentity(staged.author)&&
     (nuIdentity(staged.author)===nuIdentity(source.author)||
      nuIdentity(staged.author)===nuIdentity(parsed.author));
    if(catalogueNu===candidateUrl||sameTitle&&sameAuthor){
     let trusted={};try{trusted=JSON.parse(staged.payload_json||'{}')}catch{}
     // EPUB subjects remain the first source; staged fields only supplement.
     tags=mergeEpubTags(tags,epubSubjects(trusted.tags));
     genres=mergeEpubTags(genres,epubSubjects(trusted.genres));
     synopsis=synopsis||textField(trusted.synopsis,6000);
     author=author||textField(staged.author,140);
     fromStaged=true;stagedSource=candidateUrl;
    }
   }
  }
  if(!synopsis&&!tags.length&&!genres.length&&!author)
   return respond({ok:true,id,changed:[],message:'No usable embedded or confirmed staged metadata.'});
  const key=PRIVATE_EMBEDDED_KEY+id;
  const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(key).first();
  let saved={};try{saved=JSON.parse(row?.value||'{}')}catch{throw Error('Stored embedded metadata is unreadable')}
  const full={...source,...saved},delta={...saved},changed=[];
  if(synopsis&&!full.synopsis){delta.synopsis=synopsis;changed.push('synopsis')}
  if(author&&!full.author){delta.author=author;changed.push('author')}
  if(tags.length){
   const combined=mergeEpubTags(full.tags,tags);
   if(combined.length>mergeEpubTags([],full.tags).length){
    delta.tags=combined;changed.push('tags');
   }
  }
  if(genres.length){
   const combined=mergeEpubTags(full.genres,genres);
   if(combined.length>mergeEpubTags([],full.genres).length){
    delta.genres=combined;changed.push('genres');
   }
  }
  const safeEmbeddedSource=!!epubNu&&!!nuIdentity(parsed.title)&&
   !!nuIdentity(parsed.author)&&nuIdentity(parsed.title)===nuIdentity(source.title)&&
   nuIdentity(parsed.author)===nuIdentity(source.author);
  if(!full.nuUrl&&(fromStaged||safeEmbeddedSource)&&candidateUrl){
   delta.nuUrl=candidateUrl;changed.push('nuUrl');
  }
  if(!changed.length)return respond({ok:true,id,changed:[],message:'Existing hand-edited metadata was kept. No missing details found.'});
  delta.metadataOrigin='epub';delta.metadataSource=fromStaged?
   'EPUB + confirmed captured Novel Updates metadata (private, unreviewed)':
   'Embedded EPUB metadata (private, unreviewed)';
  delta.importedAt=new Date().toISOString();delta.editionId=edition;
  const next=JSON.stringify(delta),eventId=crypto.randomUUID();
  // Each successful automatic change is journaled for owner-controlled Undo.
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS epub_metadata_import_events (id TEXT PRIMARY KEY,novel_id INTEGER NOT NULL,setting_key TEXT NOT NULL,before_value TEXT,after_value TEXT NOT NULL,actor_email TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,undone_at TEXT)').run();
  const write=row?await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?').bind(next,key,row.value).run():
   await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').bind(key,next).run();
  if((write.meta?.changes||0)!==1)return respond({error:'This novel was updated in another tab. Retry the metadata import.'},409);
  try{
   await env.DB.prepare('INSERT INTO epub_metadata_import_events (id,novel_id,setting_key,before_value,after_value,actor_email) VALUES (?,?,?,?,?,?)')
    .bind(eventId,id,key,row?.value??null,next,email).run();
  }catch(err){
   if(row)await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?').bind(row.value,key,next).run().catch(()=>{});
   else await env.DB.prepare('DELETE FROM site_settings WHERE key=? AND value=?').bind(key,next).run().catch(()=>{});
   throw Error('Could not record Undo history for this metadata import.');
  }
  return respond({ok:true,id,changed,eventId,privateOnly:true,published:false,
   stagedSourceUsed:fromStaged,source:delta.metadataSource});
 }catch(error){return respond({error:textField(error?.message||'Could not ingest embedded metadata',200)},400)}
}
// EPUB cover candidates are independent private JPEG assets, one per
// translation edition and image digest. Never copy an EPUB or its R2 key into
// a shared bucket. Public syncing is a separate, permission-gated action.
async function epubCoverEnsure(env){
 await env.DB.prepare("CREATE TABLE IF NOT EXISTS epub_cover_candidates(id TEXT PRIMARY KEY,novel_id INTEGER NOT NULL,edition_id TEXT NOT NULL,object_key TEXT NOT NULL,sha256 TEXT NOT NULL,source_name TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(novel_id,edition_id,sha256))").run();
 await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_epub_cover_candidates_novel ON epub_cover_candidates(novel_id,created_at DESC)').run();
}
const epubCoverJson=(v,status=200)=>editionJson(v,status);
const epubCoverSafe=row=>({id:row.id,novelId:Number(row.novel_id),editionId:row.edition_id,
 source:row.source_name,createdAt:row.created_at,url:'/media/'+row.object_key});
const epubCoverUUID=value=>/^[0-9a-f-]{36}$/.test(String(value||''));
async function privateEpubCoverLibraryRoute(request,env,email,role){
 if(role!=='owner')return epubCoverJson({error:'Only the owner may manage extracted EPUB covers'},403);
 if(!env.DB||!env.IMAGES)return epubCoverJson({error:'Private image storage unavailable'},503);
 const u=new URL(request.url),path=u.pathname,method=request.method.toUpperCase();
 try{
  await epubCoverEnsure(env);
  if(path==='/api/admin/epub-cover-library/list'&&method==='GET'){
   const id=editionBook(u.searchParams.get('id'));
   if(!id)return epubCoverJson({error:'Select a novel'},400);
   const [rows,selected]=await Promise.all([
    env.DB.prepare('SELECT * FROM epub_cover_candidates WHERE novel_id=? ORDER BY created_at DESC,id DESC LIMIT 200').bind(id).all(),
    env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind('private-epub-cover:'+id).first()
   ]);
   let current={};try{current=JSON.parse(selected?.value||'{}')}catch{}
   return epubCoverJson({novelId:id,privateOnly:true,selectedCover:current.cover||'',
    selectedCandidateId:current.candidateId||null,candidates:(rows.results||[]).map(epubCoverSafe)});
  }
  if(path==='/api/admin/epub-cover-library/public-history'&&method==='GET'){
   if(!env.COMMUNITY_DB)return epubCoverJson({error:'Shared catalogue unavailable'},503);
   const id=editionBook(u.searchParams.get('id'));
   if(!id)return epubCoverJson({error:'Select a novel'},400);
   await env.COMMUNITY_DB.prepare("CREATE TABLE IF NOT EXISTS epub_public_cover_sync_events(id TEXT PRIMARY KEY,novel_id INTEGER NOT NULL,kind TEXT NOT NULL,before_json TEXT,after_json TEXT,before_key TEXT NOT NULL DEFAULT '',after_key TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,undone_at TEXT)").run();
   const rows=await env.COMMUNITY_DB.prepare('SELECT id,created_at,undone_at FROM epub_public_cover_sync_events WHERE novel_id=? ORDER BY created_at DESC,id DESC LIMIT 30').bind(id).all();
   return epubCoverJson({novelId:id,history:(rows.results||[]).map(x=>({id:x.id,createdAt:x.created_at,undoneAt:x.undone_at||null}))});
  }
  if(path==='/api/admin/epub-cover-library/upload'&&method==='POST'){
   if(!strictOrigin(request))return epubCoverJson({error:'Invalid request origin'},403);
   const fd=await request.formData(),id=editionBook(fd.get('novelId')),
    edition=String(fd.get('editionId')||''),file=fd.get('image');
   if(!id||!(file instanceof File)||file.type!=='image/jpeg'||file.size<80||file.size>2800000)
    return epubCoverJson({error:'Choose a linked EPUB and JPEG under 2.8 MB'},400);
   if(!await privateEpubLinked(env,id,edition))
    return epubCoverJson({error:'That EPUB edition is not linked to this novel'},409);
   const bytes=await file.arrayBuffer(),v=new Uint8Array(bytes);
   if(v[0]!==255||v[1]!==216||v[2]!==255)return epubCoverJson({error:'Invalid JPEG'},415);
   const digest=await crypto.subtle.digest('SHA-256',bytes);
   const hash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
   const existing=await env.DB.prepare('SELECT * FROM epub_cover_candidates WHERE novel_id=? AND edition_id=? AND sha256=?')
     .bind(id,edition,hash).first();
   if(existing)return epubCoverJson({ok:true,saved:false,existing:true,candidate:epubCoverSafe(existing),privateOnly:true});
   const candidateId=crypto.randomUUID(),key=candidateId+'.jpg',source=textField(fd.get('source'),160);
   await env.IMAGES.put(key,bytes,{httpMetadata:{contentType:'image/jpeg'}});
   try{
    const write=await env.DB.prepare('INSERT INTO epub_cover_candidates(id,novel_id,edition_id,object_key,sha256,source_name) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING')
     .bind(candidateId,id,edition,key,hash,source).run();
    if((write.meta?.changes||0)!==1){
     await env.IMAGES.delete(key).catch(()=>{});
     const found=await env.DB.prepare('SELECT * FROM epub_cover_candidates WHERE novel_id=? AND edition_id=? AND sha256=?').bind(id,edition,hash).first();
     return found?epubCoverJson({ok:true,saved:false,existing:true,candidate:epubCoverSafe(found),privateOnly:true}):
      epubCoverJson({error:'Concurrent image import. Retry.'},409);
    }
    return epubCoverJson({ok:true,saved:true,privateOnly:true,publicPublished:false,
     candidate:{id:candidateId,novelId:id,editionId:edition,source,url:'/media/'+key}});
   }catch(e){await env.IMAGES.delete(key).catch(()=>{});throw e;}
  }
  if(method!=='POST'||!strictOrigin(request))return epubCoverJson({error:'Not found'},404);
  const body=await getJson(request);
  if(path==='/api/admin/epub-cover-library/select'){
   const candidate=epubCoverUUID(body.candidateId)?
    await env.DB.prepare('SELECT * FROM epub_cover_candidates WHERE id=?').bind(String(body.candidateId)).first():null;
   if(!candidate)return epubCoverJson({error:'Private cover option not found'},404);
   const id=Number(candidate.novel_id),key='private-epub-cover:'+id;
   const old=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(key).first();
   const after=JSON.stringify({cover:'/media/'+candidate.object_key,candidateId:candidate.id,
    selectedByOwner:true,privateCover:true,coverRights:false,
    coverCredit:'Private EPUB artwork; public permission not yet confirmed',scope:'private'});
   if(after===old?.value)return epubCoverJson({ok:true,unchanged:true,privateOnly:true});
   const eventId=crypto.randomUUID();
   await env.DB.prepare('CREATE TABLE IF NOT EXISTS epub_metadata_import_events(id TEXT PRIMARY KEY,novel_id INTEGER NOT NULL,setting_key TEXT NOT NULL,before_value TEXT,after_value TEXT NOT NULL,actor_email TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,undone_at TEXT)').run();
   const wrote=old?
    await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?').bind(after,key,old.value).run():
    await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT DO NOTHING').bind(key,after).run();
   if((wrote.meta?.changes||0)!==1)return epubCoverJson({error:'Cover changed concurrently. Refresh.'},409);
   try{
    await env.DB.prepare('INSERT INTO epub_metadata_import_events(id,novel_id,setting_key,before_value,after_value,actor_email) VALUES(?,?,?,?,?,?)')
     .bind(eventId,id,key,old?.value??null,after,email).run();
   }catch(e){
    if(old)await env.DB.prepare('UPDATE site_settings SET value=? WHERE key=? AND value=?').bind(old.value,key,after).run().catch(()=>{});
    else await env.DB.prepare('DELETE FROM site_settings WHERE key=? AND value=?').bind(key,after).run().catch(()=>{});
    return epubCoverJson({error:'Could not save Undo history; selection reverted'},503);
   }
   return epubCoverJson({ok:true,privateOnly:true,publicPublished:false,cover:'/media/'+candidate.object_key,eventId,novelId:id});
  }
  if(path==='/api/admin/epub-cover-library/publish'||path==='/api/admin/epub-cover-library/undo-public')
   return epubCoverPublicAction(request,env,email,path,body);
  return epubCoverJson({error:'Unknown cover action'},404);
 }catch(e){return epubCoverJson({error:'Cover library: '+String(e.message||e).slice(0,180)},400)}
}

// Public cover publication is a deliberate action. The private EPUB is never
// fetched here. Only one verified, isolated JPEG candidate is copied after
// the owner checks permissions and supplies a meaningful credit.
async function epubCoverPublicAction(request,env,email,path,body){
 if(!env.COMMUNITY_DB||!env.COMMUNITY_IMAGES)
  return epubCoverJson({error:'Shared catalogue and public artwork storage are required'},503);
 await env.COMMUNITY_DB.prepare("CREATE TABLE IF NOT EXISTS epub_public_cover_sync_events(id TEXT PRIMARY KEY,novel_id INTEGER NOT NULL,kind TEXT NOT NULL,before_json TEXT,after_json TEXT,before_key TEXT NOT NULL DEFAULT '',after_key TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,undone_at TEXT)").run();
 if(path==='/api/admin/epub-cover-library/undo-public'){
  const id=String(body.eventId||'');
  if(!epubCoverUUID(id))return epubCoverJson({error:'Invalid publication event'},400);
  const event=await env.COMMUNITY_DB.prepare('SELECT * FROM epub_public_cover_sync_events WHERE id=? AND undone_at IS NULL').bind(id).first();
  if(!event)return epubCoverJson({error:'Public cover event missing or already undone'},404);
  let restored;
  if(event.kind==='seed'){
   const current=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(event.novel_id).first();
   if(current?.patch_json!==event.after_json)
    return epubCoverJson({error:'Another editor changed this public book. Undo newer edits first.'},409);
   restored=event.before_json===null?
    await env.COMMUNITY_DB.prepare('DELETE FROM published_catalogue_overrides WHERE novel_id=? AND patch_json=?').bind(event.novel_id,event.after_json).run():
    await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?').bind(event.before_json,event.novel_id,event.after_json).run();
  }else if(event.kind==='additional'){
   const row=await env.COMMUNITY_DB.prepare('SELECT cover_key,payload_json FROM additional_catalogue_novels WHERE id=?').bind(event.novel_id).first();
   if(row?.cover_key!==event.after_key||row.payload_json!==event.after_json)
    return epubCoverJson({error:'This public book changed after the cover sync. Undo newer edits first.'},409);
   restored=await env.COMMUNITY_DB.prepare('UPDATE additional_catalogue_novels SET cover_key=?,payload_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND cover_key=? AND payload_json=?')
    .bind(event.before_key,event.before_json,event.novel_id,event.after_key,event.after_json).run();
  }else return epubCoverJson({error:'Unknown cover event type'},409);
  if((restored.meta?.changes||0)!==1)
   return epubCoverJson({error:'A concurrent public edit prevented safe Undo'},409);
  await env.COMMUNITY_DB.prepare('UPDATE epub_public_cover_sync_events SET undone_at=CURRENT_TIMESTAMP WHERE id=? AND undone_at IS NULL').bind(id).run();
  // The private JPEG is never deleted by public Undo.
  let publicImageRetired=true;
  try{
   await env.COMMUNITY_DB.prepare("DELETE FROM community_entries WHERE id=? AND image_key=? AND kind='image'").bind(id,event.after_key).run();
   await env.COMMUNITY_IMAGES.delete(event.after_key);
  }catch(e){publicImageRetired=false}
  return epubCoverJson({ok:true,undone:true,publicImageRetired,novelId:event.novel_id,
   privateCandidatesUntouched:true,privateEpubsUntouched:true});
 }
 if(path!=='/api/admin/epub-cover-library/publish')
  return epubCoverJson({error:'Unknown cover publication action'},404);
 if(body.rightsConfirmed!==true||String(body.artistCredit||'').trim().length<3)
  return epubCoverJson({error:'Confirm public-display rights and provide an artist/source credit'},400);
 const id=String(body.candidateId||'');
 const candidate=epubCoverUUID(id)?await env.DB.prepare('SELECT * FROM epub_cover_candidates WHERE id=?').bind(id).first():null;
 if(!candidate)return epubCoverJson({error:'Private cover candidate not found'},404);
 const novelId=Number(candidate.novel_id);
 const source=await env.IMAGES.get(candidate.object_key);
 if(!source||source.size>2800000||source.size<80)
  return epubCoverJson({error:'Private image missing or outside size limits'},404);
 let kind='seed',current=null;
 if(novelId>962){
  kind='additional';
  current=await env.COMMUNITY_DB.prepare('SELECT cover_key,payload_json,visibility FROM additional_catalogue_novels WHERE id=?').bind(novelId).first();
  if(!current||current.visibility!=='published')
   return epubCoverJson({error:'This novel is private. Publish a public-safe catalogue entry before sharing its cover.'},409);
 }else{
  current=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(novelId).first();
 }
 const bytes=await source.arrayBuffer(),v=new Uint8Array(bytes);
 if(v[0]!==255||v[1]!==216||v[2]!==255)
  return epubCoverJson({error:'Stored private image failed JPEG validation'},415);
 const eventId=crypto.randomUUID(),imageKey='community-submissions/'+eventId+'.jpg';
 const credit=textField(body.artistCredit,150);
 let before=null,after='',beforeKey='',published=false;
 await env.COMMUNITY_IMAGES.put(imageKey,bytes,{httpMetadata:{contentType:'image/jpeg'}});
 try{
  if(kind==='seed'){
   before=current?.patch_json??null;
   let fields={};try{fields=JSON.parse(before||'{}')}catch{throw Error('Public metadata was unreadable')}
   after=JSON.stringify({...fields,cover:'/api/community/image?id='+eventId,coverCredit:credit,coverRights:true});
  }else{
   before=current.payload_json;beforeKey=current.cover_key||'';
   let fields={};try{fields=JSON.parse(before||'{}')}catch{throw Error('Public metadata was unreadable')}
   after=JSON.stringify({...fields,coverCredit:credit,coverRights:true});
  }
  await env.COMMUNITY_DB.prepare('INSERT INTO community_entries(id,scope,novel_id,kind,display_name,author_identity,body,rating,spoiler,tags_json,external_url,image_key,image_credit,parent_id,status,moderated_by,moderated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
   .bind(eventId,'public',novelId,'image','Owner-selected EPUB cover',email,'Owner confirms public display permission; no EPUB content copied',null,0,'["__epub_owner_cover_sync__"]','',imageKey,credit,'','approved',email).run();
  const result=kind==='seed'?
    before===null?
     await env.COMMUNITY_DB.prepare('INSERT INTO published_catalogue_overrides(novel_id,patch_json,source_entry_id,published_by) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
      .bind(novelId,after,eventId,email).run():
     await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND patch_json=?')
      .bind(after,novelId,before).run():
    await env.COMMUNITY_DB.prepare("UPDATE additional_catalogue_novels SET cover_key=?,payload_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND COALESCE(cover_key,'')=? AND payload_json=? AND visibility='published'")
     .bind(imageKey,after,novelId,beforeKey,before).run();
  if((result.meta?.changes||0)!==1)throw Error('Another editor changed the public record. Refresh.');
  published=true;
  await env.COMMUNITY_DB.prepare('INSERT INTO epub_public_cover_sync_events(id,novel_id,kind,before_json,after_json,before_key,after_key) VALUES(?,?,?,?,?,?,?)')
   .bind(eventId,novelId,kind,before,after,beforeKey,imageKey).run();
  try{await audit(env,email,'epub.private_cover.public_sync',novelId,eventId)}catch{}
  return epubCoverJson({ok:true,novelId,eventId,publicPublished:true,sourceCredit:credit,
   cover:kind==='seed'?'/api/community/image?id='+eventId:'/api/additional/cover?id='+novelId,
   privateEpubsUntouched:true,privateCandidatesUntouched:true});
 }catch(error){
  let rolledBack=!published;
  if(published){
   try{
    const restore=kind==='seed'?
     before===null?
      await env.COMMUNITY_DB.prepare('DELETE FROM published_catalogue_overrides WHERE novel_id=? AND patch_json=?').bind(novelId,after).run():
      await env.COMMUNITY_DB.prepare('UPDATE published_catalogue_overrides SET patch_json=? WHERE novel_id=? AND patch_json=?').bind(before,novelId,after).run():
     await env.COMMUNITY_DB.prepare('UPDATE additional_catalogue_novels SET cover_key=?,payload_json=? WHERE id=? AND cover_key=? AND payload_json=?')
      .bind(beforeKey,before,novelId,imageKey,after).run();
    rolledBack=(restore.meta?.changes||0)===1;
   }catch{}
  }
  if(rolledBack){
   await env.COMMUNITY_DB.prepare('DELETE FROM community_entries WHERE id=? AND image_key=?').bind(eventId,imageKey).run().catch(()=>{});
   await env.COMMUNITY_IMAGES.delete(imageKey).catch(()=>{});
  }
  return epubCoverJson({error:'Public cover was not fully saved: '+String(error.message||error).slice(0,145),
   rollbackComplete:rolledBack},409);
 }
}

async function privateEpubAutoCoverRoute(request,env,email,role){
 if(role!=='owner')return respond({error:'Only the owner can import EPUB artwork privately'},403);
 if(request.method!=='POST'||!strictOrigin(request))return respond({error:'Cross-origin or invalid request'},403);
 if(!env.DB||!env.IMAGES)return respond({error:'Private storage is unavailable'},503);
 try{
  const fd=await request.formData(),id=editionBook(fd.get('novel_id')),file=fd.get('image');
  if(!id||!(file instanceof File)||file.type!=='image/jpeg'||file.size<80||file.size>2800000)
   return respond({error:'Choose an existing novel and a JPEG under 2.8 MB'},400);
  // Only act on works with a stored EPUB; never turn this into a generic image
  // upload or publish the private owner's edition cover on the public site.
  const linked=await env.DB.prepare('SELECT id FROM '+editionTable(id)+' WHERE novel_id=? LIMIT 1').bind(id).first();
  const legacy=!linked&&id<=962?await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind('private-epub:'+id).first():null;
  if(!linked&&!legacy)return respond({error:'Upload an EPUB edition before importing its cover'},409);
  const key='private-epub-cover:'+id;
  const prior=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(key).first();
  if(prior)return respond({ok:true,stored:false,skipped:true,reason:'Private cover already exists'});
  if(id<=962){
   const patch=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(id).first();
   let fields={};try{fields=JSON.parse(patch?.patch||'{}')}catch{}
   if(fields.cover)return respond({ok:true,stored:false,skipped:true,reason:'Editorial cover already exists'});
   const seedResponse=await env.ASSETS.fetch(new Request(new URL('/admin/catalogue.json',request.url)));
   if(seedResponse.ok){
    const raw=await seedResponse.json(),book=(Array.isArray(raw)?raw:raw.books||[]).find(x=>Number(x.id)===id);
    if(book?.cover)return respond({ok:true,stored:false,skipped:true,reason:'Original catalogue cover already exists'});
   }
   if(env.COMMUNITY_DB){
    const publicEdit=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(id).first();
    let pub={};try{pub=JSON.parse(publicEdit?.patch_json||'{}')}catch{}
    if(pub.cover)return respond({ok:true,stored:false,skipped:true,reason:'Published cover already exists'});
   }
  }else{
   const novel=await env.COMMUNITY_DB.prepare('SELECT cover_key,payload_json FROM additional_catalogue_novels WHERE id=?').bind(id).first();
   if(!novel)return respond({error:'Novel not found'},404);
   let fields={};try{fields=JSON.parse(novel.payload_json||'{}')}catch{}
   if(novel.cover_key||fields.cover)return respond({ok:true,stored:false,skipped:true,reason:'Existing cover kept'});
  }
  const bytes=await file.arrayBuffer(),buf=new Uint8Array(bytes);
  if(buf[0]!==255||buf[1]!==216||buf[2]!==255)return respond({error:'Invalid JPEG file'},415);
  const objectKey=crypto.randomUUID()+'.jpg';
  await env.IMAGES.put(objectKey,bytes,{httpMetadata:{contentType:'image/jpeg'}});
  const cover={cover:'/media/'+objectKey,scope:'private',extractedFrom: textField(fd.get('source'),130),
   coverCredit:'Private EPUB embedded cover',privateCover:true,publicPublished:false,createdAt:new Date().toISOString()};
  const after=JSON.stringify(cover),eventId=crypto.randomUUID();
  try{
   await env.DB.prepare('CREATE TABLE IF NOT EXISTS epub_metadata_import_events (id TEXT PRIMARY KEY,novel_id INTEGER NOT NULL,setting_key TEXT NOT NULL,before_value TEXT,after_value TEXT NOT NULL,actor_email TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,undone_at TEXT)').run();
   const inserted=await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').bind(key,after).run();
   if((inserted.meta?.changes||0)!==1){
    await env.IMAGES.delete(objectKey);return respond({ok:true,stored:false,skipped:true,reason:'Another cover was stored first'});
   }
   try{
    await env.DB.prepare('INSERT INTO epub_metadata_import_events (id,novel_id,setting_key,before_value,after_value,actor_email) VALUES (?,?,?,?,?,?)')
     .bind(eventId,id,key,null,after,email).run();
   }catch(error){
    await env.DB.prepare('DELETE FROM site_settings WHERE key=? AND value=?').bind(key,after).run().catch(()=>{});
    throw Error('Could not record Undo history for the private cover.');
   }
  }catch(error){await env.IMAGES.delete(objectKey).catch(()=>{});throw error}
  return respond({ok:true,stored:true,cover:cover.cover,privateOnly:true,publicPublished:false,eventId});
 }catch(error){return respond({error:textField(error?.message||'Could not import private cover',200)},400)}
}

async function privateEpubCoverRoute(request,env,email,role){
 if(!isEditor(role)||!await canReadEpubs(email,role,env))
  return editionJson({error:'Editor access and EPUB reading permission are required'},403);
 if(request.method!=='POST'||!strictOrigin(request))
  return editionJson({error:'Cross-origin or invalid request'},403);
 if(!env.IMAGES||!env.DB)return editionJson({error:'Private image storage unavailable'},503);
 if(!(request.headers.get('content-type')||'').startsWith('multipart/form-data'))
  return editionJson({error:'Select a reviewed EPUB cover image'},415);
 if(Number(request.headers.get('content-length')||0)>3300000)
  return editionJson({error:'Cover is too large'},413);
 let form;try{form=await request.formData()}catch{return editionJson({error:'Invalid cover form'},400)}
 const id=editionBook(form.get('novelId')),edition=String(form.get('editionId')||'');
 const file=form.get('image'),replace=form.get('replace')==='true';
 if(!id||!(file instanceof File)||file.type!=='image/jpeg'||file.size<80||file.size>2800000)
  return editionJson({error:'Choose an existing novel and JPEG under 2.8 MB'},400);
 if(form.get('rightsConfirmed')!=='true'||form.get('confirm')!=='true')
  return editionJson({error:'Confirm image rights and approval before showing an EPUB cover privately'},400);
 if(id>962&&!await extraNovelExists(env,id))
  return editionJson({error:'Novel entry missing'},404);
 let valid=false;
 if(edition==='legacy'&&id<=962){
  const old=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind('private-epub:'+id).first();
  valid=!!old;
 }else{
  const uuid=editionUuid(edition);
  if(uuid)valid=!!await env.DB.prepare('SELECT id FROM '+editionTable(id)+' WHERE novel_id=? AND id=?').bind(id,uuid).first();
 }
 if(!valid)return editionJson({error:'The selected stored EPUB edition is not linked to this novel'},409);
 const settingKey=PRIVATE_EPUB_COVER_KEY+id;
 let already=!!await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(settingKey).first();
 if(!already){
  if(id<=962){
   const old=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(id).first();
   let patch={};try{patch=JSON.parse(old?.patch||'{}')}catch{}
   already=!!patch.cover;
   if(!already){
    const seed=await env.ASSETS.fetch(new Request(new URL('/admin/catalogue.json',request.url)));
    if(seed.ok){const raw=await seed.json(),item=(Array.isArray(raw)?raw:raw.books||[]).find(x=>x.id===id);already=!!item?.cover}
   }
   if(!already&&env.COMMUNITY_DB){
    const published=await env.COMMUNITY_DB.prepare('SELECT patch_json FROM published_catalogue_overrides WHERE novel_id=?').bind(id).first();
    if(published){try{already=!!JSON.parse(published.patch_json||'{}').cover}catch{}}
   }
  }else if(env.COMMUNITY_DB){
   const novel=await env.COMMUNITY_DB.prepare('SELECT cover_key,payload_json FROM additional_catalogue_novels WHERE id=?').bind(id).first();
   if(novel){let meta={};try{meta=JSON.parse(novel.payload_json||'{}')}catch{}already=!!novel.cover_key||!!meta.cover}
  }
 }
 if(already&&!replace)return editionJson({error:'This novel already has a cover. Choose explicit replacement to change it.'},409);
 const bytes=await file.arrayBuffer(),v=new Uint8Array(bytes);
 if(v.length<3||v[0]!==255||v[1]!==216||v[2]!==255)return editionJson({error:'Invalid JPEG image bytes'},415);
 const key=crypto.randomUUID()+'.jpg';
 try{
  await env.IMAGES.put(key,bytes,{httpMetadata:{contentType:'image/jpeg'}});
  const value=JSON.stringify({cover:'/media/'+key,novelId:id,editionId:edition,approvedBy:email,approvedAt:new Date().toISOString(),scope:'private',rightsConfirmed:true});
  await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP')
   .bind(settingKey,value).run();
  try{await audit(env,email,'epub.private_cover.approve',id,edition)}catch{}
  return editionJson({ok:true,novelId:id,cover:'/media/'+key,scope:'private',publicPublished:false});
 }catch(error){
  try{await env.IMAGES.delete(key)}catch{}
  return editionJson({error:'Could not save the private EPUB cover. The EPUB file was not changed.'},500);
 }
}
const INSIGHT_KEY='epub-insights-v1:';
const insightTrim=(v,max)=>String(v??'').trim().slice(0,max);
const insightList=(v,max=24)=>Array.isArray(v)?[...new Set(v.filter(x=>typeof x==='string').map(x=>x.trim().slice(0,70)).filter(Boolean))].slice(0,max):[];
async function epubInsightsRoutes(request,env,email,role){
 if(!isEditor(role)||!await canReadEpubs(email,role,env))return editionJson({error:'Editor access and private EPUB reading permission are required'},403);
 if(!env.DB)return editionJson({error:'Private D1 database unavailable'},503);
 const u=new URL(request.url),path=u.pathname,method=request.method.toUpperCase();
 try{
  if(path==='/api/admin/epub-insights/editions'&&method==='GET'){
   const [a,b,c]=await Promise.all([
    env.DB.prepare('SELECT novel_id AS novelId,id AS editionId,filename,bytes FROM epub_editions LIMIT 1500').all(),
    env.DB.prepare('SELECT novel_id AS novelId,id AS editionId,filename,bytes FROM additional_epub_editions LIMIT 1500').all(),
    env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'private-epub:%' LIMIT 1100").all()
   ]);
   const items=[...(a.results||[]),...(b.results||[])].map(x=>({novelId:Number(x.novelId),editionId:x.editionId,filename:x.filename,size:x.bytes,legacy:false}));
   for(const x of c.results||[]){
    const m=/^private-epub:([1-9][0-9]*)$/.exec(x.key);if(!m||Number(m[1])>962)continue;
    try{const v=JSON.parse(x.value);if(/^private-epubs\/[0-9a-f-]{36}\.epub$/.test(v.key||''))
     items.push({novelId:Number(m[1]),editionId:'legacy',filename:insightTrim(v.name||'book.epub',160),size:Number(v.size)||0,legacy:true});}catch{}
   }
   const q=insightTrim(u.searchParams.get('q'),90).toLowerCase();
   const matches=q?items.filter(x=>String(x.novelId).includes(q)||x.filename.toLowerCase().includes(q)):items;
   matches.sort((x,y)=>x.novelId-y.novelId||x.filename.localeCompare(y.filename));
   const offset=Math.max(0,Math.min(100000,Number(u.searchParams.get('offset'))||0)),limit=Math.min(50,Math.max(1,Number(u.searchParams.get('limit'))||30));
   return editionJson({items:matches.slice(offset,offset+limit),total:matches.length,offset,limit});
  }
  if(path==='/api/admin/epub-insights/has-epub'&&method==='GET'){
   const novelId=editionBook(u.searchParams.get('id'));
   if(!novelId)return editionJson({error:'Choose a valid novel ID'},400);
   if(novelId>962){
    if(!env.COMMUNITY_DB)return editionJson({error:'Shared catalogue database is unavailable'},503);
    const found=await env.COMMUNITY_DB.prepare('SELECT id FROM additional_catalogue_novels WHERE id=?').bind(novelId).first();
    if(!found)return editionJson({error:'No novel with that ID exists. Create it in the catalogue first.'},404);
   }
   const table=editionTable(novelId);
   const stored=await env.DB.prepare('SELECT id,filename FROM '+table+' WHERE novel_id=? LIMIT 1').bind(novelId).first();
   const legacy=novelId<=962?await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind('private-epub:'+novelId).first():null;
   return editionJson({novelId,hasEpub:!!stored||!!legacy,editionId:stored?.id||(legacy?'legacy':null)});
  }
  if(path==='/api/admin/epub-insights/draft'&&method==='GET'){
   const id=editionBook(u.searchParams.get('id'));if(!id)return editionJson({error:'Invalid novel'},400);
   const x=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(INSIGHT_KEY+id).first();
   let draft=null;try{draft=x?JSON.parse(x.value):null}catch{}
   return editionJson({draft,novelId:id});
  }
  if(method!=='POST'||!strictOrigin(request))return editionJson({error:'Method or origin rejected'},403);
  const body=await getJson(request),id=editionBook(body.novelId);
  if(!id)return editionJson({error:'Choose a valid novel'},400);
  if(path==='/api/admin/epub-insights/draft'){
   const edition=body.editionId==='none'?'none':body.editionId==='legacy'?'legacy':editionUuid(body.editionId);
   if(!edition)return editionJson({error:'Invalid edition'},400);
   let valid=false;
   if(edition==='none'){
    if(id>962){
     if(!env.COMMUNITY_DB)return editionJson({error:'Shared catalogue database unavailable'},503);
     const existing=await env.COMMUNITY_DB.prepare('SELECT id FROM additional_catalogue_novels WHERE id=?').bind(id).first();
     if(!existing)return editionJson({error:'Novel ID was not found in the catalogue'},404);
    }
    // A Novel Updates-only draft is allowed only when there is genuinely no
    // stored EPUB edition for this novel in either private storage scheme.
    const stored=await env.DB.prepare('SELECT id FROM '+editionTable(id)+' WHERE novel_id=? LIMIT 1').bind(id).first();
    const legacy=id<=962?await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind('private-epub:'+id).first():null;
    if(stored||legacy)return editionJson({error:'This novel has an EPUB; inspect it first before using Novel Updates for missing metadata.'},409);
    valid=true;
   }else if(edition==='legacy'&&id<=962){
    valid=!!await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind('private-epub:'+id).first();
   }else{
    valid=!!await env.DB.prepare('SELECT id FROM '+editionTable(id)+' WHERE novel_id=? AND id=?').bind(id,edition).first();
   }
   if(!valid)return editionJson({error:'Selected stored EPUB was not found'},404);
   const data={novelId:id,editionId:edition,title:insightTrim(body.title,210),synopsis:insightTrim(body.synopsis,2000),
    tags:insightList(body.tags),genres:insightList(body.genres,15),warnings:insightList(body.warnings,15),
    fieldSources:Object.fromEntries(Object.entries(body.fieldSources&&typeof body.fieldSources==='object'?body.fieldSources:{}).filter(([k,v])=>['title','synopsis','tags','genres'].includes(k)&&['EPUB','Novel Updates','Novel Updates (staged)','Novel Updates (browser capture)'].includes(v))),
    approved:body.action==='approve',source:insightTrim(body.source,80)||'Retrieved metadata',
    reviewedBy:body.action==='approve'?email:null,updatedBy:email,updatedAt:new Date().toISOString()};
   if(!data.synopsis&&!data.tags.length&&!data.genres.length)return editionJson({error:'Add a synopsis, tag or genre before saving'},400);
   if(data.approved&&body.rightsConfirmed!==true)return editionJson({error:'Confirm the synopsis is original or authorized'},400);
   await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP')
    .bind(INSIGHT_KEY+id,JSON.stringify(data)).run();
   await audit(env,email,data.approved?'epub.insights.approve':'epub.insights.draft',id,edition);
   return editionJson({ok:true,draft:data,publicPublished:false});
  }
  if(path==='/api/admin/epub-insights/apply'){
   if(body.confirmApply!==true)return editionJson({error:'Explicit approval required before applying private metadata'},400);
   const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(INSIGHT_KEY+id).first();
   if(!row)return editionJson({error:'No saved metadata draft for this novel'},404);
   let approved;try{approved=JSON.parse(row.value)}catch{return editionJson({error:'Draft could not be read'},500)}
   if(!approved.approved||approved.novelId!==id)return editionJson({error:'Review and approve this exact novel first'},409);
   const patch={metadataReview:true,metadataSource:insightTrim(approved.source,80)||'Reviewed source metadata'};
   if(approved.synopsis)patch.synopsis=approved.synopsis;
   if(Array.isArray(approved.tags)&&approved.tags.length)patch.tags=insightList(approved.tags);
   if(Array.isArray(approved.genres)&&approved.genres.length)patch.genres=insightList(approved.genres,15);
   if(!patch.synopsis&&!patch.tags?.length&&!patch.genres?.length)return editionJson({error:'No approved fields to apply'},409);
   const validSource=x=>String(x||'').startsWith('Novel Updates')?'Novel Updates':x==='EPUB'?'EPUB':'manual';
   const rank=x=>x==='EPUB'?2:x==='Novel Updates'?1:3;
   const sources=approved.fieldSources&&typeof approved.fieldSources==='object'?approved.fieldSources:{};
   const accept=(field,oldValue,oldSource)=>{
    const incoming=patch[field],incomingSource=validSource(sources[field]||approved.source);
    if(!incoming||(Array.isArray(incoming)&&!incoming.length))return false;
    if(!oldValue||(Array.isArray(oldValue)&&!oldValue.length))return true;
    return rank(incomingSource)>rank(validSource(oldSource||'manual'));
   };
   let changed=[];
   if(id<=962){
    // Existing private edits are manually curated unless explicitly marked as
    // coming from an earlier source import. The canonical library is not touched.
    const previous=await env.DB.prepare('SELECT patch FROM novel_edits WHERE id=?').bind(id).first();
    let old={};try{old=JSON.parse(previous?.patch||'{}')}catch{}
    const next={...old,metadataFieldSources:{...(old.metadataFieldSources||{})}};
    for(const key of ['synopsis','tags','genres']){
     if(accept(key,old[key],next.metadataFieldSources[key])){
      next[key]=patch[key];
      next.metadataFieldSources[key]=validSource(sources[key]||approved.source);
      changed.push(key);
     }
    }
    if(changed.length){
     next.metadataReview=true;next.metadataSource=patch.metadataSource;
     await env.DB.prepare('INSERT INTO novel_edits(id,patch) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET patch=excluded.patch,updated_at=CURRENT_TIMESTAMP')
       .bind(id,JSON.stringify(next)).run();
    }
   }else{
    if(!env.COMMUNITY_DB)return editionJson({error:'Shared catalogue database is unavailable'},503);
    const additional=await env.COMMUNITY_DB.prepare('SELECT title,payload_json,visibility FROM additional_catalogue_novels WHERE id=?').bind(id).first();
    if(!additional)return editionJson({error:'Additional novel was not found'},404);
    if(additional.visibility!=='private')return editionJson({error:'This novel is already published. Use the catalogue editor to update public metadata instead.'},409);
    const prior=JSON.parse(additional.payload_json||'{}');
    const updated={...prior,metadataFieldSources:{...(prior.metadataFieldSources||{})}};
    for(const key of ['synopsis','tags','genres']){
     const oldSource=updated.metadataFieldSources[key]||(String(prior.metadataSource||'').startsWith('Novel Updates')?'Novel Updates':'manual');
     if(accept(key,prior[key],oldSource)){
      updated[key]=patch[key];
      updated.metadataFieldSources[key]=validSource(sources[key]||approved.source);
      changed.push(key);
     }
    }
    if(changed.length){
     updated.metadataReview=true;updated.metadataSource='Private EPUB / Novel Updates source review';
     await env.COMMUNITY_DB.prepare("UPDATE additional_catalogue_novels SET payload_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND visibility='private'")
       .bind(JSON.stringify(updated),id).run();
    }
   }
   if(!changed.length)return editionJson({ok:true,novelId:id,scope:'private',fieldsChanged:[],message:'No empty or lower-priority fields needed updating. Existing manual/EPUB metadata was preserved.'});
   await audit(env,email,'epub.metadata.apply-private',id,approved.editionId||'');
   return editionJson({ok:true,novelId:id,scope:'private',fieldsChanged:changed,message:'Filled private fields: '+changed.join(', ')+'. Public metadata unchanged.'});
  }
  return editionJson({error:'Not found'},404);
 }catch(e){return editionJson({error:insightTrim(e?.message||'Private EPUB analysis unavailable',200)},500)}
}
