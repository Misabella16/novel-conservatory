"""Recover existing EPUB metadata and covers with private-only permissions and explicit review."""
from pathlib import Path
import subprocess,re,tempfile
root=Path(__file__).resolve().parents[1]
worker=(root/'private/_worker.js').read_text(encoding='utf8')
js=(root/'private/admin/epub-insights.js').read_text(encoding='utf8')
page=(root/'private/admin/epub-insights.html').read_text(encoding='utf8')
home=(root/'private/index.html').read_text(encoding='utf8')
public=(root/'public/_worker.js').read_text(encoding='utf8')

assert "id=\"scan-existing\"" in page
assert "id=\"stop-scan\"" in page
assert "id=\"scan-cover-gallery\"" in page
assert "id=\"embedded-cover-preview\"" in page
assert "id=\"embedded-cover-rights\"" in page
assert "id=\"embedded-cover-save\"" in page
assert "id=\"embedded-cover-replace\"" in page
assert "/admin/cover-extractor.js" in page
assert "No reupload and no public publication" in page
assert "cover image" not in page.split('class="cover-gallery"')[0] or "private" in page

assert "async function storedEpubFile(" in js
assert "/api/private/epub/file?id=" in js
assert "/api/private/edition/file?id=" in js
assert "CoverExtractor.detectCover" in js
assert "scanCursor+=batch.length" in js
assert "slice(scanCursor,scanCursor+8)" in js
assert "const file=await storedEpubFile(item);" in js
assert "stats.scanned++" in js
assert "if(existing.draft){stats.skipped++;continue}" in js
assert "source:'EPUB package metadata'" in js
assert "action:'draft'" in js
assert "rightsConfirmed','true'" in js
assert "confirm','true'" in js
assert "publicPublished" in js
assert "displayScannedCover(" in js
assert "URL.revokeObjectURL" in js
assert "function resetCoverPreview()" in js
assert "if(!confirm(" in js
assert "No public or private catalogue fields will be changed" in js
assert "await inspectCover(file)" in js

assert "if(path==='/api/admin/epub-insights/private-cover')return privateEpubCoverRoute" in worker
start=worker.index("async function privateEpubCoverRoute(")
end=worker.index("const INSIGHT_KEY=",start)
private=worker[start:end]
assert "if(!isEditor(role)||!await canReadEpubs(email,role,env))" in private
assert "if(request.method!=='POST'||!strictOrigin(request))" in private
assert "form.get('rightsConfirmed')!=='true'||form.get('confirm')!=='true'" in private
assert "form.get('replace')==='true'" in private
assert "if(already&&!replace)" in private
assert "if(edition==='legacy'&&id<=962)" in private
assert "editionUuid(edition)" in private
assert "SELECT id FROM '+editionTable(id)+' WHERE novel_id=? AND id=?" in private
assert "v[0]!==255||v[1]!==216||v[2]!==255" in private
assert "env.IMAGES.put(key,bytes" in private
assert "'private-epub-cover:'" in worker
assert "publicPublished:false" in private
assert "env.COMMUNITY_IMAGES.put(" not in private
assert "published_catalogue_overrides SET" not in private
assert "additional_catalogue_novels SET" not in private
assert "UPDATE novel_edits" not in private
assert "private-epub-cover:%" in worker
assert "const edits=(novels.results||[])" in worker
assert "if(await canReadEpubs(email,role,env))" in worker
assert "extra.cover=cover" in worker
assert "edit.patch={...edit.patch,cover" in worker
assert "if(path==='/api/content'&&method==='GET')" in worker
assert "const cover=String(value?.cover||'')" in worker
assert "/api/admin/epub-insights/private-cover" not in public

for path in [root/'private/admin/epub-insights.js',root/'private/admin/cover-extractor.js']:
 subprocess.run(['node','--check',str(path)],check=True)
for m in re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',page,re.I):
 if 'application/json' in m.group(1) or not m.group(2).strip():continue
 with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf8') as tmp:
  tmp.write(m.group(2));tmp.flush()
  subprocess.run(['node','--check',tmp.name],check=True)
assert "function loadLiveEditorChanges()" in home
assert "for(const key of ['title','originalTitle','author','translator','synopsis'" in home
print('Existing stored EPUB metadata recovery and private, rights-reviewed cover backfill: OK')
