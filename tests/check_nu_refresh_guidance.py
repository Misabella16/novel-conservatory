"""Public instructions and contextual source-link refreshes for already-linked novels."""
from pathlib import Path
import subprocess, re, tempfile

root=Path(__file__).resolve().parents[1]
profile=(root/'public/index.html').read_text(encoding='utf8')
form_html=(root/'public/submit-novel-updates/index.html').read_text(encoding='utf8')
form_js=(root/'public/submit-novel-updates/form.js').read_text(encoding='utf8')
about=(root/'public/about/index.html').read_text(encoding='utf8')
tour=(root/'public/onboarding-tour.js').read_text(encoding='utf8')
private_worker=(root/'private/_worker.js').read_text(encoding='utf8')
public_worker=(root/'public/_worker.js').read_text(encoding='utf8')
review=(root/'private/admin/novel-updates-submissions/review.js').read_text(encoding='utf8')

assert '↻ Submit / Refresh NU' in profile
assert "nu?'Refresh details from Novel Updates':'Add Novel Updates link &amp; source details'" in profile
assert "&url=${encodeURIComponent(nu||'')}" in profile
assert "copy its series URL" in profile[profile.index("function renderDetail(d)"):profile.index("function openDetail(d)")]
assert "Even an already-linked novel can request updated synopsis, genres, tags and a cover reference" in profile
assert 'title="Submit or refresh information from the actual Novel Updates series listing"' in profile

assert "id=\"linked-novel\"" in form_html
assert "The exact novel is already selected" in form_html
assert "submit the <strong>existing link again</strong>" in form_html
assert "id=\"submission-heading\"" in form_html
assert "id=\"nu-url\"" in form_html
assert "already see a Novel Updates link".lower() in form_html.lower()
assert "cover artwork" in form_html.lower()
assert "an editor will try to pull" in form_html.lower()
assert "not copied to this site without a separate image-rights and credit review" in form_html
for name in ("Synopsis","Genres and story tags","Cover artwork reference","Author and original title","Novel Updates URL correction"):
 assert f'value="{name}"' in form_html
assert form_html.count('name="nu-target"')==5
assert "Copy the exact series URL" in form_html

assert "const prefilled=canonical(params.get('url')||'')" in form_js
assert "if(selectedBook&&prefilled)" in form_js
assert "$('nu-url').value=prefilled" in form_js
assert "nuUrl:url,novelId:selectedBook" in form_js
assert "'Requested source fields: '" in form_js
assert "input[name=\"nu-target\"]:checked" in form_js
assert "turnstile:token" in form_js
assert "const modalKey='conservatory-public-nu-link-intro-v1'" in form_js
assert "Paste" in form_html and "Never" not in form_js

assert "Three ways to contribute." in about
assert "Refresh a novel using Novel Updates" in about
assert "copy its existing NU series URL" in about
assert "cover artwork requires separate rights approval" in about
assert "Refresh a novel from Novel Updates" in tour
assert "A novel can already have a Novel Updates link" in tour

assert "SELECT title,author,payload_json,nu_url,cover_url,custom_locked FROM nu_staged_series" in private_worker
assert "coverUrl:extraUrl(row.cover_url)" in private_worker
assert "View cover referenced on Novel Updates" in review
assert "Cover reference only:" in review
assert "image permission and credit" in review
assert "source:" not in profile[profile.index('function renderDetail(d)'):profile.index('function openDetail(d)')].split('const nu=')[0]
assert "if(path==='/api/nu-links/submit')" in public_worker
assert "await communityVerifyTurnstile" in public_worker
assert "if(path==='/api/admin/nu/import-submitted-metadata'&&method==='POST')" in private_worker
assert "const allowedFields=new Set(['synopsis','tags','genres','author','originalTitle'])" in private_worker
assert "Cover reference only" in review
assert "coverUrl" not in private_worker.split("const allowedFields=new Set(")[1].split(");")[0]

for path in (root/'public/submit-novel-updates/form.js',
             root/'public/onboarding-tour.js',
             root/'private/admin/novel-updates-submissions/review.js'):
 subprocess.run(['node','--check',str(path)],check=True)
for path in (root/'public/index.html',):
 src=path.read_text(encoding='utf8')
 for m in re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',src,re.I):
  if 'application/json' in m.group(1) or not m.group(2).strip():continue
  with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf8') as tmp:
   tmp.write(m.group(2));tmp.flush()
   subprocess.run(['node','--check',tmp.name],check=True)

print('Existing NU links can request a reviewed source refresh, with cover rights clearly separated: OK')
