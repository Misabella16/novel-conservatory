# My Library: Phase 2 setup and safety checklist

**Status:** Phase 2 backend and frontend are committed on a feature branch. The code is **not deployed**, and no live Cloudflare resources have been created or modified by this change. The original Novel Conservatory sites, R2 buckets and D1 databases must stay untouched.

## What's built

- A separate responsive library site with real API-backed browsing, searching and pagination.
- Add a book and edit title, author, synopsis and reading status.
- Book pages show genres/tags, reading shelves, ratings and reviews.
- **My Private Notes is always visible on the book page**, with a textarea and explicit **Save notes** action. Notes are stored in D1's `books.private_notes`, not browser storage; concurrent stale edits receive HTTP 409.
- Collapsible My Editions & Copies section; add and edit physical/digital editions, signed/personalized copies, ARCs, ownership and precise locations (room, bookcase, shelf, position).
- Add and remove custom reading shelves and tags.
- Upload edition-specific covers to a private R2 bucket, view them only through owner-verified image API, and select the display cover.
- Protect **all requests**, including assets and image endpoints, with an independently validated Cloudflare Access JWT, correct audience and issuer, an exact owner email, and RSA signature.
- Same-origin writes only, no-store responses, validation of uploaded image headers, and an existing audit log.
- Empty database starts as an empty library. No fictional demo items are inserted.
- Phase 6 shelf photo selection is only a browser-local preview: photos are not uploaded or analyzed yet.

### What's not built yet

- Cloudflare deployment, resource creation, live D1 migrations and actual multi-device production smoke tests: needs your Cloudflare account setup.
- Goodreads import (Phase 3).
- Bulk EPUB import (Phase 4).
- Publisher/retailer special-edition cover retrieval (Phase 5).
- Shelf photo OCR/vision and copy matching (Phase 6).
- Complete data restoration from audit history and import Undo UI (later phase). Audit records are saved, but the UI is **not** an Undo function; use D1/R2 backups.
- Public or friend-facing sharing. All library content remains owner-only in Phase 2.

## Security prerequisites

1. Use a **separate** Cloudflare Pages project, not `novel-conservatory` or `novel-conservatory-public`.
2. Create a **new** D1 database, e.g. `my-library-data`. Make a backup before any later migration.
3. Create a **new private** R2 bucket, e.g. `my-library-private`. **Do not enable a public bucket domain**.
4. Create a **separate Cloudflare Access application** protecting the My Library Pages hostname, including any preview hostnames. In its Access policy, **Allow your exact owner email only**. Do not add an Everyone rule.
5. Verify that the Access application supplies a JWT to the Worker. Set the Worker variables in the My Library project only:
   - `ACCESS_TEAM_DOMAIN`: your actual `https://<team>.cloudflareaccess.com` team domain, without a trailing slash.
   - `ACCESS_AUD`: the **My Library Access application's** audience tag (not the existing Novel Conservatory tag).
   - `OWNER_EMAIL`: your exact account email (not written in the repository).
6. Set these **independent Worker bindings** in the My Library Pages project:
   - `BOOK_DB` → new My Library D1 database.
   - `BOOK_FILES` → new private My Library R2 bucket.
7. Restrict deployments to this site's isolated `my-library/` root. No novel-conservatory CI workflow deploys this site automatically. Do not turn on auto-publish for this project before a preview security review.

Cloudflare Dashboard steps: Workers & Pages → create a separate Pages project; choose a direct upload preview or a new GitHub integration configured to serve only `my-library/`. Keep production deployment manual initially. Confirm `_worker.js` is activated as the advanced-mode Worker and that all assets route through it.

## Database migration (NEW DATABASE ONLY)

Once the dedicated D1 exists, apply the files in this order via the Cloudflare D1 Console, after confirming the **My Library** database name:

1. `my-library/database/001_initial_schema.sql`
2. `my-library/database/002_shelf_photo_scanning.sql`

Alternatively, from a repo checkout with Wrangler authenticated to your Cloudflare account:

```sh
npx wrangler d1 execute my-library-data --remote --file=my-library/database/001_initial_schema.sql
npx wrangler d1 execute my-library-data --remote --file=my-library/database/002_shelf_photo_scanning.sql
```

Replace the example DB name with the **exact new My Library database name**. **Never execute these commands against the existing Novel Conservatory databases.**

## Test and preview

From the repository root:

```sh
node --check my-library/_worker.js
node --check my-library/library.js
node --test my-library/tests/test-worker.mjs
node my-library/tests/test-shelf-match.mjs
python3 -m unittest discover -s my-library/tests -p 'test_*.py' -v
```

Then in a private preview deployment:

1. Without a valid Access identity, `/`, `/library.js`, `/api/books`, and `/api/images/<image-id>` must all be inaccessible.
2. An authenticated non-owner also receives 403, even if a Cloudflare policy was accidentally broadened.
3. As the owner, add a book, enter notes directly on the book page and Save. Refresh and check the text persisted.
4. Open another tab and save an older version: stale writes must receive 409, not silently replace the newer notes.
5. Create a FairyLoot edition and two separately identifiable signed physical copies, each with its own location.
6. Upload a cover JPG/PNG/WebP to that edition, select its display cover, and verify it does not appear through the existing Novel Conservatory public site.
7. Reload the library, search for a title, and confirm the cover and copy location persist.
8. Check the request logs for Access authentication failures without exposing JWTs or personal data.
9. Back up your D1 and R2 before bulk imports become available.

**Important:** A working code path does not prove the Cloudflare resources are configured correctly. Don't open the site to anyone until these preview tests pass.

## Notes behavior

The `private_notes` field belongs to the canonical book, not a particular edition. Copy-specific notes have their own `copies.notes` field. A private book's personal review is separate (`books.review`). Notes remain owner-only and are never included in any public projection. The editor has a deliberate Save button to avoid overwriting thoughtful notes while you are typing.

## Next steps

Phase 3: Goodreads CSV import with duplicate-safe canonical book matching, original Goodreads shelves, and batch Undo.
Phase 4: EPUB bulk importer and embedded metadata/cover extraction.
Phase 5: Exact special-edition cover enrichment and owner verification.
Phase 6: Multi-book photo-to-shelf recognition, safe linking/updating of existing copies and manual correction of uncertain matches.
