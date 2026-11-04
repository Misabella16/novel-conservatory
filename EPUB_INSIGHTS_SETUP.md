# Source-only EPUB and Novel Updates retrieval

The site's metadata process is **retrieval, not generation**. No AI model is used.

## Already-stored EPUBs
In the private editorial dashboard open `/admin/epub-insights.html`. Pick an existing R2-backed EPUB, then **Inspect this stored EPUB privately**. The EPUB package is read locally in the authenticated user's browser. Its OPF record provides the original embedded title, creator, description, and subject tags if present. Absent fields remain blank. No prose is generated and no chapters are sent externally.

## Individual Novel Updates lookup
In that same page, paste the canonical `https://www.novelupdates.com/series/<slug>/` URL and choose **Retrieve Novel Updates metadata**. The private Worker requests that page from Novel Updates using a bounded, validated HTTPS request, then the browser extracts existing description, genre and tag fields. If the page is blocked or its structure changes, the tool reports an error. It does **not** bypass anti-bot challenges.

Review the retrieved metadata, save an unapproved draft, or approve it as authorized source material. After approval, the explicit **Apply approved metadata privately** button writes the reviewed synopsis and tags to the private catalogue. It never modifies the source EPUB or publishes a catalogue record automatically. For already-public additional novels, application is blocked and the existing live catalogue editor must be used.

## Bulk source retrieval
`scripts/crawl_novelupdates.py` retrieves directory pages and individual series in small, rate-limited batches, using only the public series paths. It saves original source fields into `nu_staged_series` with state `draft`. A durable `nu_import_progress.next_page` cursor lets subsequent runs resume; the source URL is the stable duplicate key. Hand-edited and already-published records are not overwritten by the crawler.

Use `python3 scripts/crawl_novelupdates.py --pages 1 --dry-run` first to validate access, parse selectors and metadata. The crawler stops when the website returns a blocked/challenge page, 403, 429, 503, or other unexpected response, rather than circumventing protections.

### One-time deployment and schedule
1. Backup the shared COMMUNITY_DB and execute `database/NU_STAGING_MIGRATION.sql`.
2. Deploy the private and public sites after preview tests; the two projects remain isolated.
3. Provide existing GitHub secrets `CLOUDFLARE_ACCOUNT_ID`, `COMMUNITY_D1_DATABASE_ID`, `CLOUDFLARE_D1_API_TOKEN` with appropriate D1 permissions, through GitHub Settings. Never paste secrets into chat or commits.
4. Test first directory page and resulting staging rows; inspect multiple genres, translations, cover links, and descriptions for fidelity.
5. Set GitHub Actions variable `NU_CRAWL_ENABLED=true` when approved site retrieval functions and after testing. The `novel-updates-crawl.yml` Action then processes three listing pages per daily run with 4+ seconds between series requests, resuming the cursor. Raise the batch only after monitoring and provider approval. The separate JSON export importer stays available as a fallback but is not mandatory.
6. Review entries in `/admin/novel-updates.html` and publish selected records. **No bulk crawler run publishes data.**

### Unverified dependencies / limitations
- Novel Updates page retrieval from GitHub Actions or Cloudflare has not been verified. Some environments receive access challenges. Site permission does not guarantee a reachable automated endpoint.
- Page selectors may change. The importer deliberately fails when it cannot find expected novel fields. Do not activate a full sweep before testing the first page.
- Public catalogue pagination/search needs upgrading beyond its current 5000 additional-entry limit before publishing thousands of staged titles.
- Individual lookup retrieves the page, but does not automatically link an existing EPUB to a verified Novel Updates series. Paste the correct URL manually and confirm matching title.
- Only embedded EPUB metadata is extracted; missing synopses and tags remain missing. Warnings are editor-supplied or existing Novel Updates metadata, never invented.
- Existing private synopsis and tags are overwritten only when an Editor explicitly chooses **Apply approved metadata privately**. That button is disabled until the draft has been approved.
- No production deployment or live import was run; the feature remains in the branch.
