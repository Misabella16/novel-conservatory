"""Review real Novel Updates source metadata before applying it to a submitted catalogue entry."""
from pathlib import Path
import subprocess
import tempfile
import re

root=Path(__file__).resolve().parents[1]
private=(root/'private/_worker.js').read_text(encoding='utf-8')
public=(root/'public/_worker.js').read_text(encoding='utf-8')
review=(root/'private/admin/novel-updates-submissions/review.js').read_text(encoding='utf-8')
review_html=(root/'private/admin/novel-updates-submissions/index.html').read_text(encoding='utf-8')
public_index=(root/'public/index.html').read_text(encoding='utf-8')
private_index=(root/'private/index.html').read_text(encoding='utf-8')

start=private.index("if(path==='/api/admin/nu/import-submitted-metadata'&&method==='POST')")
end=private.index("if(path==='/api/admin/nu/apply-submitted-link'",start)
imp=private[start:end]

assert "if(!isEditor(role))return respond({error:'Editor permission required'},403)" in private
assert "if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403)" in imp
assert "nu_staged_series WHERE slug=?" in imp
assert "staged.nu_url!==link" in imp
assert "conservatory_site_feedback WHERE id=? AND scope='public' AND kind='suggestion'" in imp
assert "pending.status!=='pending'" in imp
assert "Catalogue ID:" in imp
assert "SELECT title,payload_json FROM additional_catalogue_novels" in imp
assert "SELECT patch_json FROM published_catalogue_overrides" in imp
assert "SELECT" in imp and "novel_edits" in imp
assert "const allowedFields=new Set(['synopsis','tags','genres','author','originalTitle'])" in imp
assert "const source={" in imp and "saved.synopsis" in imp and "saved.tags" in imp
assert "const patch={...update,nuUrl:link}" in imp
assert "hasCurrent&&!replaceFields" in imp
assert "replaceFields=body.replaceFields===true" in imp
assert "body.replaceExisting!==true" in imp
assert "metadataSource=link" in imp
assert "metadataReview='source-reviewed'" in imp
assert "nu.metadata.imported" in imp
assert "UPDATE conservatory_site_feedback SET status='resolved'" in imp
assert "published_correction_history" in imp
assert "crypto.randomUUID()" in imp
assert "title:" not in imp.split("const patch={...update,nuUrl:link}")[1].split("if(isSeed)")[0]
assert "cover" not in imp.split("const patch={...update,nuUrl:link}")[1].split("if(isSeed)")[0]

# Existing per-book URL-only approval path is still supported.
assert "if(path==='/api/admin/nu/apply-submitted-link'&&method==='POST')" in private
assert "if(path==='/api/admin/nu/lookup'&&method==='GET')" in private
assert "if(path==='/api/admin/nu/stage-browser'&&method==='POST')" in private
assert "if(path==='/api/admin/nu/staged-by-url'&&method==='GET')" in private
assert "originalTitle:extraTxt(metadata.originalTitle,210)" in private

# Importing a source never occurs in the public worker, and guest link
# submission still requires Turnstile and uses the moderated queue.
assert "/api/admin/nu/import-submitted-metadata" not in public
assert "await communityVerifyTurnstile" in public
assert "INSERT INTO conservatory_site_feedback" in public

# Client shows the actual staged source fields, offers missing-only or
# explicit replacement, and never silently publishes on guest submission.
assert "async function showStaged(" in review
assert "async function fetchSource(" in review
assert "'/api/admin/nu/staged-by-url?url='" in review
assert "const result=await api('/api/admin/nu/lookup?url='" in review
assert "await api('/api/admin/nu/stage-browser'" in review
assert "async function showStaged" in review
assert "const IMPORT_FIELDS=" in review
assert "'synopsis','Synopsis'" in review
assert "'genres','Genres'" in review
assert "'tags','Story tags'" in review
assert "'author','Author'" in review
assert "'originalTitle','Original title'" in review
assert "replace.type='checkbox'" in review
assert "replaceFields:replace.checked" in review
assert "submissionId:item.id,confirm:true" in review
assert "/api/admin/nu/import-submitted-metadata" in review
assert "browser-captured Novel Updates JSON" in review or "browser-captured Novel Updates" in review
assert "captured!==url" in review
assert "No metadata has been invented or published." in review
assert "Retrieve & preview NU metadata" in review
assert "Load staged / browser-captured NU data" in review
assert "Missing-only is the default" in review_html
assert "Direct retrieval may return" not in review_html or "403" in review_html

# Both catalogues are allowed to display the imported authors and genres.
for field in ("'genres'","'author'","'originalTitle'","'metadataSource'"):
 assert field in public_index[public_index.index("// Public-only, editor-approved catalogue corrections."):],field
 assert field in private_index[private_index.index("async function loadLiveEditorChanges()"):],field
assert "const allowed=new Set(['tags','genres','author','originalTitle'" in public

for js in (root/'private/admin/novel-updates-submissions/review.js',):
 subprocess.run(['node','--check',str(js)],check=True)
for js in (root/'public/index.html',root/'private/index.html'):
 doc=js.read_text(encoding='utf-8')
 for m in re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',doc,re.I):
  if not m.group(2).strip() or 'application/json' in m.group(1):continue
  with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf-8') as temp:
   temp.write(m.group(2));temp.flush()
   subprocess.run(['node','--check',temp.name],check=True)

print('Novel Updates staged source -> selective, editor-approved existing-novel import: OK')
