"""Every direct/bulk new novel gets Undo history without deleting linked files."""
from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[1]
worker=(root/'private/_worker.js').read_text('utf8')
client=(root/'private/submit-epub/editor.js').read_text('utf8')
page=(root/'private/submit-epub/index.html').read_text('utf8')
assert 'async function extraRecordCreationUndo(env,email,id)' in worker
segment=worker[worker.index('async function extraRecordCreationUndo('):worker.index('async function extraCreateOrReuse(')]
for required in (
 'await nuEnsureJournal(env)',"targetKind:'created'",
 "afterVisibility:row.visibility","'create',id,null",
 "source_submission_id=''",'nuCanon(JSON.parse(row.payload_json',
 'DELETE FROM additional_catalogue_novels','Could not record Undo history',
 "CREATE TABLE IF NOT EXISTS"
):
 if required=="CREATE TABLE IF NOT EXISTS":assert required in worker
 else:assert required in segment,required
assert "if(result.ok&&!result.reused)result.eventId=await extraRecordCreationUndo(env,email,result.id)" in worker
assert worker.count("if(result.ok&&!result.reused)result.eventId=await extraRecordCreationUndo(env,email,result.id)")>=2
assert "if(row.cover_key&&row.cover_key!==(snap.afterCoverKey||''))" in worker
assert "if(await nuHasPrivateEpub(env,targetId))throw Error('This book now has EPUBs" in worker
assert "snap.afterVisibility!==undefined&&row.visibility!==snap.afterVisibility" in worker
assert 'id="entry-undo"' in page
assert "View change history" not in page or "Full change history &amp; Undo" in page
assert "latestSavedEvent=result.eventId||null" in client
assert "latestSavedEvent&&files.length" in client
assert "$('entry-undo').hidden=!latestSavedEvent||files.length>0" in client
assert "await req('/api/admin/nu/undo'" in client
assert "if(result.hiddenCreated)" in client
for path in (root/'private/_worker.js',root/'private/submit-epub/editor.js'):
 subprocess.run(['node','--check',str(path)],check=True)
print('Undo for all new direct and bulk novel entries, with file and cover guards: OK')
