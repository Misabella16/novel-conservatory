"""Verify the public About & Guide page is linked and safe to ship."""
from html.parser import HTMLParser
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
home=(ROOT/'public/index.html').read_text(encoding='utf-8')
about=(ROOT/'public/about/index.html').read_text(encoding='utf-8')
class Page(HTMLParser):
    def __init__(self):
        super().__init__();self.ids=set();self.links=[];self.errors=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if 'id' in a:self.ids.add(a['id'])
        if tag=='a':self.links.append(a.get('href',''))
        if tag in ('script','img') and a.get('src','').startswith('http:'):
            self.errors.append('insecure external resource')
page=Page();page.feed(about);page.close()
assert '<a class="navbtn" id="about-nav" href="/about/">About &amp; Guide</a>' in home
assert "openModal(`<div class=\"sec-kicker\">About this collection" not in home
assert '/about/' not in ('/api/private/epub/file',)
for required in ('start','features','use','contribute','editors'):
    assert required in page.ids, 'Missing section: '+required
for required in ('/submit-novel/','https://novel-conservatory.pages.dev/admin/public-site.html',
                 'https://github.com/Misabella16/novel-conservatory/actions/workflows/deploy-conservatory.yml'):
    assert required in page.links, 'Missing link: '+required
assert not page.errors
assert 'No private EPUB downloads' in about
assert 'DEPLOY PUBLIC' in about
print('Public About guide navigation, links, editor instructions and privacy messaging: OK')
