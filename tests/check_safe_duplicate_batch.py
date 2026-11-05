"""Validate high-confidence automatic duplicate merging and file safety gates."""
from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[1]
worker=(root/'private/_worker.js').read_text('utf8')
screen=(root/'private/admin/resolve-duplicates.html').read_text('utf8')
client=(root/'private/admin/resolve-duplicates.js').read_text('utf8')
part=worker[worker.index('async function nuSafeDuplicateScan('):worker.index('async function nuHasPrivateEpub(',worker.index('async function nuSafeDuplicateScan('))]
assert 'SELECT novel_id AS id FROM additional_epub_editions GROUP BY novel_id' in part
assert 'SELECT novel_id AS id FROM epub_editions GROUP BY novel_id' in part
assert 'const sameIdentity' not in part or 'titleKey' in part
assert "if(x.nuKey&&item.nuKey&&x.nuKey!==item.nuKey)continue" in part
assert "source.hasEpub" in part and "source.coverKey" in part
assert "source.visibility!==target.visibility" in part
assert "if(set.size>1)" in part
assert "nuCanon(item.nuUrl)" in part and "nuIdentity(item.author)" in part
assert "if(a.kind!==b.kind)" in part
assert "const quality=x=>" in part
for path in ("/api/admin/nu/duplicates/scan","/api/admin/nu/duplicates/merge-safe"):
 assert path in worker
assert "if(!sameOrigin(request))" in worker[worker.index("if(path==='/api/admin/nu/duplicates/merge-safe'"):][:150]
assert "slice(0,12)" in worker
assert "await nuSaveEdit(env,url,email,target.id,source.data,{sourceId:source.id,expectedBefore:target.beforeRaw})" in worker
assert "await nuFindCandidates(env,url,source.data,source.id)" in worker
assert "if(await nuHasPrivateEpub(env,source.id)||source.row?.cover_key||" in worker
assert "if(check.length!==1||check[0].id!==target.id)" in worker
assert "result.needsChoice" not in worker[worker.index("if(path==='/api/admin/nu/duplicates/merge-safe'"):worker.index("if(path==='/api/admin/nu/search-books'")]
assert 'id="safe-merge"' in screen and 'id="safe-scan"' in screen
assert 'id="safe-results"' in screen
assert "await api('/api/admin/nu/duplicates/scan')" in client
assert "await api('/api/admin/nu/duplicates/merge-safe'" in client
assert "await history()" in client
for path in (root/'private/_worker.js',root/'private/admin/resolve-duplicates.js'):
 subprocess.run(['node','--check',str(path)],check=True)
js=r"""
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const raw=fs.readFileSync(process.argv[2],'utf8');
const code=raw.slice(raw.indexOf('async function nuSafeDuplicateScan('),raw.indexOf('async function nuHasPrivateEpub('));
const canon=s=>String(s||'');
const normalize=s=>String(s||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g,'');
const base=[
 {id:7,title:'Comet House',author:'A. Lin',nuUrl:'https://www.novelupdates.com/series/comet-house/',synopsis:'Base synopsis',tags:['Mystery']},
 {id:8,title:'Moon Ice',author:'H. Park',nuUrl:'https://www.novelupdates.com/series/moon-ice/',tags:['Fantasy']}
];
const added=[
 {id:100111,visibility:'published',cover_key:'',title:'Comet House',author:'A. Lin',nuUrl:base[0].nuUrl,tags:['Mystery','School Life']},
 {id:100142,visibility:'private',cover_key:'',title:'Moon Ice',author:'H. Park',nuUrl:base[1].nuUrl,tags:['Found Family']},
 {id:100118,visibility:'private',cover_key:'',title:'Ghost Book',author:'Z. Chen',nuUrl:'',tags:['Fantasy']},
 {id:100119,visibility:'private',cover_key:'',title:'Ghost Book',author:'Z. Chen',nuUrl:'',tags:[]},
 {id:100130,visibility:'published',cover_key:'',title:'Wrong book',author:'Different',nuUrl:'https://www.novelupdates.com/series/other/'},
 {id:100131,visibility:'published',cover_key:'',title:'Wrong book',author:'Second',nuUrl:'https://www.novelupdates.com/series/totally-other/'},
 {id:100140,visibility:'private',cover_key:'',title:'Private Show',author:'Y',nuUrl:'https://www.novelupdates.com/series/private-show/'},
 {id:100141,visibility:'published',cover_key:'',title:'Private Show',author:'Y',nuUrl:'https://www.novelupdates.com/series/private-show/'},
 {id:100150,visibility:'published',cover_key:'',title:'Cover Book',author:'D',nuUrl:'https://www.novelupdates.com/series/cover-book/',tags:['Drama','School Life','Romance']},
 {id:100151,visibility:'published',cover_key:'some-existing-cover',title:'Cover Book',author:'D',nuUrl:'https://www.novelupdates.com/series/cover-book/'},
 {id:100160,visibility:'published',cover_key:'',title:'File Book',author:'E',nuUrl:'https://www.novelupdates.com/series/file-book/'},
 {id:100161,visibility:'published',cover_key:'',title:'File Book',author:'E',nuUrl:'https://www.novelupdates.com/series/file-book/'}
];
const env={
 COMMUNITY_DB:{prepare(sql){return {async all(){return {results:[]}}}}},
 DB:{prepare(sql){return {async all(){return {results:sql.includes('additional_epub_editions')?[{id:100160}]:[]}}}}}
};
const ctx={
 nuBaseCatalogue:async()=>base,nuAdditionalRows:async()=>added,
 nuAdditionalData:x=>({...x}),extraTags:x=>Array.isArray(x)?x:[],
 nuCanon:canon,nuIdentity:normalize
};
vm.createContext(ctx);
vm.runInContext(code+';this.scan=nuSafeDuplicateScan;',ctx);
ctx.scan(env,{origin:'https://novel-conservatory.pages.dev'}).then(d=>{
 const pairs=d.proposals.map(x=>x.sourceId+':'+x.targetId);
 assert(pairs.includes('100111:7'),JSON.stringify(pairs));
 assert(pairs.includes('100142:8'),JSON.stringify(pairs));
 assert(d.proposals.some(x=>x.sourceId===100142&&x.targetId===8&&x.privateOnly),JSON.stringify(d.proposals));
 assert(pairs.includes('100119:100118'),JSON.stringify(pairs));
 assert(pairs.includes('100161:100160'),JSON.stringify(pairs));
 assert(!pairs.includes('100141:100140'));
 assert(d.skipped.some(x=>x.reason.startsWith('Private/public visibility differs')));
 assert(d.skipped.some(x=>x.reason.includes('cover image')));
 assert(pairs.length===4,JSON.stringify(pairs));
 console.log('Safe duplicate discovery, metadata preference, EPUB and cover safeguards: OK');
}).catch(e=>{console.error(e);process.exitCode=1});
"""
with tempfile.NamedTemporaryFile(mode='w',encoding='utf8',suffix='.js') as tmp:
 tmp.write(js);tmp.flush()
 subprocess.run(['node',tmp.name,str(root/'private/_worker.js')],check=True)
print('Safe duplicate merge and Undo controls: OK')
