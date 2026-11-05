"""Regression checks: Add Novel must not create a second record for the same book."""
from pathlib import Path
import subprocess, tempfile,sqlite3
root=Path(__file__).resolve().parents[1]
worker=(root/'private/_worker.js').read_text(encoding='utf8')
editor=(root/'private/submit-epub/editor.js').read_text(encoding='utf8')
assert 'async function extraCreateOrReuse(env,url,email,p,visibility)' in worker
part=worker[worker.index('async function extraCreateOrReuse('):worker.index('async function additionalRoutes(')]
assert 'const found=await nuFindCandidates(env,url,p,null)' in part
assert 'sameSource||(sameTitle&&sameAuthor)' in part
assert 'if(safe.length>1)' in part
assert 'const sameTitle=uncertain.filter(' in part
assert 'await nuSaveEdit(env,url,email,matched.id,p)' in part
assert 'await extraInsert(env,p,' in part
assert 'if(matched.visibility!==visibility)' in part
assert "notUpdated:true" in part
assert 'const result=await extraCreateOrReuse(env,new URL(request.url),email,p,visibility)' in worker
assert "const result=await extraCreateOrReuse(env,new URL(request.url),email,p,body.publish===true?'published':'private')" in worker
assert "result.notUpdated?'Its current metadata and publication state were kept." in editor
assert "result.reused?'Found existing novel #" in editor
assert "const output=['Novel #'+id+(create?' saved or reused':' selected')" in editor
assert 'async function nuEnsureJournal(env)' in worker
assert "await nuEnsureJournal(env);" in worker
assert "CREATE TABLE IF NOT EXISTS catalogue_edit_events" in worker
assert "CREATE INDEX IF NOT EXISTS idx_catalogue_edit_events_recent" in worker
assert "CREATE INDEX IF NOT EXISTS idx_catalogue_edit_events_target" in worker
assert "if(path==='/api/admin/nu/undo'&&method==='POST')" in worker
assert "source_submission_id NOT LIKE 'merged-into:%'" in worker
# Ensure the helper uses multiple identifiers; title alone must not trigger a silent overwrite.
assert 'sameTitle&&sameAuthor' in part
assert 'conflictingUrls=!!sourceA&&!!sourceB&&sourceA!==sourceB' in part
assert 'if(sameTitle.length)return' in part
assert part.index('if(safe.length>1)') < part.index("await extraInsert(env,p,")
subprocess.run(['node','--check',str(root/'private/_worker.js')],check=True)
subprocess.run(['node','--check',str(root/'private/submit-epub/editor.js')],check=True)
# Execute the matching policy against a mocked catalogue to test the important cases.
js=r"""
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync(process.argv[2],'utf8');
const segment=code.slice(code.indexOf('async function extraCreateOrReuse('),code.indexOf('async function additionalRoutes('));
const context={
 nuIdentity:x=>String(x||'').toLowerCase().replace(/[^a-z0-9]/g,''),
 nuCanon:x=>{const m=/^https:\/\/www\.novelupdates\.com\/series\/([^/?#]+)\/?$/.exec(String(x||''));return m?'https://www.novelupdates.com/series/'+m[1]+'/':''},
 nuFindCandidates:async()=>context.candidates,
 nuGetExisting:async(_env,_url,id)=>context.books[id],
 nuSaveEdit:async(_env,_url,_email,id)=>({eventId:'event-'+id,changed:['tags'],conflicts:[]}),
 extraInsert:async()=>{context.created++;return 123456},
 created:0,candidates:[],books:{}
};
vm.createContext(context);
vm.runInContext(segment+';this.execute=extraCreateOrReuse;',context);
const p={title:'Transmigrating Into the School Heartthrob’s Arch-Enemy',author:'Test Author',nuUrl:'https://www.novelupdates.com/series/school-enemy/'};
const name=p.title;
async function run(){
 context.candidates=[{id:10001}];
 context.books[10001]={id:10001,kind:'extra',row:{visibility:'private'},data:{id:10001,title:name,author:'Test Author',nuUrl:p.nuUrl}};
 let r=await context.execute({},new URL('https://novel-conservatory.pages.dev/'),'editor',p,'private');
 assert.equal(r.reused,true);assert.equal(r.id,10001);assert.equal(context.created,0);
 r=await context.execute({},new URL('https://novel-conservatory.pages.dev/'),'editor',p,'published');
 assert.equal(r.reused,true);assert.equal(r.notUpdated,true);assert.equal(context.created,0);
 context.candidates=[{id:10},{id:11}];
 context.books[10]={id:10,kind:'extra',row:{visibility:'private'},data:{title:name,author:p.author,nuUrl:p.nuUrl}};
 context.books[11]={id:11,kind:'extra',row:{visibility:'private'},data:{title:name,author:p.author,nuUrl:p.nuUrl}};
 r=await context.execute({},new URL('https://novel-conservatory.pages.dev/'),'editor',p,'private');
 assert.equal(r.needsChoice,true);assert.equal(context.created,0);
 context.candidates=[{id:12}];
 context.books[12]={id:12,kind:'extra',row:{visibility:'private'},data:{title:name,author:'Different Author'}};
 r=await context.execute({},new URL('https://novel-conservatory.pages.dev/'),'editor',p,'private');
 assert.equal(r.needsChoice,true);assert.equal(context.created,0);
 context.books[12].data={title:name,author:p.author,nuUrl:'https://www.novelupdates.com/series/different-work/'};
 r=await context.execute({},new URL('https://novel-conservatory.pages.dev/'),'editor',p,'private');
 assert.equal(r.needsChoice,true);assert.equal(context.created,0);
 context.candidates=[];
 r=await context.execute({},new URL('https://novel-conservatory.pages.dev/'),'editor',p,'private');
 assert.equal(r.reused,false);assert.equal(context.created,1);
 console.log('Novel ID reuse, visibility preservation, ambiguity checks and safe new entry: OK');
}
run().catch(e=>{console.error(e);process.exit(1)});
"""
with tempfile.NamedTemporaryFile(mode='w',encoding='utf8',suffix='.js') as temp:
 temp.write(js);temp.flush()
 subprocess.run(['node',temp.name,str(root/'private/_worker.js')],check=True)
print('Duplicate-safe novel submission and reversible edit history: OK')
