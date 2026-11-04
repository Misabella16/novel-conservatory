"""Verify private EPUB indicator wiring and embedded homepage JavaScript."""
import json
import re
import subprocess
import tempfile
from pathlib import Path

root=Path(__file__).resolve().parents[1]
home=(root/"private/index.html").read_text(encoding="utf-8")
worker=(root/"private/_worker.js").read_text(encoding="utf-8")

required_html=[
    'id="epub-presence-filter"',
    '<option value="linked">With EPUB</option>',
    '<option value="unlinked">Without EPUB</option>',
    'class="epub-linked-label"',
    "privateEpubLinked.has(Number(d.id))",
    "privateEpubReady&&privateEpubFilter==='unlinked'",
    "privateEpubReady&&privateEpubFilter==='linked'",
    "privateEpubReady=false;privateEpubFilter='all'",
    "privateEpubFilter='all';$('#epub-presence-filter').value='all'",
    "'/api/private/epub/availability'",
]
for item in required_html:
    assert item in home, f"Missing filter or safe UI behavior: {item}"

route_start=worker.index("if(path==='/api/private/epub/availability'&&method==='GET')")
route_end=worker.index("if(path.startsWith('/api/private/epub/'))",route_start)
route=worker[route_start:route_end]
for expected in ["epub_editions", "additional_epub_editions", "private-epub:", "ids:[...linked]", "complete:true"]:
    assert expected in route, f"Missing complete inventory source: {expected}"
for private_field in ["filename", "bytes", "httpMetadata", ".get("]:
    assert private_field not in route, "Presence endpoint must not return files or private metadata"
assert "if(path==='/api/private/epub/availability'" in worker
assert "email=await verifyAccess(request,env)" in worker

scripts=re.findall(r'<script\b([^>]*)>([\s\S]*?)</script\s*>',home,flags=re.I)
assert scripts, "No homepage scripts found"
checked=0
for attrs,body in scripts:
    if 'application/json' in attrs:
        json.loads(body)
    elif body.strip():
        with tempfile.NamedTemporaryFile("w",suffix=".js",encoding="utf-8") as f:
            f.write(body)
            f.flush()
            subprocess.run(["node","--check",f.name],check=True)
        checked+=1
assert checked>=1
print(f"Private EPUB indicator wiring, safety invariants and {checked} inline script(s): OK")
