# EPUB-first metadata and private EPUB availability

## Private catalogue design
- Original novels and separately added novels with an EPUB in private R2 show a subtle **soft-yellow outline** and a visible **📖 EPUB linked** badge on their covers, plus a matching detail badge.
- The private browse filters have an **EPUB available** checkbox and live count.
- Availability comes from private `epub_editions`, `additional_epub_editions` and legacy `site_settings/private-epub:<id>` records. **No EPUB file content, R2 object key, filename or raw user data** is delivered to the catalogue.
- The private `GET /api/private/epub/availability` endpoint only returns IDs after Cloudflare JWT verification and `canReadEpubs(email,role,env)` authorization. If not authorized, the filter and badges stay hidden. This is intentional: EPUB linkage is private to people allowed to read EPUBs.
- Public site has **no** private-EPUB-availability route, badge, filter, R2 binding or inventory.

## Source order (no generated metadata)
1. If a stored EPUB is linked, open `/admin/epub-insights.html` (Owner or Editor with EPUB-reading access). Selecting a new edition automatically scans its embedded OPF title, description and `dc:subject` tags in the authenticated browser. This downloads the selected EPUB **only to the editor's browser**. Previously saved review drafts are preserved and never overwritten.
2. If its description/subjects are missing, **Novel Updates** is the fallback, using the browser-assisted copy workflow where Cloudflare Workers receive HTTP 403. Source lookup **fills missing fields only**, never replaces existing EPUB description/subject tags or saved editorial text. Confirm that the series URL matches the same novel.
3. If **no EPUB is linked**, use `/admin/novel-updates.html` to capture/source-stage a Novel Updates page. The staging dashboard can fill missing metadata on an existing original catalogue record, but only if the source's canonical Novel Updates URL matches exactly and the private book has **no linked EPUB**. Mismatched/ambiguous titles are rejected.
4. Editors review and explicitly approve before applying. No AI-written synopsis/tags, no fabrication, no automatic public publishing.

## Private vs. public publishing
- **Apply approved metadata privately** from EPUB Insights updates only the private catalogue.
- **Publish approved metadata to public catalogue** sends the approved synopsis, genres and tags to shared public catalogue records. The button requires explicit confirmation. It **only fills absent public fields**, preserving existing approved editorial data. Nothing about EPUB linkage, storage, reading access, title of the uploaded file, or EPUB binary goes public.
- For staged browser-captured Novel Updates data: **Fill private metadata** and **Publish metadata only** match original seed novels by exact canonical source URL and fill missing fields. If the title is not in the original 962-record catalogue, the normal staging workflow can publish it as a new novel.
- Separate additional novels can only be updated publicly through the source-publish action if their listing has already been marked **published**; otherwise use the additional novel editor's existing publication control.
- The public Worker and public homepage were updated to accept reviewed `genres` along with reviewed `synopsis` and `tags`. Existing publication controls and permissions are preserved.

## Deployment and test notes
- This is a GitHub feature branch, not live until review/merge and **both** manually confirmed GitHub Actions deployments: `DEPLOY PRIVATE`, `DEPLOY PUBLIC`.
- No new database migration or third-party service credential is required beyond the earlier Novel Updates staging migration.
- Smoke-test an original book with a legacy EPUB, a newer edition, an additional novel EPUB, and a book without an EPUB. Confirm yellow badges, counts, and EPUB-only filtering. Sign in as a Reader **without** EPUB permission and confirm there are no badges or filter.
- Verify that a source-captured Novel Updates page fills missing fields on an original book without an EPUB. Verify that existing manual and EPUB metadata is not replaced. Confirm public metadata publication is opt-in and does not expose private EPUB availability.
- A manual source browser capture is still **one series at a time**. Bulk automated scraping remains disabled because the server gets HTTP 403. The source retrieval permission does not automatically guarantee server accessibility.
