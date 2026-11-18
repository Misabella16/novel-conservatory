'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const pub=read('public/_worker.js'),priv=read('private/_worker.js');
const html=read('public/index.html'),community=read('public/community/index.html');
const tool=read('public/reader-tools/reader-tools.js');
const toolHTML=read('public/reader-tools/index.html');
const admin=read('private/admin/public-site.html');
function extract(text,start,end){
 const a=text.indexOf(start),b=text.indexOf(end,a+start.length);
 assert.ok(a>=0&&b>a,'cannot locate '+start);
 return text.slice(a,b);
}
const publicValidation=extract(pub,'const communityBook=','const communityOrigin=');
const {communityBook,publicCommunityBook}=new Function(publicValidation+
 ';return {communityBook,publicCommunityBook}')();
(async()=>{
 assert.equal(communityBook('1'),1);
 assert.equal(communityBook('962'),962);
 assert.equal(communityBook('100000'),100000);
 assert.equal(communityBook('999'),null);
 assert.equal(communityBook('0'),null);
 const fake=row=>({COMMUNITY_DB:{prepare:sql=>{
  assert.match(sql,/additional_catalogue_novels/);
  return {bind:id=>({first:async()=>row})};
 }}});
 assert.equal(await publicCommunityBook(fake({visibility:'published',source_submission_id:''}),100001),100001);
 assert.equal(await publicCommunityBook(fake({visibility:'private',source_submission_id:''}),100001),null);
 assert.equal(await publicCommunityBook(fake({visibility:'published',source_submission_id:'merged-into:962'}),100001),null);
 assert.equal(await publicCommunityBook(fake({visibility:'published',source_submission_id:''}),999),null);
 assert.match(pub,/scope==='public'\?\s*await publicCommunityBook\(env,fd\.get\('novel_id'\)\)/);
 assert.match(pub,/status='approved' AND kind='tags' AND novel_id>=100000/);
 assert.match(pub,/const status=direct\?'approved':'pending'/);
 assert.match(pub,/await communityVerifyTurnstile\(request,env,token\)/);
 assert.match(community,/id<=962\|\|id>=100000/);
 assert.match(toolHTML,/Capture NU tags/);
 assert.match(toolHTML,/without an admin account/);
 assert.match(tool,/function captureNUTags\(\)/);
 assert.match(tool,/novelupdates-reader-tags-v1/);
 assert.match(tool,/\/api\/community\/submit/);
 assert.match(tool,/\/catalogue-submission-index\.json/);
 assert.match(tool,/\/api\/additional\/books/);
 assert.match(tool,/\/api\/community\/config/);
 assert.match(tool,/fd\.set\('kind','tags'\)/);
 assert.match(tool,/turnstile\?\.getResponse/);
 assert.doesNotMatch(tool,/\/api\/admin\//);
 assert.doesNotMatch(tool,/\/api\/private\//);
 assert.match(html,/\/reader-tools\//);
 assert.match(html,/communityTags/);
 assert.match(html,/Reader-contributed tags · not editorially verified/);
 const helpers=extract(priv,'const PUBLIC_EDITOR_FIELDS=','const PUBLISH_FIELDS=');
 const allowed=helpers.slice(0,helpers.indexOf('function publicEditorialFields'));
 assert.doesNotMatch(allowed,/['"]cover['"]|['"]epub['"]|['"]email['"]|['"]private['"]/i);
 const dependencies=[
  "const textArray=v=>Array.isArray(v)?v.filter(x=>typeof x==='string').map(x=>x.trim().slice(0,75)).slice(0,24):[];",
  "const textField=(v,max)=>String(v??'').trim().slice(0,max);",
  "const safeLink=v=>{try{const u=new URL(v);return u.protocol==='https:'?u.href:'';}catch{return ''}};",
  "const translationStatuses=new Set(['completed','ongoing','incomplete','dropped','licensed','unconfirmed']);"
 ].join('\n');
 const {publicEditorialFields,syncPublicEditorialPatch}=new Function(
  dependencies+'\n'+helpers+'\nreturn {publicEditorialFields,syncPublicEditorialPatch};'
 )();
 const fields=publicEditorialFields({
  title:'Revised title',synopsis:'New synopsis',tags:['Found family'],genres:['Fantasy'],
  cover:'/media/private.jpg',privateCover:true,privateEpub:'private-epubs/secret.epub',
  member_email:'private@example.com',reader_notes:'Secret',contentWarnings:['Violence'],
  nuUrl:'https://www.novelupdates.com/series/example/',
  translatorUrl:'https://example.com/story'
 });
 assert.deepEqual(Object.keys(fields).sort(),
  ['contentWarnings','genres','nuUrl','synopsis','tags','title','translatorUrl'].sort());
 assert.equal('cover' in fields,false);
 assert.equal('privateEpub' in fields,false);
 assert.equal('member_email' in fields,false);
 let savedJSON=null;
 const mock={COMMUNITY_DB:{prepare:q=>({
  bind:(...args)=>({
   first:async()=>({patch_json:JSON.stringify({
    cover:'/api/community/image?id=previous-safe-artwork',
    communityTags:['Reader suggestion'],tags:['Old editor tag']
   })}),
   run:async()=>{
    assert.match(q,/UPDATE published_catalogue_overrides/);
    savedJSON=JSON.parse(args[0]);return {meta:{changes:1}};
   }
  })
 })}};
 const result=await syncPublicEditorialPatch(mock,25,{
  tags:['New editor tag'],synopsis:'Updated',cover:'/media/private.jpg',
  privateEpub:'secret',userEmail:'hidden'
 },'owner@example.com');
 assert.equal(result.synced,true);
 assert.equal(savedJSON.cover,'/api/community/image?id=previous-safe-artwork');
 assert.deepEqual(savedJSON.communityTags,['Reader suggestion']);
 assert.deepEqual(savedJSON.tags,['New editor tag']);
 assert.equal(savedJSON.privateEpub,undefined);
 assert.equal(savedJSON.userEmail,undefined);
 assert.equal((await syncPublicEditorialPatch({COMMUNITY_DB:null},25,{tags:['A']},'owner')).synced,false);
 assert.match(priv,/publicSynced,publicSyncReason/);
 assert.match(priv,/confirmation!=='PUBLISH SAFE METADATA'/);
 assert.match(priv,/role!=='owner'\|\|!strictOrigin\(request\)/);
 assert.match(admin,/id="sync-preview"/);
 assert.match(admin,/id="sync-apply"/);
 assert.match(admin,/PUBLISH SAFE METADATA/);
 assert.doesNotMatch(pub,/env\.IMAGES\b|env\.DB\b/);
 console.log('Public reader tagging, bookmarklet, matching, metadata allowlist, safe sync and backfill: PASS');
})().catch(error=>{console.error(error);process.exitCode=1});