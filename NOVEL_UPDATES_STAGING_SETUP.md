# Novel Updates staged importing and three-level permissions

## Current behavior
- Owner: controls access, site settings, bulk imports, and deployment.
- Editor: can create and edit additional novels and upload covers directly, approve reader submissions, edit staged imports, and publish staged Novel Updates records. No moderation queue for their own edits.
- Reader: may browse and submit suggestions; cannot publish or edit official records.
- All imported Novel Updates records go to `nu_staged_series` in shared D1 with `state='draft'`. The public worker has **no routes** to the staging table. Public EPUBs remain unavailable.
- The existing additional-novels publication system is used when the editor publishes a staged record. A review in the private editor can publish up to 20 novels at once.
- A hand-edited staged record is marked `custom_locked=1` and will not be overwritten by subsequent importer runs.

## Setup before testing
1. Back up Cloudflare **novel-conservatory-community** D1. Execute `database/NU_STAGING_MIGRATION.sql` against that shared database. Do NOT execute against the private EPUB/metadata database.
2. Deploy the private Pages source from this feature branch after review; existing `COMMUNITY_DB` and `COMMUNITY_IMAGES` bindings remain required.
3. Signed-in owner/editor: open `/admin/novel-updates.html`. Imported staging will be empty until the feed has run.
4. The importer accepts an **authorized JSON export** as an HTTPS feed or local JSON/JSONL. Accepted forms: array of records, `{"novels":[...]}`, or one JSON record per line. Each record needs `title` and `nuUrl` such as `https://www.novelupdates.com/series/example/`; optionally `author`, `synopsis`, `genres`, `tags`, `coverUrl`, `originalTitle`, etc.
5. Preview with `DRY_RUN=true python3 scripts/import_novelupdates.py /path/to/export.json`.
6. Configure private GitHub Actions **secrets**: `NU_EXPORT_URL` (authorized JSON/JSONL HTTPS feed), `CLOUDFLARE_ACCOUNT_ID`, `COMMUNITY_D1_DATABASE_ID` and `CLOUDFLARE_D1_API_TOKEN` (token with D1 write/query permission). Existing Pages-deployment token may not have D1 permissions. **Never put tokens in the repo, chat, or URL query strings.**
7. Only when authorized feed works and migration is complete, set GitHub Actions **variable** `NU_SYNC_ENABLED=true` to enable the daily schedule. Until then, the workflow does nothing.
8. For a local export, run the Python script with the same Cloudflare environment variables instead. It records normalized source records in D1 and never auto-publishes.

## Scale / limitations
- Novel Updates direct page scraping is NOT implemented; accessible automated feed/export source must be provided. The site may block unauthenticated fetching. No workaround or access-control bypass is built.
- A full catalogue of many thousands of titles requires remote feed batching, rate controls, and pagination on the public catalogue. Current public `additional/books` endpoint returns only the newest 5000 published records, so **do not mass-publish** staged titles until public pagination and search are upgraded.
- Existing base-catalogue entries that match a series URL or title are not overwritten. An editor must resolve ambiguous duplicate titles manually.
- Source cover URLs are stored as staging metadata. Publishing attempts a small safe cover copy only from HTTPS Novel Updates hostnames. Images hosted elsewhere or unavailable must be uploaded manually through authorized editor tools.
- No bulk modifications to the original 962 novels, private EPUBs, auth, or live site were performed in this branch.
