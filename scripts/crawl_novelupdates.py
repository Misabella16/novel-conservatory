#!/usr/bin/env python3
"""Retrieve authorized Novel Updates listing pages and stage literal source metadata.

This crawler has no proxy rotation, CAPTCHA solving or authentication bypass.
On denial (403/429/503/challenge), it stops. New records stay unpublished.
"""
import argparse
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from bs4 import BeautifulSoup
from import_novelupdates import d1, parse

ORIGIN = "https://www.novelupdates.com"
HEADERS = {"User-Agent": os.getenv("NU_USER_AGENT", "NovelConservatoryAuthorizedMetadataImporter/1.0"), "Accept": "text/html,application/xhtml+xml"}
PAUSE = max(2.0, float(os.getenv("NU_REQUEST_INTERVAL_SECONDS", "4")))
def get(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "www.novelupdates.com":
        raise RuntimeError("Requests are restricted to www.novelupdates.com")
    req=urllib.request.Request(url,headers=HEADERS)
    try:
        with urllib.request.urlopen(req,timeout=22) as res:
            if res.url!=url and urllib.parse.urlsplit(res.url).hostname!="www.novelupdates.com":
                raise RuntimeError("Unexpected cross-site redirect")
            if "html" not in res.headers.get("Content-Type","").lower():
                raise RuntimeError("Unexpected non-HTML response")
            body=res.read(1_500_001)
    except urllib.error.HTTPError as exc:
        if exc.code in (403,429,503):
            raise RuntimeError("Novel Updates denied the request (HTTP "+str(exc.code)+"); stopping without bypass") from exc
        raise
    if len(body)>1_500_000:raise RuntimeError("Page exceeds 1.5 MB limit")
    soup=BeautifulSoup(body,"html.parser")
    raw=soup.get_text(" ",strip=True).lower()
    if any(x in raw[:7000] for x in ("attention required! | cloudflare","checking your browser before accessing","verify you are human","access denied | cloudflare")):
        raise RuntimeError("Novel Updates challenge page detected; stopping without bypass")
    return soup

def clean(node):
    return node.get_text(" ",strip=True) if node else ""
def first_text(soup,selectors):
    for q in selectors:
        node=soup.select_one(q)
        if node:
            val=clean(node)
            if val:return val
    return ""
def terms(soup,selectors):
    output=[]
    for q in selectors:
        for node in soup.select(q):
            val=clean(node)
            if val and val not in output and len(val)<=100:output.append(val)
    return output[:60]
def url_for_series(value):
    try:
        x=urllib.parse.urlsplit(value)
        if x.scheme!="https" or x.hostname not in ("novelupdates.com","www.novelupdates.com"):return None
        m=re.fullmatch(r"/series/([a-z0-9][a-z0-9-]{0,190})/?",x.path.lower())
        return ORIGIN+"/series/"+m.group(1)+"/" if m else None
    except (ValueError,AttributeError):return None
def listing_links(soup):
    found=[]
    for a in soup.select('a[href*="/series/"]'):
        href=url_for_series(urllib.parse.urljoin(ORIGIN,a.get("href","")))
        if href and href not in found:found.append(href)
    return found
def info(soup,url):
    title=first_text(soup,[".seriestitlenu","#edit-title",".series-title","h1"])
    synopsis=first_text(soup,["#editdescription","#seriesdescription",".series-description","#showdescription",".seriesdescription"])
    author=first_text(soup,["#showauthors","#seriesauthors",".author-content"])
    genres=terms(soup,["#seriesgenre a","#showgenres a",".seriesgenre a"])
    tags=terms(soup,["#showtags a","#seriestags a",".seriestags a"])
    originals=first_text(soup,["#editassociated","#seriesothernames","#showassociated","#seriesassociated"])
    cover=""
    for selector in ["#seriesimg img",".seriesimg img",".series-image img"]:
        img=soup.select_one(selector)
        if img:
            candidate=img.get("data-src") or img.get("src") or ""
            candidate=urllib.parse.urljoin(ORIGIN,candidate)
            if candidate.startswith("https://"):cover=candidate[:900]
            break
    if len(title)<2:raise RuntimeError("No series title found: unexpected page shape")
    return {"title":title[:210],"author":author[:140],"synopsis":synopsis[:6000],"genres":genres,
        "tags":tags,"originalTitle":originals[:210],"coverUrl":cover,"nuUrl":url}
SQL = """INSERT INTO nu_staged_series(slug,nu_url,title,author,payload_json,cover_url,source_hash)
VALUES (?,?,?,?,?,?,?)
ON CONFLICT(slug) DO UPDATE SET
nu_url=excluded.nu_url,
title=CASE WHEN nu_staged_series.custom_locked=1 OR nu_staged_series.state='published' THEN nu_staged_series.title ELSE excluded.title END,
author=CASE WHEN nu_staged_series.custom_locked=1 OR nu_staged_series.state='published' THEN nu_staged_series.author ELSE excluded.author END,
payload_json=CASE WHEN nu_staged_series.custom_locked=1 OR nu_staged_series.state='published' THEN nu_staged_series.payload_json ELSE excluded.payload_json END,
cover_url=CASE WHEN nu_staged_series.custom_locked=1 OR nu_staged_series.state='published' THEN nu_staged_series.cover_url ELSE excluded.cover_url END,
source_hash=excluded.source_hash,last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP"""
def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start-page",type=int,default=0,help="Override saved cursor. Defaults to resume from D1.")
    ap.add_argument("--pages",type=int,default=3,help="Directory pages per run (1-10).")
    ap.add_argument("--dry-run",action="store_true")
    args=ap.parse_args()
    if args.pages<1 or args.pages>10:ap.error("--pages must be 1-10")
    if args.start_page<0:ap.error("--start-page must be >=0")
    page=args.start_page or 1
    if not args.dry_run and args.start_page==0:
        try:
            # Uses D1 query REST API to retrieve the saved cursor.
            import urllib.request
            api="https://api.cloudflare.com/client/v4/accounts/"+os.environ["CLOUDFLARE_ACCOUNT_ID"]+"/d1/database/"+os.environ["COMMUNITY_D1_DATABASE_ID"]+"/query"
            request=urllib.request.Request(api,data=json.dumps({"sql":"SELECT next_page FROM nu_import_progress WHERE source='novelupdates'","params":[]}).encode(),
                headers={"Authorization":"Bearer "+os.environ["CLOUDFLARE_D1_API_TOKEN"],"Content-Type":"application/json"},method="POST")
            with urllib.request.urlopen(request,timeout=20) as r:response=json.load(r)
            page=max(1,int((response["result"][0].get("results") or [{"next_page":1}])[0]["next_page"]))
        except Exception as exc:raise RuntimeError("Could not load import cursor. Ensure migration is applied: "+str(exc)) from exc
    saved=0
    for number in range(page,page+args.pages):
        directory=ORIGIN+"/novelslisting/?pg="+str(number)
        print("Directory",directory,flush=True)
        links=listing_links(get(directory))
        if not links:
            raise RuntimeError("No series links found. Stopping: directory may be blocked or the page structure changed.")
        for index,url in enumerate(links,1):
            if (number,index)!=(page,1):time.sleep(PAUSE+random.uniform(0,1))
            try:result=info(get(url),url)
            except RuntimeError:
                raise
            except Exception as exc:
                print("Skipped",url,str(exc)[:150],file=sys.stderr)
                continue
            row=parse(result)
            if not row:continue
            if args.dry_run:
                print(json.dumps(result,ensure_ascii=False)[:450]);continue
            d1(SQL,list(row));saved+=1
        if not args.dry_run:
            d1("UPDATE nu_import_progress SET next_page=?,last_run_at=CURRENT_TIMESTAMP,last_success_at=CURRENT_TIMESTAMP,last_error='',processed_count=processed_count+? WHERE source='novelupdates'",[number+1,saved])
        print("Completed page",number,"series",len(links),"newly staged this run",saved,flush=True)
    print("Done. No entries published. Next cursor",page+args.pages)
if __name__=="__main__":
    main()
