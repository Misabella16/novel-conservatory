#!/usr/bin/env python3
"""Stage authorized Novel Updates JSON/JSONL export in Cloudflare D1.

Does not scrape protected pages, publish novels, or modify EPUBs.
Use NU_EXPORT_URL (HTTPS) or pass a local export file path. Run migration first.
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

def parse(raw):
    if not isinstance(raw, dict):
        return None
    url = str(raw.get("nuUrl") or raw.get("nu_url") or raw.get("url") or "").strip()
    p = urllib.parse.urlparse(url)
    if p.scheme != "https" or p.hostname not in ("novelupdates.com","www.novelupdates.com"):
        return None
    m = re.fullmatch(r"/series/([a-z0-9][a-z0-9-]{0,190})/?",p.path.lower())
    if not m or len(str(raw.get("title") or "").strip()) < 2:
        return None
    slug = m.group(1)
    url = "https://www.novelupdates.com/series/" + slug + "/"
    payload = {k:raw.get(k) for k in ("title","originalTitle","author","synopsis","genres","tags","originalLanguage","language","translation","novelOrigin") if raw.get(k) is not None}
    for k in ("tags","genres"):
        a = payload.get(k,[])
        if isinstance(a,str):a=a.split(",")
        payload[k]=list(dict.fromkeys(str(t).strip()[:100] for t in a if str(t).strip()))[:50]
    payload.update(title=str(raw["title"]).strip()[:210],author=str(raw.get("author") or "").strip()[:140],nuUrl=url,sourceUrl=url,metadataSource="Novel Updates (authorized import)")
    cover = str(raw.get("coverUrl") or raw.get("cover_url") or "").strip()[:900]
    if cover and urllib.parse.urlparse(cover).scheme != "https":cover = ""
    body = json.dumps(payload,sort_keys=True,ensure_ascii=False,separators=(",",":"))
    digest = hashlib.sha256((body+cover).encode()).hexdigest()
    return (slug,url,payload["title"],payload["author"],body,cover,digest)

def read_records(source):
    if source.startswith("https://"):
        req=urllib.request.Request(source,headers={"User-Agent":"NovelConservatoryAuthorizedImport/1.0"})
        with urllib.request.urlopen(req,timeout=45) as response:content=response.read(80_000_001)
    else:content=Path(source).read_bytes()
    if len(content)>80_000_000:raise ValueError("Export too large: split into smaller batches")
    text=content.decode("utf-8-sig")
    try:
        obj=json.loads(text)
        if isinstance(obj,dict):obj=obj.get("novels",[])
        if not isinstance(obj,list):raise ValueError("Expected JSON array or novels array")
        return obj
    except json.JSONDecodeError:
        return [json.loads(line) for line in text.splitlines() if line.strip()]

def d1(sql,params):
    account=os.environ["CLOUDFLARE_ACCOUNT_ID"]
    db=os.environ["COMMUNITY_D1_DATABASE_ID"]
    token=os.environ["CLOUDFLARE_D1_API_TOKEN"]
    endpoint="https://api.cloudflare.com/client/v4/accounts/"+account+"/d1/database/"+db+"/query"
    for attempt in range(4):
        request=urllib.request.Request(endpoint,data=json.dumps({"sql":sql,"params":params}).encode(),headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"},method="POST")
        try:
            with urllib.request.urlopen(request,timeout=30) as res:data=json.load(res)
            if not data.get("success"):raise RuntimeError(str(data.get("errors",[]))[:250])
            return
        except Exception:
            if attempt==3:raise
            time.sleep(2**attempt)

def main():
    source=os.getenv("NU_EXPORT_URL") or (sys.argv[1] if len(sys.argv)>1 else "")
    if not source or not (source.startswith("https://") or Path(source).is_file()):
        sys.exit("Provide NU_EXPORT_URL (HTTPS) or a local authorized JSON/JSONL export file")
    rows=read_records(source)
    parsed={}
    for raw in rows:
        item=parse(raw)
        if item:parsed[item[0]]=item
    print("Recognized",len(parsed),"series")
    if not parsed:sys.exit("No valid Novel Updates records")
    if os.getenv("DRY_RUN")=="true":
        print("Dry-run sample:",next(iter(parsed.values()))[:4])
        return
    sql="""INSERT INTO nu_staged_series(slug,nu_url,title,author,payload_json,cover_url,source_hash)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET
    nu_url=excluded.nu_url,
    title=CASE WHEN custom_locked=1 THEN title ELSE excluded.title END,
    author=CASE WHEN custom_locked=1 THEN author ELSE excluded.author END,
    payload_json=CASE WHEN custom_locked=1 THEN payload_json ELSE excluded.payload_json END,
    cover_url=CASE WHEN custom_locked=1 THEN cover_url ELSE excluded.cover_url END,
    source_hash=excluded.source_hash,last_seen_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP"""
    for n,row in enumerate(parsed.values(),1):
        d1(sql,list(row))
        if n%100==0:print("Staged",n)
    d1("UPDATE nu_import_progress SET processed_count=?,last_run_at=CURRENT_TIMESTAMP,last_success_at=CURRENT_TIMESTAMP,last_error='' WHERE source='novelupdates'",[len(parsed)])
    print("Finished. All records are private until published.")

if __name__=="__main__":
    main()
