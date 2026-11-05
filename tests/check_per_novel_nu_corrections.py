"""Per-novel Novel Updates URL corrections stay tied to the actual catalogue entry."""
from pathlib import Path
import re, json, subprocess, tempfile
ROOT=Path(__file__).resolve().parents[1]
home=(ROOT/'public/index.html').read_text(encoding='utf8')
page=(ROOT/'public/submit-novel-updates/index.html').read_text(encoding='utf8')
form=(ROOT/'public/submit-novel-updates/form.js').read_text(encoding='utf8')
public=(ROOT/'public/_worker.js').read_text(encoding='utf8')
private=(ROOT/'private/_worker.js').read_text(encoding='utf8')
review=(ROOT/'private/admin/novel-updates-submissions/review.js').read_text(encoding='utf8')
index=json.loads((ROOT/'public/catalogue-submission-index.json').read_text(encoding='utf8'))
source=json.loads((ROOT/'private/admin/catalogue.json').read_text(encoding='utf8'))
source=source if isinstance(source,list) else source['books']
assert len(index)==len(source)==962
assert all(a['id']==b['id'] and a['title']==b['title'] for a,b in zip(index,source))
assert len({x['id'] for x in index})==962
assert all(set(x)=={'id','title'} for x in index)
assert '/submit-novel-updates/?book=' in home
assert "nu?'Refresh details from Novel Updates':'Add Novel Updates link &amp; source details'" in home
assert "&url=${encodeURIComponent(nu||'')}" in home
assert 'id="linked-novel" ' in page and 'id="linked-novel-title"' in page
assert 'selectedBook' in form and 'novelId:selectedBook' in form
assert 'const params=new URLSearchParams(location.search)' in form
assert "const modalKey='conservatory-public-nu-link-intro-v1'" in form
assert "u.hostname!=='www.novelupdates.com'" in public
assert "'/catalogue-submission-index.json'" in public
assert "visibility='published'" in public
assert 'Catalogue ID: ' in public and 'Catalogue title: ' in public
assert "const subject='Novel Updates link: '" in public and "Book #'+novelId" in public
assert "if(input.novelId!==null" in public
assert "if(!Number.isSafeInteger(candidate)||candidate<1)" in public
assert "await communityVerifyTurnstile" in public
assert "if(path==='/api/admin/nu/apply-submitted-link'&&method==='POST')" in private
assert "if(!isEditor(role))return respond({error:'Editor permission required'},403)" in private
assert "if(!sameOrigin(request))return respond({error:'Cross-origin request rejected'},403)" in private
assert "body.replaceExisting!==true" in private
assert "JSON.stringify({...patch,nuUrl:link})" in private
assert "JSON.stringify({...obj,nuUrl:link})" in private
assert "UPDATE conservatory_site_feedback SET status='resolved'" in private
assert 'nu.link.correction.approved' in private
assert "async function approveExistingLink" in review
assert "if(!confirm('This novel already has a Novel Updates link." in review
assert "if(bookId)details(card,'Correction for existing novel'" in review
assert "button('✓ Approve link for this novel'" in review
for file in [ROOT/'public/submit-novel-updates/form.js',ROOT/'private/admin/novel-updates-submissions/review.js']:
 subprocess.run(['node','--check',str(file)],check=True)
for file in [ROOT/'public/index.html']:
 content=file.read_text(encoding='utf8')
 for m in re.finditer(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',content,re.I):
  if not m.group(2).strip() or 'application/json' in m.group(1):continue
  with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf8') as tmp:
   tmp.write(m.group(2));tmp.flush();subprocess.run(['node','--check',tmp.name],check=True)
print('Per-novel NU submission and moderated correction: OK')
