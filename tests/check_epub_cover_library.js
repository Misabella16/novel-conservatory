'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const worker=fs.readFileSync('private/_worker.js','utf8');
const admin=fs.readFileSync('private/admin/index.html','utf8');
const editions=fs.readFileSync('private/admin/editions.js','utf8');
const scanner=fs.readFileSync('private/admin/editions-enrich-all.js','utf8');
const tab=fs.readFileSync('private/admin/epub-editions-workspace.js','utf8');
const html=fs.readFileSync('private/admin/epub-cover-library.html','utf8');
const gallery=fs.readFileSync('private/admin/epub-cover-library.js','utf8');
for(const script of [editions,scanner,tab,gallery])new Function(script);
const snippet=(text,first,last)=>{
 const a=text.indexOf(first),b=text.indexOf(last,a+first.length);
 assert(a>=0&&b>a,'Missing source boundaries '+first);
 return text.slice(a,b);
};
const backend=snippet(worker,'async function epubCoverEnsure(', 'async function privateEpubAutoCoverRoute(');
new Function(backend);
assert(admin.includes('id="epub-editions-quick"'),'EPUB Editions must appear inside the admin EPUB tab');
assert(admin.includes('href="/admin/editions.html#stored-editions"'));
assert(admin.includes('href="/admin/epub-cover-library.html"'));
assert(admin.includes('/admin/epub-editions-workspace.js'));
const editionsPage=fs.readFileSync('private/admin/editions.html','utf8');
assert(editionsPage.includes('id="stored-editions"'));
assert(editionsPage.includes('id="enrich-all"'));
for(const id of ['gallery','edition','image','epub','rights','artist-credit','publish','undo-public','undo-private']){
 assert(html.includes('id="'+id+'"'),'Missing cover gallery control '+id);
}
assert(editions.includes("'/api/admin/epub-cover-library/upload'"),'Uploads must save a candidate per edition');
assert(editions.includes('r.editionId=entry.id;const art=await tryAutoCover(r)'));
assert(scanner.includes('editionId});'),'Existing EPUB scans must preserve edition IDs');
assert(scanner.includes('enrichment:v3'),'Old checkpoints must not skip cover candidate extraction');
assert(backend.includes('UNIQUE(novel_id,edition_id,sha256)'),'Per-edition duplicate cover detection required');
assert(backend.includes("if(!await privateEpubLinked(env,id,edition))"),
 'Cover candidates must belong to an actual stored private EPUB');
assert(backend.includes("if(role!=='owner')"),'Only the owner can publish artwork');
assert(backend.includes("body.rightsConfirmed!==true"),'Publishing requires explicit rights permission');
assert(backend.includes("current.visibility!=='published'"),
 'Do not publish a private-only novel while syncing its cover');
const upload=snippet(backend,
 "if(path==='/api/admin/epub-cover-library/upload'&&method==='POST')",
 "if(method!=='POST'||!strictOrigin(request))");
assert(!upload.includes('env.COMMUNITY_IMAGES.put'),
 'Cover extraction must never write to the public R2 bucket');
assert(!upload.includes('published_catalogue_overrides'),
 'Cover extraction must never update the public catalogue');
const action=snippet(backend,'async function epubCoverPublicAction(','async function privateEpubAutoCoverRoute(');
assert(action.includes('env.IMAGES.get(candidate.object_key)'));
assert(!action.includes('private-epub-editions/'),'Public sync must not read EPUB object keys');
assert(action.includes('env.COMMUNITY_IMAGES.put(imageKey,bytes'));
assert(action.includes("epub_public_cover_sync_events"));
assert(action.includes("if(path==='/api/admin/epub-cover-library/undo-public')"));
assert(gallery.includes("'rights').checked"));
assert(gallery.includes("'/api/admin/epub-cover-library/publish'"));
assert(gallery.includes("'/api/admin/epub-cover-library/undo-public'"));
assert(gallery.includes("'/api/admin/epub/undo-metadata'"));
assert(worker.includes("if(path==='/admin/epub-artwork.html'"),
 'Legacy auto-publication page must redirect to private-first gallery');
console.log('Admin EPUB Editions, per-edition candidate saving, old EPUB rescan: OK');
console.log('Owner-only private covers, explicit rights-checked public sync and Undo: OK');
