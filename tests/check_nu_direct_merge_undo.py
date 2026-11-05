"""Regression checks for direct Novel Updates syncing, duplicate merging, and Undo."""
from pathlib import Path
import sqlite3,subprocess,re,tempfile,json
root=Path(__file__).resolve().parents[1]
private=(root/'private/_worker.js').read_text(encoding='utf8')
public=(root/'public/_worker.js').read_text(encoding='utf8')
stage=(root/'private/admin/novel-updates.html').read_text(encoding='utf8')
capture=(root/'private/admin/nu-browser-capture.js').read_text(encoding='utf8')
mergepage=(root/'private/admin/resolve-duplicates.html').read_text(encoding='utf8')
mergejs=(root/'private/admin/resolve-duplicates.js').read_text(encoding='utf8')
schema=(root/'database/CATALOGUE_MERGE_UNDO_MIGRATION.sql').read_text(encoding='utf8')

assert "instr(lower(title),lower(?))>0" in private
assert "args.push(needle,needle,needle)" in private
assert "title LIKE ?" not in private[private.index("if(path==='/api/admin/nu/staging'"):private.index("if(path==='/api/admin/nu/stage-browser'")]

for token in (
 'async function nuSyncSource(', 'async function nuSaveEdit(',
 'async function nuUndoEdit(', 'async function nuCreateEdited(',
 'function nuMergeData(', 'async function nuFindCandidates(',
 "if(path==='/api/admin/nu/sync-capture'&&method==='POST')",
 "if(path==='/api/admin/nu/sync-staged'&&method==='POST')",
 "if(path==='/api/admin/nu/merge-preview'&&method==='GET')",
 "if(path==='/api/admin/nu/merge-apply'&&method==='POST')",
 "if(path==='/api/admin/nu/search-books'&&method==='GET')",
 "if(path==='/api/admin/nu/merge-history'&&method==='GET')",
 "if(path==='/api/admin/nu/undo'&&method==='POST')"
): assert token in private,token
assert "if(!isEditor(role))return respond({error:'Editor permission required'},403)" in private
assert "if(!sameOrigin(request))" in private
assert "source_submission_id='merged-into:'" not in private
assert "afterSourceMarker=sourceRow?'merged-into:'+target.id:null" in private
assert "const eventId=crypto.randomUUID()" in private
assert "beforePrivate:previousPrivate,afterPrivate:nextPrivate" in private
assert "snap.afterTarget" in private
assert "if(await nuHasPrivateEpub(env,sourceId))throw Error" in private
assert "if(current?.patch_json!==snap.afterTarget)" in private
assert "if(row?.payload_json!==snap.afterTarget||" in private
assert "snap.afterVisibility!==undefined&&row.visibility!==snap.afterVisibility" in private
assert "Undo the newer edit first" in private
assert "published_catalogue_overrides" in private
assert "extraInsert(env,data,'','published',email)" in private
assert "ON CONFLICT DO NOTHING" in private
assert "if(path==='/api/admin/nu/publish'&&method==='POST')" in private
assert "await nuSyncSource(env,url,email" in private
assert "source_submission_id NOT LIKE 'merged-into:%'" in private
assert "source_submission_id NOT LIKE 'merged-into:%'" in public
assert "source_submission_id NOT LIKE 'reverted-create:%'" in private
assert "source_submission_id NOT LIKE 'reverted-create:%'" in public

assert 'id="nu-choice-select"' in stage
assert 'id="nu-undo-last"' in stage
assert 'id="nu-conflict-fields"' in stage
assert 'Save to catalogue · Undo available' in stage
assert 'Sync selected to catalogue' in stage
assert 'Merge duplicates &amp; view Undo history' in stage
assert 'Save to catalogue' in capture or '/api/admin/nu/sync-capture' in capture
assert "/api/admin/nu/sync-capture" in capture
assert "/api/admin/nu/undo" in capture
assert "preferSourceFields" in capture
assert "result.needsChoice" in capture
assert "needsIdentityConfirmation" in capture
assert "id=\"source-id\"" in mergepage and "id=\"target-id\"" in mergepage
assert "id=\"merge-conflicts\"" in mergepage and "id=\"undo-history\"" in mergepage
assert "/api/admin/nu/merge-apply" in mergejs and "/api/admin/nu/merge-preview" in mergejs
assert "/api/admin/nu/merge-history" in mergejs and "/api/admin/nu/undo" in mergejs
assert "targetBefore" not in schema
assert "CREATE TABLE IF NOT EXISTS catalogue_edit_events" in schema
assert "operation IN ('merge','metadata_sync','create')" in schema

for path in (root/'private/admin/resolve-duplicates.js',root/'private/admin/nu-browser-capture.js'):
 subprocess.run(['node','--check',str(path)],check=True)
for doc in (stage,mergepage):
 for m in re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',doc,re.I):
  if not m.group(2).strip() or 'application/json' in m.group(1):continue
  with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf8') as tmp:
   tmp.write(m.group(2));tmp.flush()
   subprocess.run(['node','--check',tmp.name],check=True)

# Real SQLite tests for the migration, literal search, and reversible soft-hide.
db=sqlite3.connect(':memory:')
db.executescript(schema)
db.execute("""CREATE TABLE additional_catalogue_novels
(id INTEGER PRIMARY KEY,title TEXT,payload_json TEXT,source_submission_id TEXT NOT NULL DEFAULT '',
 visibility TEXT NOT NULL DEFAULT 'published',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
db.executemany('INSERT INTO additional_catalogue_novels(id,title,payload_json,source_submission_id) VALUES(?,?,?,?)',[
 (100001,'Transmigrating Into the School Heartthrob’s Arch-Enemy','{}',''),
 (100002,'Transmigrating Into the School Heartthrob’s Arch-Enemy','{}','merged-into:100001'),
 (100003,'An accidental new book','{}','reverted-create:100003'),
])
sql="SELECT id FROM additional_catalogue_novels WHERE source_submission_id NOT LIKE 'merged-into:%' AND source_submission_id NOT LIKE 'reverted-create:%'"
assert [x[0] for x in db.execute(sql)]==[100001]
db.execute('CREATE TABLE nu_staged_series(title TEXT,author TEXT,slug TEXT,state TEXT)')
title='Transmigrating Into the School Heartthrob’s Arch-Enemy'
db.execute('INSERT INTO nu_staged_series VALUES(?,?,?,?)',(title,'Author','transmigrating-into-the-school-heartthrobs-arch-enemy','draft'))
literal=title
assert db.execute("SELECT COUNT(*) FROM nu_staged_series WHERE instr(lower(title),lower(?))>0 OR instr(lower(author),lower(?))>0 OR instr(lower(slug),lower(?))>0",(literal,literal,literal)).fetchone()[0]==1
assert db.execute("SELECT COUNT(*) FROM nu_staged_series WHERE instr(lower(title),lower(?))>0",('%_%_%',)).fetchone()[0]==0
assert db.execute("SELECT COUNT(*) FROM nu_staged_series WHERE instr(lower(title),lower(?))>0",('heartthrob',)).fetchone()[0]==1

# Exercise actual source helper's field rules in Node VM.
segment=private[private.index('const NU_EDITABLE='):private.index('async function nuBaseCatalogue(')]
with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf8') as tmp:
 script='''
const assert=require("assert"),vm=require("vm"),fs=require("fs");
const source=fs.readFileSync(process.argv[2],"utf8");
const ctx={URL,extraTags:x=>[...new Set((Array.isArray(x)?x:String(x||"").split(",")).map(v=>String(v).trim()).filter(Boolean))].slice(0,35)};
const lib=vm.runInNewContext(source+";({nuIdentity,nuMergeData})",ctx);
assert.equal(lib.nuIdentity("School Heartthrob’s Arch-Enemy"),lib.nuIdentity("school heartthrob's arch enemy"));
const before={title:"Existing Book",synopsis:"Human-edited synopsis",tags:["Drama","Found Family"],genres:["Romance"],author:"Existing Author"};
const sourceNovel={title:"Alternate Book",synopsis:"Novel Updates description",tags:["Drama","School Life"],genres:["Romance","Fantasy"],author:"New Author"};
const merged=lib.nuMergeData(before,sourceNovel,[]);
assert.equal(merged.after.synopsis,before.synopsis);
assert.equal(merged.after.author,before.author);
assert.deepEqual(Array.from(merged.after.tags),["Drama","Found Family","School Life"]);
assert.deepEqual(Array.from(merged.after.genres),["Romance","Fantasy"]);
assert(merged.conflicts.some(x=>x.field==="synopsis"));
const chosen=lib.nuMergeData(before,sourceNovel,["synopsis"]);
assert.equal(chosen.after.synopsis,"Novel Updates description");
console.log("NU merge rules OK");
'''
 import subprocess as sp
 with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf8') as nodefile:
  tmp.write(segment);tmp.flush();nodefile.write(script);nodefile.flush()
  sp.run(['node',nodefile.name,tmp.name],check=True)

print('Direct source merge, literal search, duplicate suppression, Undo migration and editor controls: OK')
