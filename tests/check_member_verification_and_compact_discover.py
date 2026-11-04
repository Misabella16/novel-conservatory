"""Private Discover reflow and shared member verification (no file-management escalation)."""
from pathlib import Path
import re, subprocess, tempfile

root=Path(__file__).resolve().parents[1]
home=(root/'private/index.html').read_text(encoding='utf-8')
worker=(root/'private/_worker.js').read_text(encoding='utf-8')
tour=(root/'private/onboarding-tour.js').read_text(encoding='utf-8')
member=(root/'private/epub-verification/index.html').read_text(encoding='utf-8')
legacy=(root/'private/admin/epub-verification/index.html').read_text(encoding='utf-8')

# Desktop four-column stats, Collections directly beside them; genre and
# story tags below both. Narrow screens collapse into readable rows.
dashboard=home.index('class="stats-collections-row"')
stats=home.index('class="stats"',dashboard)
collections=home.index('id="discover-collections-preview"',dashboard)
genres=home.index('class="region-section"',dashboard)
tags=home.index('class="tag-index-section"',dashboard)
assert dashboard < stats < collections < genres < tags
assert home.count('id="discover-collections-preview"')==1
assert 'grid-template-columns:repeat(4,minmax(0,1fr))' in home
assert '#tab-discover .stats-collections-row{display:grid;' in home
assert '#tab-discover .collections-overview .discover-collection-grid{display:grid;' in home
assert '@media(max-width:1040px)' in home
assert '@media(max-width:640px)' in home
assert 'grid-template-columns:repeat(2,minmax(0,1fr))' in home
assert 'id="stat-complete"' in home and 'id="stat-epubs"' in home
assert 'href="/epub-verification/"' in home
assert '✓ Verify EPUBs' in home
assert 'refreshSharedEpubChecks' in home
assert 'setInterval(refreshSharedEpubChecks,30000)' in home
assert "window.addEventListener('focus',refreshSharedEpubChecks)" in home

# All authenticated private users, and ONLY the review operation, may write
# file-verification status. Every other file-admin endpoint stays owner-only.
assert "email=await verifyAccess(request,env)" in worker
start=worker.index("if(path.startsWith('/api/private/epub/'))")
end=worker.index("if(path==='/api/private/epub/bulk-status'",start)
gate=worker[start:end]
assert "const memberReview=path==='/api/private/epub/review'" in gate
assert "else if(!memberReview&&role!=='owner')" in gate
assert "Only the owner can manage stored EPUBs" in gate
review_start=worker.index('if(memberReview){',end)
review_end=worker.index("const id=Number(url.searchParams.get('id'))",review_start)
review_code=worker[review_start:review_end]
assert "method==='POST'&&!sameOrigin(request)" in review_code
assert "if(typeof body?.verified!=='boolean')" in review_code
assert "epub-verification:" in review_code
assert "reviewedBy:email" in review_code
assert "private.epub.member_review" in review_code
assert "role!=='owner'" not in review_code
assert "site_settings" in worker
assert "verifiedIds" in worker

for page in (member,legacy):
    assert 'Community EPUB verification' in page
    assert 'PRIVATE MEMBERS' in page
    assert "/api/private/epub/review" in page
    assert "every approved private member" in page.lower()
    assert "setInterval(()=>load({quiet:true}),30000)" in page
    assert "window.addEventListener('focus'" in page
    assert "Member review" in page or "member review" in page.lower()
    assert "Owner login is required." not in page
    for m in re.finditer(r'<script\b[^>]*>([\s\S]*?)</script\s*>',page,re.I):
        if not m.group(1).strip():continue
        with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf-8') as tmp:
            tmp.write(m.group(1));tmp.flush()
            subprocess.run(['node','--check',tmp.name],check=True)

assert "Discover: four quick stats" in tour
assert "Discover: genre shelves and tags" in tour
assert "member-reviewed" in tour
assert "✓ Verify EPUBs" in tour
subprocess.run(['node','--check',str(root/'private/onboarding-tour.js')],check=True)
print('Compact private Discover + authenticated collaborative EPUB verification: OK')
