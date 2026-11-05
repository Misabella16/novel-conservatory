"""Direct novel creation must reuse clear matches and preserve Undo."""
from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[1]
worker=(root/'private/_worker.js').read_text('utf8')
form=(root/'private/submit-epub/editor.js').read_text('utf8')
legacy=(root/'private/admin/add-novels.js').read_text('utf8')
start=worker.index('async function extraCreateOrReuse(')
end=worker.index('async function additionalRoutes(',start)
code=worker[start:end]
assert "const found=await nuFindCandidates(env,url,p,null)" in code
assert "const sourceA=nuCanon(p.nuUrl),sourceB=nuCanon(current.nuUrl)" in code
assert "sameTitle&&sameAuthor" in code
assert "sameSource" in code
assert "safe.length>1" in code
assert "matched.visibility!==visibility" in code
assert "await nuSaveEdit(env,url,email,matched.id,p)" in code
assert "await extraInsert(env,p,'',visibility,email)" in code
assert "return {ok:true,id:matched.id,reused:true,eventId:result.eventId" in code
assert "const result=await extraCreateOrReuse(env,new URL(request.url),email,p,visibility)" in worker
assert "return extraJson(result,result.ok?200:409)" in worker
assert "Duplicate" in legacy or "duplicate" in legacy
assert "j.reused" in legacy and "result.reused" in form
assert "error.data=data" in form
assert "Original novel" in code or "existing novel" in code
assert "sameTitle=uncertain.filter" in code
assert "source_submission_id NOT LIKE 'merged-into:%'" in worker
# Execute the helper directly with mock catalogue/merging semantics.
source = '''
const assert=require('assert'),vm=require('vm'),fs=require('fs');
const raw=fs.readFileSync(process.argv[2],'utf8');
const counters={inserts:0,updates:0};
let candidate=[],records={};
const normalize=s=>String(s||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g,'');
const normalizeUrl=s=>String(s||'').trim();
const ctx={
 nuIdentity:normalize,nuCanon:normalizeUrl,
 nuFindCandidates:async()=>candidate,
 nuGetExisting:async(e,u,id)=>records[id],
 nuSaveEdit:async(e,u,email,id,p)=>{counters.updates++;return {eventId:'event-'+id,changed:['tags'],conflicts:[]}},
 extraInsert:async()=>{counters.inserts++;return 100011}
};
const {extraCreateOrReuse}=vm.runInNewContext(raw+';({extraCreateOrReuse})',ctx);
const incoming={title:"Novel Name",author:"Li Hua",nuUrl:"https://www.novelupdates.com/series/novel-name/"};
(async()=>{
 const env={},url={origin:"https://novel-conservatory.pages.dev"};
 candidate=[{id:100010}];
 records[100010]={id:100010,kind:'extra',row:{visibility:'published'},
  data:{title:'Novel Name',author:'Li Hua',nuUrl:incoming.nuUrl}};
 let r=await extraCreateOrReuse(env,url,'editor@example.com',incoming,'published');
 assert.equal(r.id,100010);assert.equal(r.reused,true);assert.equal(counters.inserts,0);assert.equal(counters.updates,1);
 r=await extraCreateOrReuse(env,url,'editor@example.com',incoming,'private');
 assert.equal(r.reused,true);assert.equal(r.notUpdated,true);assert.equal(counters.inserts,0);assert.equal(counters.updates,1);
 records[100010].data.author='Another Author';records[100010].data.nuUrl='';
 r=await extraCreateOrReuse(env,url,'editor@example.com',incoming,'published');
 assert.equal(r.needsChoice,true);assert.equal(counters.inserts,0);
 candidate=[];r=await extraCreateOrReuse(env,url,'editor@example.com',incoming,'private');
 assert.equal(r.reused,false);assert.equal(r.id,100011);assert.equal(counters.inserts,1);
 candidate=[{id:1},{id:100010}];
 records[1]={id:1,kind:'seed',data:{title:incoming.title,author:incoming.author,nuUrl:incoming.nuUrl}};
 records[100010].data={...incoming};
 r=await extraCreateOrReuse(env,url,'editor@example.com',incoming,'published');
 assert.equal(r.needsChoice,true);
 console.log('Direct novel reuse/merge semantics OK');
})().catch(e=>{console.error(e);process.exitCode=1});
'''
with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf8') as helper:
 helper.write(code);helper.flush()
 with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf8') as test:
  test.write(source);test.flush()
  subprocess.run(['node',test.name,helper.name],check=True)
subprocess.run(['node','--check',str(root/'private/submit-epub/editor.js')],check=True)
subprocess.run(['node','--check',str(root/'private/admin/add-novels.js')],check=True)
print('Duplicate-safe direct novel creation: OK')
