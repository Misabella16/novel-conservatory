"""Regression checks for private Cloudflare sign-out and public local-only reset."""
from pathlib import Path
import subprocess
from html.parser import HTMLParser

root=Path(__file__).resolve().parents[1]
logout='/cdn-cgi/access/logout'
private=[
 root/'private/index.html',
 root/'private/admin/index.html',
 root/'private/read/index.html',
]
for path in private:
    text=path.read_text(encoding='utf-8')
    assert f'href="{logout}"' in text, f"Missing sign-out link in {path}"
    assert "Sign out" in text
    assert "confirm(" in text, "Sign-out should warn about ending other Access sessions"
    assert "localStorage.clear" not in text, "Sign out must not delete device reading preferences"

public=(root/'public/index.html').read_text(encoding='utf-8')
assert 'id="clear-public-saved"' in public
assert 'id="clear-public-collections"' in public
assert 'src="/saved-data-controls.js"' in public
assert f'href="{logout}"' not in public, "Anonymous public site must not claim to end Access session"
control=(root/'public/saved-data-controls.js').read_text(encoding='utf-8')
assert "window.confirm(" in control
assert "localStorage.removeItem(favoritesKey)" in control
assert "localStorage.removeItem(collectionsKey)" in control
assert "localStorage.clear(" not in control
assert "sessionStorage.clear(" not in control
assert "fetch(" not in control
assert "window.location.reload()" in control
for key in ('novel-conservatory-favorites','conservatory-public-personal-collections-v1'):
    assert key in control
subprocess.run(['node','--check',str(root/'public/saved-data-controls.js')],check=True)
print('Private Access logout and public-only saved-data removal: OK')
