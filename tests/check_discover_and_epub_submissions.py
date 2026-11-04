"""Check Discover collection shortcuts, mobile navigation and private EPUB review isolation."""
from pathlib import Path
import re, subprocess, tempfile

root=Path(__file__).resolve().parents[1]
pub=(root/'public/index.html').read_text(encoding='utf-8')
priv=(root/'private/index.html').read_text(encoding='utf-8')
private_api=(root/'private/_worker.js').read_text(encoding='utf-8')
public_api=(root/'public/_worker.js').read_text(encoding='utf-8')
suggestions=(root/'public/suggestions/index.html').read_text(encoding='utf-8')
pages=[root/'private/submit-epub/index.html',root/'private/admin/epub-submissions/index.html',
       root/'public/community/index.html',root/'private/community/index.html']

for name,src in [('public',pub),('private',priv)]:
    assert 'id="discover-collections-preview"' in src,(name,'missing discover section')
    for v in ('data-discover-collection="curated"','data-discover-collection="matchmaker"','data-discover-collection="saved"'):
        assert v in src,(name,v)
    assert 'header .top>.nav.is-open{display:grid!important;' in src,(name,'mobile menu not visible')
    assert 'header .top>.nav:not(.is-open){display:none!important}' in src,(name,'mobile menu closed state')
    assert 'grid-template-columns:1fr' in src,(name,'mobile grid fallback')
    assert 'showLibraryTab(' in src

assert 'data-discover-collection="friends"' in priv
assert 'id="stat-epubs"' in priv
assert 'EPUBs uploaded' in priv
assert 'value.uploadCount' in priv
# Inventory now combines legacy and additional EPUBs in a shared helper
# that also attaches per-file verification status. Both edition tables must
# still contribute to the count without exposing private file references.
inventory=private_api.split('async function epubVerificationInventory(env)')[1].split('async function epubVerificationState')[0]
assert 'FROM epub_editions' in inventory
assert 'FROM additional_epub_editions' in inventory
assert "private-epub:" in inventory
assert "uploadCount:entries.length" in private_api
assert "ids,verifiedIds" in private_api

# Submission endpoints are not present in the public worker; private login
# authorization happens before private routes dispatch.
assert "privateEpubSubmissionRoutes(request,env,email,role)" in private_api
assert "if(!owner)return respond({error:'Owner access required'},403)" in private_api
assert "private-epub-submissions/" in private_api
for needed in ("'/api/epub-submissions/upload'","'/api/epub-submissions/list'","'/api/epub-submissions/download'","'/api/epub-submissions/review'"):
    assert needed in private_api,needed
assert "privateEpubSubmissionRoutes" not in public_api
assert "private-epub-submissions/" not in public_api
assert "request.headers.get('origin')!==new URL(request.url).origin" in private_api
assert "15*1024*1024" in private_api
assert "x-epub-rights" in private_api
assert "status:'pending'" in private_api
assert "if(!owner)return" in private_api
assert "content-disposition" in private_api
assert "auto-published" not in private_api[private_api.index('async function privateEpubSubmissionRoutes'):private_api.index('export default {')]

assert 'I have an EPUB to offer' in suggestions
assert "kind:$('kind').value==='epub-offer'?'suggestion'" in suggestions
for path in pages:
    src=path.read_text(encoding='utf-8')
    assert 'EPUB' in src,path
    assert 'submit-epub' in src or 'epub-submissions/' in src,path
assert 'id="epub-contribution-link"' in pages[2].read_text()
assert 'id="epub-contribution-link"' in pages[3].read_text()
assert 'href="/admin/epub-submissions/"' in (root/'private/admin/index.html').read_text()

# Check every authored new embedded script using real Node parser, in addition
# to the main home-page JavaScript syntax checks already run by CI.
for path in [*pages[:2],pages[2],pages[3],root/'public/suggestions/index.html']:
    html=path.read_text(encoding='utf-8')
    for m in re.finditer(r'<script\b[^>]*>([\s\S]*?)</script\s*>',html,re.I):
        if not m.group(1).strip():continue
        with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf-8') as tmp:
            tmp.write(m.group(1));tmp.flush()
            subprocess.run(['node','--check',tmp.name],check=True)
print('Discover collections, mobile menu, EPUB count, private review and request links: OK')
