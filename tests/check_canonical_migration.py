"""Shared IDs and reversible EPUB moves are safe under real SQLite constraints."""
from pathlib import Path
import sqlite3,json

root=Path(__file__).resolve().parents[1]
migration=(root/'database/CANONICAL_CATALOGUE_MIGRATION.sql').read_text()
public=(root/'public/_worker.js').read_text()
private=(root/'private/_worker.js').read_text()
db=sqlite3.connect(':memory:')
db.executescript(migration)
db.execute("INSERT INTO canonical_novel_keys(identity_key,novel_id) VALUES(?,?)",('nu:https://www.novelupdates.com/series/example/',100142))
try:
 db.execute("INSERT INTO canonical_novel_keys(identity_key,novel_id) VALUES(?,?)",('nu:https://www.novelupdates.com/series/example/',100270))
 raise AssertionError('Duplicate identity claim was accepted')
except sqlite3.IntegrityError: pass

private_payload={'title':'Private title','synopsis':'PRIVATE NOTES NEVER PUBLISH','epubs':['private-file.epub']}
projection={'title':'Public title','synopsis':'Public contribution'}
db.execute("INSERT INTO public_novel_projections(novel_id,payload_json) VALUES(?,?)",(100142,json.dumps(projection)))
published=db.execute('SELECT payload_json FROM public_novel_projections WHERE novel_id=?',(100142,)).fetchone()[0]
assert 'PRIVATE NOTES NEVER PUBLISH' not in published
assert json.loads(published)==projection
db.execute('INSERT INTO canonical_novel_aliases(source_id,target_id,event_id) VALUES(?,?,?)',(100142,7,'undo-event'))
assert db.execute('SELECT target_id FROM canonical_novel_aliases WHERE source_id=?',(100142,)).fetchone()[0]==7
db.execute('DELETE FROM canonical_novel_aliases WHERE event_id=?',('undo-event',))
assert db.execute('SELECT 1 FROM canonical_novel_aliases').fetchone() is None

db.executescript("""
CREATE TABLE additional_epub_editions(id TEXT PRIMARY KEY,novel_id INTEGER,label TEXT,translator TEXT,language TEXT,filename TEXT,object_key TEXT UNIQUE,bytes INTEGER,uploaded_by TEXT,created_at TEXT);
CREATE TABLE epub_editions(id TEXT PRIMARY KEY,novel_id INTEGER,label TEXT,translator TEXT,language TEXT,filename TEXT,object_key TEXT UNIQUE,bytes INTEGER,uploaded_by TEXT,created_at TEXT);
INSERT INTO additional_epub_editions VALUES('uuid-1',100142,'English','Group A','English','book.epub','r2/uuid-1.epub',1234,'owner','2026-11-05');
""")
# These are the actual SQL forms used by the Worker for original-catalogue
# edition transfers, executed inside one transaction.
fields='id,novel_id,label,translator,language,filename,object_key,bytes,uploaded_by,created_at'
def move(src,dst,origin,target):
 with db:
  db.execute(f'INSERT INTO {dst} ({fields}) SELECT id,?,label,translator,language,filename,object_key,bytes,uploaded_by,created_at FROM {src} WHERE novel_id=? AND id=? AND object_key=?',(target,origin,'uuid-1','r2/uuid-1.epub'))
  db.execute(f'DELETE FROM {src} WHERE novel_id=? AND id=? AND object_key=?',(origin,'uuid-1','r2/uuid-1.epub'))
move('additional_epub_editions','epub_editions',100142,7)
assert db.execute('SELECT object_key FROM epub_editions WHERE novel_id=7').fetchone()[0]=='r2/uuid-1.epub'
assert not db.execute('SELECT 1 FROM additional_epub_editions').fetchone()
move('epub_editions','additional_epub_editions',7,100142)
assert db.execute('SELECT novel_id,object_key FROM additional_epub_editions').fetchone()==(100142,'r2/uuid-1.epub')
assert not db.execute('SELECT 1 FROM epub_editions').fetchone()

assert "public_novel_projections" in public
assert "row.visibility==='private'" in public
assert "publicProjection:true" in public
assert "await canonicalPrivateResolve" in private or "canonicalPrivateResolve(env" in private
assert "nuMoveAssetReferences(env,assetPlan,true)" in private
assert "restoredEditions:" in private
assert "if(role!=='owner')return respond({error:'Owner permission required'},403)" in private
assert "public_novel_projections" in migration
assert "canonical_novel_aliases" in migration
print('Shared canonical identity, separate public projection and SQLite EPUB move/Undo tests: OK')
