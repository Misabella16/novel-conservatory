# The Book Conservatory

A **separate sister site** to Novel Conservatory, not another view of the existing private/public catalogue. This isolated site root is `book-conservatory/`; do not deploy it into the existing Novel Conservatory Pages projects.

## Phase 1 status

- ✅ Standalone responsive **development preview** (`index.html`) using the familiar forest/cream/gold visual style.
- ✅ Book profiles with synopsis and both genres and personal tags.
- ✅ Collapsible **My Editions & Copies**, individual edition details, and nested physical locations in preview.
- ✅ Independent D1 schema for works, title aliases, tags, Goodreads shelves, editions, owned copies, edition-specific covers, EPUB hashes, import batches and change history.
- ✅ Companion D1 schema for shelf photographs, per-book detected regions, candidate matches, photo sharing flags, and safe revisions.
- ✅ Deterministic, **read-only** title/author/ISBN/vendor suggestion utility with tests; noise like z-library is ignored in matching.
- ✅ Shelf-photo **local selection preview** (browser only; no server upload).
- 🚧 No authentication, D1/R2 binding, persistence, working Goodreads import, EPUB extraction, OCR/vision recognition, live metadata lookup, image matching, or Undo UI yet. The demo books are fictional.
- 🚫 No production deployment in this stage.

## Phases in order

1. **Isolated foundation.** UI prototype, databases and matching contracts. Run offline tests; confirm no changes to existing site roots.
2. **Connected private library.** New Cloudflare Pages project, private owner authentication, separate Book Conservatory D1 and R2 bindings, real CRUD for books/tags/reviews/editions/copies, and responsive browse/search.
3. **Goodreads CSV import.** Import titles, author names, custom shelves, ratings, read dates and available reviews. Reconcile to canonical work records, keep a report, and support batch Undo.
4. **Bulk EPUB import.** Parse EPUB package/OPF metadata and embedded covers, clean noisy filenames, hash exact duplicates and retain original files in private R2. Do not lose distinct editions or original file metadata.
5. **Special-edition covers.** Per-edition artwork for FairyLoot, Illumicrate, OwlCrate, The Broken Binding, LitJoy and others. Match exact editions through reliable identifiers and permitted official product images; allow owner-provided links and photo uploads. Never silently use a standard cover as an exact special-edition cover.
6. **Photo-to-shelf scanner.** Multi-image upload of covers, spines or full bookcases; detect individual volumes and title/author text using a configured imaging/recognition provider; rank candidates against existing works and editions; provide an accurate per-photo report. Safe exact matches link to existing works rather than creating duplicates. Unknown or ambiguous spines go to review. Option to set location for a positively identified physical copy, add a new copy when ownership evidence supports it, or update an existing record with an audit snapshot. Full-copy destruction and blind overwrite are forbidden. The physical location is always private. User can explicitly share redacted shelf photos, but uploads are not public by default.
7. **Final validation and separate deployment.** Test imports, identity consistency, Undo, photo permissions, responsive rendering and private R2 access before enabling a manually gated deployment to a **new** Pages project.

## Matching & overwrite policy

- Book (work) → edition → *owned copy* are three separate identities.
- A photo can contain many books. Each bounded book candidate gets its own match and confidence.
- Exact normalized title **and** author, or matching edition ISBN, can suggest an automatic work link if there is only one clear candidate. **Never** infer that a specific owned copy is the same physical object from the title alone.
- An existing book match updates safe missing cataloguing fields or links evidence rather than creating another book.
- If user chooses **Replace existing data**, show proposed field changes first (when the operation is destructive or ambiguous), record before/after snapshots, and allow Undo. Reviews, notes, signed status, edition-specific cover, existing EPUBs and stored locations remain intact unless individually changed.
- For a clear duplicate from multiple import sources, consolidate canonical references, do not delete original EPUB data, and record a revertible import batch.
- Shelf photo crops and original images remain in private storage. No guest-facing links or sharing without a separate sanitized preview, explicit consent, and verification that private home details are not exposed.
- No `language` field in the standard schema, UI or filters.

## Running Phase 1 tests

From the repository root:

```sh
node --check book-conservatory/shelf-photo-matcher.mjs
node book-conservatory/tests/test-shelf-match.mjs
python3 -m unittest discover -s book-conservatory/tests -p 'test_*.py' -v
```

These checks cover structural guarantees and match safety. They **do not validate the as-yet-unimplemented image recognition provider**.

## Later Cloudflare setup

Create a **new** D1 database and a **new private** R2 bucket, for example `book-conservatory-data` and `book-conservatory-private`, plus a separate Cloudflare Pages project `book-conservatory`. Names are examples, not resources already created.

Only after backups, owner auth, access-control checks, and the Worker are implemented:

1. Run `database/001_initial_schema.sql` on the *new* D1.
2. Run `database/002_shelf_photo_scanning.sql` on the *new* D1.
3. Bind the new D1/R2 only to the Book Conservatory Worker, not to the existing Novel Conservatory public site.
4. Keep original EPUBs, shelf photos, collection location, private notes and credentials out of GitHub.
5. Test in a private preview environment before any manually initiated production publish.

**Never use Novel Conservatory's existing D1 databases, existing R2 buckets, existing Cloudflare Pages project, or automatic deploy credentials to publish this site.**
