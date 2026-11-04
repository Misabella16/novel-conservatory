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
// Invite codes are high-entropy, single-use, email-bound. Only SHA-256 hashes
// are stored in D1 site_settings. No new schema/migration is needed.
const INVITE_PREFIX='invitation-v1:';
const REGISTERED_PREFIX='site-reader:';
const REVOKED_PREFIX='site-block:';
const validInviteId=x=>/^[a-f0-9]{64}$/.test(String(x||''));
function inviteCode(){const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function hashInvite(value){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
}
async function isSiteMember(email,role,env){
  if(role==='owner')return true;
  if(!env.DB)return false;
  const denied=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(REVOKED_PREFIX+email).first();
  if(denied?.value==='true')return false;
  if(role==='editor')return true;
  const [registered,legacy]=await Promise.all([
    env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(REGISTERED_PREFIX+email).first(),
    // Preserve the ability to visit for people previously approved for EPUBs.
    env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind('epub-reader:'+email).first()
  ]);
  return registered?.value==='true'||legacy?.value==='true';
}
function privateResponse(){
  return new Response('<!doctype html><html lang="en"><meta name="robots" content="noindex"><meta charset="utf-8"><title>Private library</title><body style="font:16px/1.6 system-ui;padding:10vh max(20px,10vw);max-width:640px"><h1>Private library</h1><p>This account does not currently have permission to browse the library.</p><p>If you received an invitation, open the complete invitation link and sign in with the exact email it was sent to.</p></body></html>',
    {status:403,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-robots-tag':'noindex,nofollow','referrer-policy':'no-referrer'}});
}
async function inviteRoutes(request,env,email,role){
  const path=new URL(request.url).pathname,method=request.method.toUpperCase();
  if(path==='/api/invitations/me'&&method==='GET')return respond({email,role,approved:await isSiteMember(email,role,env)});
  if(path!=='/api/invitations/redeem'||method!=='POST')return respond({error:'Not found'},404);
  if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
  if(!env.DB)return respond({error:'D1 is not configured'},503);
  let code;
  try{const body=await getJson(request);code=String(body.token||'');}catch{return respond({error:'Invalid invitation request'},400);}
  if(!/^[A-Za-z0-9_-]{43}$/.test(code))return respond({error:'Invalid invitation code'},400);
  const hashed=await hashInvite(code),key=INVITE_PREFIX+hashed;
  const row=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(key).first();
  if(!row)return respond({error:'Invitation not found. Ask the owner for a new one.'},404);
  let invite;try{invite=JSON.parse(row.value)}catch{return respond({error:'Invalid invitation record'},400)}
  if(emailNorm(invite.email)!==email)return respond({error:'This invitation was issued to a different email address. Sign in with the invited email.'},403);
  if(invite.status==='accepted'&&await isSiteMember(email,role,env))return respond({ok:true,alreadyAccepted:true,home:'/'});
  if(invite.status!=='pending')return respond({error:'This invitation is no longer active.'},410);
  if(!Number.isFinite(invite.expiresAt)||invite.expiresAt<=Date.now())return respond({error:'This invitation has expired. Request another invitation.'},410);
  const next=JSON.stringify({...invite,status:'accepted',acceptedAt:new Date().toISOString()});
  const registered=REGISTERED_PREFIX+email;
  // D1 batch runs in a single transaction. The compare-and-set prevents two
  // concurrent uses of the same code; a revoked code cannot grant access.
  const results=await env.DB.batch([
    env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?').bind(next,key,row.value),
    env.DB.prepare(`INSERT INTO site_settings(key,value) SELECT ?,'true' WHERE EXISTS (SELECT 1 FROM site_settings WHERE key=? AND value=?) ON CONFLICT(key) DO UPDATE SET value='true',updated_at=CURRENT_TIMESTAMP`).bind(registered,key,next),
    env.DB.prepare('DELETE FROM site_settings WHERE key=? AND EXISTS (SELECT 1 FROM site_settings WHERE key=? AND value=?)').bind(REVOKED_PREFIX+email,key,next)
  ]);
  if(results[0]?.meta?.changes!==1)return respond({error:'Invitation was already used or changed.'},409);
  await audit(env,email,'invite.accept',email);
  return respond({ok:true,home:'/'});
}
async function inviteAdminRoutes(request,env,email,role){
  if(role!=='owner')return respond({error:'Only the owner can manage invitations'},403);
  if(!env.DB)return respond({error:'D1 database is not connected'},503);
  const method=request.method.toUpperCase();
  if(method==='GET'){
    const [invites,readers,editors,epub]=await Promise.all([
      env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'invitation-v1:%' ORDER BY updated_at DESC LIMIT 300").all(),
      env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'site-reader:%' OR key LIKE 'site-block:%' ORDER BY key LIMIT 500").all(),
      env.DB.prepare('SELECT email FROM editor_roles ORDER BY email LIMIT 500').all(),
      env.DB.prepare("SELECT key FROM site_settings WHERE key LIKE 'epub-reader:%' AND value='true' LIMIT 500").all()
    ]);
    const blocked=new Set((readers.results||[]).filter(x=>x.key.startsWith(REVOKED_PREFIX)&&x.value==='true').map(x=>x.key.slice(REVOKED_PREFIX.length)));
    const membership=new Map();
    for(const r of readers.results||[])if(r.key.startsWith(REGISTERED_PREFIX)&&r.value==='true')membership.set(r.key.slice(REGISTERED_PREFIX.length),'Reader');
    for(const r of epub.results||[])if(!membership.has(r.key.slice(12)))membership.set(r.key.slice(12),'Existing EPUB reader');
    for(const r of editors.results||[])membership.set(r.email,'Editor');
    const members=[...membership].filter(x=>emailValid(x[0])).map(([account,permission])=>({email:account,permission,blocked:blocked.has(account)}));
    for(const account of blocked)if(!membership.has(account))members.push({email:account,permission:'Revoked',blocked:true});
    const invitations=[];
    for(const record of invites.results||[]){
      const id=record.key.slice(INVITE_PREFIX.length);if(!validInviteId(id))continue;
      try{const i=JSON.parse(record.value);
        invitations.push({id,email:i.email,createdAt:i.createdAt,expiresAt:i.expiresAt,status:i.status==='pending'&&i.expiresAt<Date.now()?'expired':i.status,acceptedAt:i.acceptedAt||null});
      }catch{}
    }
    return respond({invitations,members,owner:emailNorm(env.OWNER_EMAIL),oneTimeSetupRequired:true});
  }
  if(method!=='POST')return respond({error:'Method not allowed'},405);
  if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403);
  let body;try{body=await getJson(request)}catch{return respond({error:'Invalid JSON body'},400)}
  if(body.action==='create'){
    const target=emailNorm(body.email);if(!emailValid(target))return respond({error:'Enter a valid email address'},400);
    if(target===emailNorm(env.OWNER_EMAIL))return respond({error:'The owner is already authorized'},400);
    const days=Number(body.days||7);if(![1,3,7,14,30].includes(days))return respond({error:'Invalid expiration period'},400);
    const code=inviteCode(),id=await hashInvite(code),created=Date.now();
    const record={email:target,status:'pending',createdAt:new Date(created).toISOString(),expiresAt:created+days*86400000,invitedBy:email};
    await env.DB.prepare('INSERT INTO site_settings(key,value) VALUES (?,?)').bind(INVITE_PREFIX+id,JSON.stringify(record)).run();
    await audit(env,email,'invite.create',target,`expires:${days}d`);
    return respond({ok:true,email:target,expiresAt:record.expiresAt,url:getOrigin(request)+'/join/?token='+encodeURIComponent(code)});
  }
  if(body.action==='revoke'){
    const id=String(body.id||'');if(!validInviteId(id))return respond({error:'Invalid invitation ID'},400);
    const key=INVITE_PREFIX+id;
    const found=await env.DB.prepare('SELECT value FROM site_settings WHERE key=?').bind(key).first();
    if(!found)return respond({error:'Invitation not found'},404);
    const record=JSON.parse(found.value);
    if(record.status!=='pending')return respond({error:'Only pending invitations can be canceled. Revoke the member instead.'},409);
    const updated={...record,status:'revoked',revokedAt:new Date().toISOString()};
    await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?').bind(JSON.stringify(updated),key,found.value).run();
    await audit(env,email,'invite.revoke',record.email);
    return respond({ok:true});
  }
  if(body.action==='remove-member'){
    const target=emailNorm(body.email);if(!emailValid(target)||target===emailNorm(env.OWNER_EMAIL))return respond({error:'Invalid member email'},400);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO site_settings(key,value) VALUES (?,'true') ON CONFLICT(key) DO UPDATE SET value='true',updated_at=CURRENT_TIMESTAMP").bind(REVOKED_PREFIX+target),
      env.DB.prepare('DELETE FROM site_settings WHERE key=?').bind(REGISTERED_PREFIX+target),
      env.DB.prepare('DELETE FROM site_settings WHERE key=?').bind('epub-reader:'+target),
      env.DB.prepare('DELETE FROM editor_roles WHERE email=?').bind(target)
    ]);
    // Cancel any still-pending invitations so revocation cannot be bypassed by
    // redeeming an old link. An audit entry stays in the invitation history.
    const outstanding=await env.DB.prepare("SELECT key,value FROM site_settings WHERE key LIKE 'invitation-v1:%'").all();
    for(const item of outstanding.results||[]){
      let record;try{record=JSON.parse(item.value)}catch{continue}
      if(record.email!==target||record.status!=='pending')continue;
      const update=JSON.stringify({...record,status:'revoked',revokedAt:new Date().toISOString()});
      await env.DB.prepare('UPDATE site_settings SET value=?,updated_at=CURRENT_TIMESTAMP WHERE key=? AND value=?').bind(update,item.key,item.value).run();
    }
    await audit(env,email,'site.access.revoke',target);
    return respond({ok:true});
  }
  return respond({error:'Unknown invitation action'},400);
}

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
  // Both the owner and explicitly approved friends may read EPUBs after the
  // owner enables sharing. All uploads, edits and bulk inventory remain owner-only.
  if(path.startsWith('/api/additional/')||path.startsWith('/api/admin/additional/'))return additionalRoutes(request,env,'private',email,role);
  if(path.startsWith('/api/private/edition/'))return editionRoutes(request,env,email,role);
  if(path==='/api/follows'||path.startsWith('/api/notifications'))return followRoutes(request,env,email);
  if(path==='/api/admin/publish-correction')return publishCorrectionRoute(request,env,email,role);
  if(path==='/api/admin/catalogue-editor')return liveCatalogueEditorRoute(request,env,email,role);
  if(path==='/api/admin/cover-sync/preview'||path==='/api/admin/cover-sync/run')return coverSyncRoutes(request,env,email,role);
  if(path==='/api/admin/epub-artwork/propose')return epubArtworkProposal(request,env,email,role);
  if(path==='/api/admin/epub-artwork/auto'&&method==='POST'){const copy=request.clone();const fd=await copy.formData();if(extraId(fd.get('novel_id'))){const target=new URL(request.url);target.pathname='/api/admin/additional/auto-cover';return additionalRoutes(new Request(target,request),env,'private',email,role)};}
  if(path.startsWith('/api/admin/epub-artwork/auto')||path==='/api/admin/epub-artwork/set-cover')return epubArtworkAutoRoutes(request,env,email,role);
  if(path.startsWith('/api/private/epub/')){
    if(!env.DB)return respond({error:'D1 database not configured.'},503);
    const readable=(path==='/api/private/epub/status'||path==='/api/private/epub/file')&&method==='GET';
    if(readable){
      if(!await canReadEpubs(email,role,env))return respond({error:'EPUB reading is not enabled for this account.'},403);
    }else if(role!=='owner')return respond({error:'Only the owner can manage stored EPUBs.'},403);
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
  if(path==='/api/admin/site-config'||path==='/api/admin/site-feedback')return siteAdminRoute(request,env,email,role);
  if(path.startsWith('/api/community/'))return communityDispatch(request,env,'private',{email,role});
  if(path==='/api/catalogue'&&method==='GET'){
   const response=await env.ASSETS.fetch(new Request(new URL('/admin/catalogue.json',url.origin)));
   if(!response.ok)return respond({error:'Catalogue unavailable'},503);
   const original=await response.json(),base=Array.isArray(original)?original:(original.books||[]);
   if(env.COMMUNITY_DB){try{const additions=await env.COMMUNITY_DB.prepare('SELECT * FROM additional_catalogue_novels ORDER BY created_at DESC LIMIT 5000').all();base.push(...(additions.results||[]).map(r=>extraDecorate(r,'private')));}catch{}}
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
      let additional=[];if(env.COMMUNITY_DB){try{const r=await env.COMMUNITY_DB.prepare('SELECT * FROM additional_catalogue_novels ORDER BY created_at DESC LIMIT 5000').all();additional=(r.results||[]).map(x=>extraDecorate(x,'private'));}catch{}}
      return respond({edits:(novels.results||[]).map(x=>({id:x.id,patch:JSON.parse(x.patch)})),additional,homepage:setting?JSON.parse(setting.value):{},configured:true});
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
  if(path==='/api/admin/invitations')return inviteAdminRoutes(request,env,email,role);
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

export default {
  async fetch(request,env,ctx){
    // All paths, including the static website, fail closed unless Access has
    // issued a signature-verified token for this exact production/preview app.
    let email,role;
    try {email=await verifyAccess(request,env);role=await roleFor(email,env);}
    catch(e){return respond({error:'Access verification failed. Check your login and Access settings.'},403);}
    const path=new URL(request.url).pathname;
    if(path==='/api/invitations/me'||path==='/api/invitations/redeem'){
      try{return await inviteRoutes(request,env,email,role)}
      catch{return respond({error:'Invitation could not be processed. Please try again.'},500)}
    }
    if(path==='/join')return Response.redirect(new URL('/join/'+new URL(request.url).search,request.url),302);
    if(path==='/join/'||path==='/join/index.html'){
      const res=await env.ASSETS.fetch(request);const headers=new Headers(res.headers);
      headers.set('cache-control','private,no-store');headers.set('referrer-policy','no-referrer');headers.set('x-robots-tag','noindex,nofollow');
      headers.set('content-security-policy',"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      return new Response(res.body,{status:res.status,statusText:res.statusText,headers});
    }
    // Fail closed for every private asset and API, not just the homepage.
    // Cloudflare Access authenticates; this D1 allowlist authorizes the site.
    try{if(!await isSiteMember(email,role,env))return path.startsWith('/api/')?respond({error:'This email has not been approved for the private library.'},403):privateResponse();}
    catch{return respond({error:'Membership database temporarily unavailable.'},503)}
    if(path==='/read'||path.startsWith('/read/')){
      if(!await canReadEpubs(email,role,env))return respond({error:'You do not have permission to open private EPUBs.'},403);
      if(path==='/read')return Response.redirect(new URL('/read/',request.url),302);
      const asset=await env.ASSETS.fetch(request);const head=new Headers(asset.headers);
      head.set('cache-control','private,no-store');head.set('x-robots-tag','noindex,nofollow');
      return new Response(asset.body,{status:asset.status,statusText:asset.statusText,headers:head});
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
 // Every additional entry is an owner-created or editor-approved catalogue record.
 payload={...payload,metadataReview:true};
 const key=payload.title.toLocaleLowerCase().replace(/\s+/g,' ').trim();
 if(!payload.title||payload.title.length<2)throw Error('Enter a novel title');
 const duplicate=await env.COMMUNITY_DB.prepare('SELECT id,title FROM additional_catalogue_novels WHERE normalized_title=? LIMIT 1').bind(key).first();
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
async function additionalRoutes(request,env,scope,email='',role='reader'){
 const path=new URL(request.url).pathname,method=request.method.toUpperCase();
 if(!env.COMMUNITY_DB)return extraJson({error:'Community database binding is missing'},503);
 const editor=scope==='private'&&['owner','editor'].includes(role),owner=scope==='private'&&role==='owner';
 try{
  if(path==='/api/additional/books'&&method==='GET'){
   const sql=scope==='public'?"SELECT * FROM additional_catalogue_novels WHERE visibility='published' ORDER BY created_at DESC LIMIT 5000":"SELECT * FROM additional_catalogue_novels ORDER BY created_at DESC LIMIT 5000";
   const rows=await env.COMMUNITY_DB.prepare(sql).all();
   return extraJson({novels:(rows.results||[]).map(row=>extraDecorate(row,scope)),configured:true});
  }
  if(path==='/api/additional/cover'&&method==='GET'){
   const id=extraId(new URL(request.url).searchParams.get('id'));if(!id||!env.COMMUNITY_IMAGES)return new Response('Not found',{status:404});
   const row=await env.COMMUNITY_DB.prepare('SELECT cover_key,visibility FROM additional_catalogue_novels WHERE id=?').bind(id).first();
   if(!row||!row.cover_key||(scope==='public'&&row.visibility!=='published'))return new Response('Not found',{status:404});
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
