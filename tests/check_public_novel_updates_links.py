"""Public NU link intake, once-only help dialog, and private editor staging contract."""
from pathlib import Path
import re
import subprocess
import tempfile

root=Path(__file__).resolve().parents[1]
public_api=(root/'public/_worker.js').read_text(encoding='utf-8')
private_api=(root/'private/_worker.js').read_text(encoding='utf-8')
home=(root/'public/index.html').read_text(encoding='utf-8')
form=(root/'public/submit-novel-updates/index.html').read_text(encoding='utf-8')
form_js=(root/'public/submit-novel-updates/form.js').read_text(encoding='utf-8')
queue=(root/'private/admin/novel-updates-submissions/index.html').read_text(encoding='utf-8')
queue_js=(root/'private/admin/novel-updates-submissions/review.js').read_text(encoding='utf-8')
suggestions=(root/'public/suggestions/index.html').read_text(encoding='utf-8')
novel=(root/'public/submit-novel/index.html').read_text(encoding='utf-8')
nu_editor=(root/'private/admin/novel-updates.html').read_text(encoding='utf-8')
admin=(root/'private/admin/index.html').read_text(encoding='utf-8')
for name,text in [('public home',home),('public suggestions',suggestions),('public add novel',novel)]:
    assert '/submit-novel-updates/' in text,name
for name,text in [('NU editor',nu_editor),('private admin',admin)]:
    assert '/admin/novel-updates-submissions/' in text,name

assert '<dialog id="info-dialog"' in form
assert 'id="explain"' in form
assert 'id="remember-explanation"' in form
assert "conservatory-public-nu-link-intro-v1" in form_js
assert "localStorage.getItem(modalKey)" in form_js
assert "localStorage.setItem(modalKey,'1')" in form_js
assert "dialog.showModal()" in form_js
assert "dialog.close()" in form_js
assert "if(remember.checked)" in form_js
assert "window" not in form_js or "turnstile" in form_js
assert "novelupdates.com/series/" in form
assert "value.hostname!=='www.novelupdates.com'" in form_js
assert "value.search||value.hash" in form_js

assert "if(path==='/api/nu-links/submit')return publicNovelUpdatesLinkSubmit(request,env);" in public_api
public_function=public_api.split('async function publicNovelUpdatesLinkSubmit(request,env){')[1].split('async function siteFeedbackRoute')[0]
for guard in ["request.method!=='POST'","get('Origin')!==url.origin","get('content-type')","TURNSTILE_SECRET","TURNSTILE_SITE_KEY","communityVerifyTurnstile","value",'submit']:
    if guard=='value':continue
    if guard=='submit':continue
    assert guard in public_function,guard
assert "u.hostname!=='www.novelupdates.com'" in public_function
assert "u.search||u.hash" in public_function
assert "SELECT id FROM conservatory_site_feedback" in public_function
assert "INSERT INTO conservatory_site_feedback" in public_function
assert "kind" in public_function and "'suggestion'" in public_function
assert "nu_staged_series" not in public_function
assert "fetch(target" not in public_function
assert "epub" not in public_function.lower()
assert "if(path==='/api/admin/nu/lookup'" in private_api
assert "if(path==='/api/admin/nu/stage-browser'" in private_api
assert "if(!isEditor(role))return respond({error:'Editor permission required'},403)" in private_api

assert "id=\"refresh\"" in queue
assert "async function load()" in queue_js
assert "/api/admin/site-feedback?status=pending" in queue_js
assert "/api/admin/nu/lookup?url=" in queue_js
assert "DOMParser()" in queue_js
assert "textContent=novel.synopsis" in queue_js
assert "/api/admin/nu/stage-browser" in queue_js
assert "source:'novelupdates-browser-v1'" in queue_js
assert "/api/admin/novel-updates.html" not in queue_js
assert "Mark resolved" in queue_js
assert "status:'pending'" in public_function
assert "Nothing is made up" in form

for path in [root/'public/submit-novel-updates/form.js',root/'private/admin/novel-updates-submissions/review.js']:
    subprocess.run(['node','--check',str(path)],check=True)
for path in [root/'public/submit-novel-updates/index.html',root/'private/admin/novel-updates-submissions/index.html']:
    html=path.read_text(encoding='utf-8')
    for match in re.finditer(r'<script\b[^>]*>([\s\S]*?)</script>',html,re.I):
        if not match.group(1).strip():continue
        with tempfile.NamedTemporaryFile(suffix='.js',mode='w',encoding='utf-8') as temp:
            temp.write(match.group(1));temp.flush()
            subprocess.run(['node','--check',temp.name],check=True)
print('Public Novel Updates link intake and private source staging contract: OK')
