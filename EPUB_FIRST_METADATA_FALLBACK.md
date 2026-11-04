# EPUB-first private metadata with Novel Updates fallback

## Intended priority

Private catalogue (per field, not per title):
1. Existing manual/approved editor overrides are preserved.
2. Embedded metadata from a **linked private EPUB** fills missing fields (title, synopsis, subject tags). Small EPUBs (<=15 MiB) are inspected automatically when selected in EPUB Insights; larger EPUBs require clicking **Inspect** before using the fallback.
3. **Novel Updates** supplies only fields still blank after the EPUB is inspected. Its metadata can come from browser-assisted capture pasted in EPUB Insights or a previously captured/staged series URL.
4. Missing data remains blank; no AI-generated content or speculative tags.

The workbench will not let an Editor skip linked EPUB inspection to paste Novel Updates data. For novels without any linked EPUB, select the existing catalogue ID under **Novel without an EPUB?**, then retrieve previously staged Novel Updates metadata or paste the browser-assisted capture JSON. The server checks that the given ID has no EPUB before allowing a no-EPUB draft to be approved.

Approval is separate from **Apply approved metadata privately**. Applying respects source ranking (manual > EPUB > Novel Updates), tracks per-field provenance, and never changes the public catalogue. Already published additional novels are not mutated by the private-only Apply action.

Public catalogue:
- The existing Novel Updates master staging at `/admin/novel-updates.html` is the shared import point for new public titles.
- Editors review and **explicitly publish** staged entries; the public Worker reads only published rows.
- This change does not auto-publish records or update the canonical 962 titles' public metadata from the staging table. Use the existing live catalogue editor for those established public titles.
- Public has no access to private EPUB storage, and no EPUB data is transmitted there.

## When Novel Updates returns HTTP 403

Do not activate automated crawling. Use the authorized **Capture Novel Updates** browser bookmarklet from the staging dashboard for the specific page and save as an unpublished draft. The private workbench can then fill its missing fields from the staged source URL. No login cookies or raw EPUB text are sent to the public site.

## Deployment

This is a new feature branch, not live automatically. Review/merge its pull request and deploy the **private** Pages target through the existing protected manual GitHub Actions workflow. The public site's existing staged-publication workflow is reused and requires no additional deployment for this change. There is no new database migration; existing EPUB/Novel Updates staging tables are reused.

Validate the sequence with one linked EPUB (including a file with missing subject tags), one title with no EPUB, and one authorized captured Novel Updates record. Verify no changes appear publicly before explicit publishing. 
