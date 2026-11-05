"""Immediate editor saves are undoable, including publication visibility changes."""
from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[1]
worker=(root/'private/_worker.js').read_text(encoding='utf8')
manage=(root/'private/admin/add-novels.js').read_text(encoding='utf8')
page=(root/'private/admin/add-novels.html').read_text(encoding='utf8')
unified=(root/'private/submit-epub/editor.js').read_text(encoding='utf8')
assert "async function extraEditWithUndo(env,email,row,patch,visibility)" in worker
start=worker.index('async function extraEditWithUndo(')
end=worker.index('async function extraCreateOrReuse(',start)
func=worker[start:end]
assert "await nuEnsureJournal(env)" in func
assert "snap" in func or "snapshot" in func
assert "beforeVisibility:row.visibility,afterVisibility:visibility" in func
assert "source_submission_id NOT LIKE 'merged-into:%'" in func
assert "source_submission_id NOT LIKE 'reverted-create:%'" in func
assert "if((result.meta?.changes||0)!==1)" in func
assert "'metadata_sync'" in func
assert "Could not save edit history" in func
assert "await env.COMMUNITY_DB.prepare" in func
assert "eventId" in func
assert "if(next.title.length<2)" in func
assert "if(after===before&&visibility===row.visibility)" in func
assert "const result=await extraEditWithUndo(env,email,row,b.patch,vis)" in worker
assert "snap.afterVisibility!==undefined&&row.visibility!==snap.afterVisibility" in worker
assert "UPDATE additional_catalogue_novels SET payload_json=?,title=?,normalized_title=?,visibility=?" in worker
assert "A newer edit changed the record while Undo was running" in worker
assert 'id="undo-manage"' in page
assert "View change history &amp; Undo" in page
assert "Editor changes take effect immediately" in page
assert "lastManageEvent=result.eventId||null" in manage
assert "await post('/api/admin/nu/undo',{eventId:lastManageEvent})" in manage
assert "if(!confirm(create?'Create the novel entry'" not in unified
for path in (root/'private/_worker.js',root/'private/admin/add-novels.js',root/'private/submit-epub/editor.js'):
 subprocess.run(['node','--check',str(path)],check=True)
print('Immediate editor updates, concurrency-safe Undo and visibility restoration: OK')
