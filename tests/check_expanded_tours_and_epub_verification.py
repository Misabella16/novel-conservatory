"""Expanded section tours and per-file private EPUB verification regression checks."""
from pathlib import Path
import re, subprocess, tempfile
from html.parser import HTMLParser

ROOT=Path(__file__).resolve().parents[1]

def embedded_scripts_ok(html):
    for match in re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',html,re.I):
        attrs,body=match.group(1),match.group(2)
        if not body.strip():continue
        if 'application/json' in attrs or 'application/ld+json' in attrs:
            import json
            json.loads(body)
            continue
        with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf-8') as temp:
            temp.write(body);temp.flush()
            subprocess.run(['node','--check',temp.name],check=True)

for site in ('public','private'):
    folder=ROOT/site
    home=(folder/'index.html').read_text(encoding='utf-8')
    tour=(folder/'onboarding-tour.js').read_text(encoding='utf-8')
    style=(folder/'onboarding-tour.css').read_text(encoding='utf-8')
    subprocess.run(['node','--check',str(folder/'onboarding-tour.js')],check=True)
    for phrase in (
        "conservatory-tour-seen-v3-","Jump to a section","The cover hover trick",
        "MOVE YOUR POINTER OVER","HOVER over a cover",
        "List View","Cover View","Sort dropdown","ANY versus ALL dropdown",
        "Exclude story tags you dislike","Matchmaker: three dropdowns",
        "Collections: featured books","Other pages, help & sharing",
        "Show all library sections"
    ):
        if phrase=='Show all library sections':
            assert phrase in home,(site,phrase)
        else:
            assert phrase in tour,(site,phrase)
    for phrase in (
        "function curated()","function matchmaker()","function setLayout(mode)",
        "function showSaved()","function revealMenu()","function hideMenu()",
        "jump.addEventListener('change'","document.createElement('option')",
        "const key='conservatory-tour-seen-v3-'+site",
        "if(step.action==='menu')revealMenu()",
    ):
        assert phrase in tour,(site,phrase)
    assert '#conservatory-tour-jump' in style
    assert 'conservatory-tour-launch' in style
    assert 'src="/onboarding-tour.js"' in home
    assert 'href="/submit-novel-updates/"' in home if site=='public' else 'href="/submit-epub/"' in home
    # Home pages already have extensive dynamic scripting: validate each inline block.
    embedded_scripts_ok(home)

priv=(ROOT/'private/index.html').read_text(encoding='utf-8')
worker=(ROOT/'private/_worker.js').read_text(encoding='utf-8')
owner=(ROOT/'private/admin/index.html').read_text(encoding='utf-8')
review=(ROOT/'private/admin/epub-verification/index.html').read_text(encoding='utf-8')
assert "privateEpubVerified=new Set()" in priv
assert "Array.isArray(value.verifiedIds)" in priv
assert "epub-verified-label" in priv
assert "✓ EPUB verified" in priv
assert "id=\"epub-presence-filter\"" in priv
assert '<option value="verified">✓ Verified EPUB only</option>' in priv
assert '<option value="unverified">EPUB awaiting verification</option>' in priv
assert "privateEpubFilter==='verified'" in priv
assert "privateEpubFilter==='unverified'" in priv
assert "has-linked-epub" in priv
assert "verifiedIds" in worker
assert "verifiedCount" in worker
assert "EPUB_VERIFY_BASELINE='epub-verification-baseline-v1'" in worker
assert "ON CONFLICT(key) DO NOTHING" in worker
assert "new Set(parsed.keys.filter(epubVerifyFileKey))" in worker
assert "existing.has(item.fileKey)" in worker
assert "review.has(item.fileKey)?review.get(item.fileKey):existing.has(item.fileKey)" in worker
assert "if(!epubVerifyFileKey(row.object_key))continue" in worker
assert "await ensureEpubVerificationBaseline(env);" in worker
assert worker.count("await ensureEpubVerificationBaseline(env);")>=2
assert "if(path==='/api/private/epub/review'" in worker
assert "if(role!=='owner')return respond({error:'Owner permission required'},403)" in worker
assert "if(typeof body?.verified!=='boolean')" in worker
assert "site_settings" in worker
assert "epub-verification:" in worker
assert "private-epub-submissions/" not in worker[worker.index("async function epubVerificationInventory"):worker.index("async function editionRoutes")]
assert '<a href="/admin/epub-verification/"' in owner
assert "EPUB verification checklist" in review
assert "Owner login is required." in review
assert "/api/private/epub/review" in review
assert "confirm(" in review
assert "✓ Mark verified" in review
assert "Remove checkmark" in review
assert "Awaiting verification" in review
embedded_scripts_ok(review)
print('Expanded tutorials + owner-reviewed per-edition EPUB verification checks: OK')
