"""Regression checks for first-visit walkthroughs and negative story-tag filters."""
from html.parser import HTMLParser
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]

class IDs(HTMLParser):
    def __init__(self):
        super().__init__();self.ids=set();self.assets=[]
    def handle_starttag(self,tag,attrs):
        data=dict(attrs)
        if data.get('id'):self.ids.add(data['id'])
        if tag in ('script','link'):
            self.assets.append(data.get('src') or data.get('href'))

for site in ('public','private'):
    root=ROOT/site
    home=(root/'index.html').read_text(encoding='utf-8')
    tour=(root/'onboarding-tour.js').read_text(encoding='utf-8')
    css=(root/'onboarding-tour.css').read_text(encoding='utf-8')
    page=IDs();page.feed(home)
    for needed in ('exclude-tag-search','excluded-tag-filters','excluded-tag-active-count','tag-picker-open','search','filter-panel'):
        assert needed in page.ids,(site,needed)
    assert '/onboarding-tour.js' in page.assets
    assert '/onboarding-tour.css' in page.assets
    assert 'data-site="'+site+'"' in home
    assert 'let selectedStatus=new Set()' in home
    assert 'excludedTags=new Set()' in home
    assert ("if(excludedTags.size&&browseTags(d).some" if site=='public' else "if(excludedTags.size&&(d.tags||[]).some") in home
    assert "excludedTags.clear();$('#exclude-tag-search').value=''" in home
    assert 'renderExcludedTagFilters();' in home
    assert 'input[data-excluded-tag]' in home
    assert "data-excluded-tag=" in home
    # A book without known tags should not be hidden by an exclusion filter.
    assert ("if(excludedTags.size&&browseTags(d).some" if site=='public' else "if(excludedTags.size&&(d.tags||[]).some") in home
    for item in ('conservatory-tour-launch','conservatory-tour-card','conservatory-tour-target'):
        assert item in css
    for item in ('setTimeout(start,650)','localStorage.getItem(key)','Skip tutorial','ArrowRight','ArrowLeft','Exclude story tags you dislike','Tags and reader contributions'):
        assert item in tour,(site,item)
    assert "site==='private'" in tour
    subprocess.run(['node','--check',str(root/'onboarding-tour.js')],check=True)
    if site=='private':
        assert 'EPUB linked' in tour
        assert 'id="start-private-tour"' in home
    else:
        assert 'Add story tags directly' in tour
print('Tours and negative-tag filter guards passed for public and private sites.')
