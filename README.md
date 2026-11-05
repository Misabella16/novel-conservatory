# Novel Conservatory

This private repository contains the source for two websites:
- **Private**: invitation-only reading library with EPUB editions, member shelves, and owner editing tools.
- **Public**: discovery catalogue, browser-saved collections, moderated submissions, and community reviews.

## Private access: Cloudflare-only approval

The private library uses **Cloudflare Zero Trust → Access → Applications** as its **sole reader allowlist**. To add a reader, add their exact email to the private application's **Allow** policy in Cloudflare and share the normal private website URL. Do not use an Everyone/public rule. Readers sign in through Cloudflare's email verification flow. There is **no second on-site invitation or redemption step**.

The private Worker independently verifies the Cloudflare Access JWT signature, issuer, audience, expiry, and email for every asset/API request. The on-site invitation endpoints return HTTP 410. Old `/join/` and `/admin/invitations.html` links redirect to the homepage/editor respectively. Historic invitation records remain in D1 but are no longer consulted, so their links grant no privileges.

Owner/editor roles remain governed by the private editorial database; an Access-approved friend is a **Reader** by default. EPUB reading is a **separate** owner-controlled permission with a global sharing switch and per-email approval. A Cloudflare-approved reader cannot access EPUBs just by being allowed to browse the catalogue.

To revoke a visitor's access, remove their email from the applicable Cloudflare Access Allow policy and, for urgent revocations, revoke their active Access sessions. Do not rely on the old on-site member controls.

**Note:** Retiring the on-site invitations does not resolve a missing email verification code. Cloudflare sends that code independently; troubleshoot its login policy and email deliverability if someone still cannot sign in.

## First-time setup

1. Back up the existing Cloudflare D1 databases and R2 buckets.
2. Run `COMMUNITY_ADDITIONAL_NOVELS_MIGRATION.sql` in **novel-conservatory-community**.
3. Run `PRIVATE_ADDITIONAL_EPUB_MIGRATION.sql` in **novel-conservatory-content**.
4. If not already run, apply `COMMUNITY_SITE_SETTINGS_MIGRATION.sql` in the community D1 database.
5. Unzip the downloaded **Novel_Conservatory_NonCG_Full_Source.zip** on your Mac. In this repository, click **Add file → Upload files**, then drag in the extracted **private** and **public** folders. Commit the files to `main`. Do not upload the ZIP without extracting it. GitHub retains the folder paths.
6. Verify that `private/index.html`, `private/_worker.js`, `public/index.html`, and `public/_worker.js` appear in the repository.
7. Configure GitHub Actions repository secrets `CLOUDFLARE_API_TOKEN` (Cloudflare API token with Pages Edit) and `CLOUDFLARE_ACCOUNT_ID` (your Cloudflare account ID). Add them **on GitHub**, never in chat or source files.
8. Once the public project is confirmed to be a **Cloudflare Pages project with a backend**, set the Actions variable `PUBLIC_PAGES_PROJECT` to its exact existing Pages project name. Until then, only the private project will deploy.
9. Ensure the private Pages project has bindings `DB`, `COMMUNITY_DB`, `IMAGES`, and `COMMUNITY_IMAGES`; the public project only needs `COMMUNITY_DB`, `COMMUNITY_IMAGES` (and applicable Turnstile configuration). **Never connect the private DB or EPUB R2 bucket to the public site.**

**Production deployments are manually gated.** Pushing or merging code to `main` runs validation but does **not** publish either website. To deploy, open **GitHub Actions → Conservatory — Safe Preview / Manual Production Deploy**, choose exactly one project, and enter its matching `DEPLOY PRIVATE` or `DEPLOY PUBLIC` confirmation. GitHub does not create Cloudflare bindings, perform database migrations, or back up R2 buckets.

## New novel workflows

- Public visitors suggest full non-CG novel records at `/submit-novel/`; submissions require Cloudflare Turnstile and editor approval.
- The private owner uses `/admin/add-novels.html` for individual entries, CSV/JSON bulk imports, private EPUB attachments, and review of public suggestions.
- New catalogue IDs start at 100000 and never overwrite the original 962 records.
- Private-only entries never appear on the public site; public pages never serve EPUB files.
- Public browser-only Collections can save both original and additional novels.

## Everyday editing

Edit public headlines and contact links at `/admin/site-settings.html`, and catalogue corrections at `/admin/catalogue-editor.html`, with no deployment needed for each content edit.

**Never commit EPUB books, private member information, authentication credentials, or Cloudflare tokens.**


## Canonical identity, safe duplicate merging and Library Health

The canonical identity index and public projections share **COMMUNITY_DB**. Public only receives explicitly published metadata; its Worker must never receive access to the private DB or EPUB R2 bucket.

Before enabling these features in production:

1. Export/backup the **community D1**, **private D1** and **private EPUB R2 bucket** independently.
2. Apply `database/CANONICAL_CATALOGUE_MIGRATION.sql` to the shared community D1. The Workers also create missing identity tables on first use, but explicit migration and backup are safer.
3. Confirm that the private app's COMMUNITY_DB and DB bindings point to the intended databases. Deploy the private site **manually** after all tests pass, then test the owner-only `/admin/library-health.html`.
4. Use **Index existing novel IDs** to register known canonical keys without moving or changing any records. Check the conflict report and perform a small reversible merge first.
5. Before deploying the public site, verify that `/api/additional/books` only exposes published catalogue entries and public metadata projections. A private novel must never expose its private EPUB metadata, private cover or private synopsis via a public endpoint.
6. Retain a D1/R2 backup outside the website. Undo reverses catalogue records and edition references, but **does not substitute for disaster recovery**.

The merge code transfers existing EPUB **database references** in a transactional private D1 batch. It does **not** delete, copy, or publish EPUB file bytes. It checks for concurrent changes and blocks active or legacy uploads that cannot be transferred safely. A private cover remains private; an authorized published cover may remain reachable through its historical source reference. Cross-database metadata reconciliation uses an audit record and compensating rollback, since separate D1 databases cannot participate in one global transaction.

The health report is read-only except for the separate owner-initiated **Index existing novel IDs** action. Deploying code alone does not clean up existing duplicates.
