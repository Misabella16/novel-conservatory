# Novel Conservatory

This private repository contains the source for two websites:
- **Private**: invitation-only reading library with EPUB editions, member shelves, and owner editing tools.
- **Public**: discovery catalogue, browser-saved collections, moderated submissions, and community reviews.

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

After these steps, changes pushed to `main` automatically deploy through GitHub Actions. This automation is **not live yet** until the source and secrets are added. GitHub does not create Cloudflare bindings or perform database migrations.

## New novel workflows

- Public visitors suggest full non-CG novel records at `/submit-novel/`; submissions require Cloudflare Turnstile and editor approval.
- The private owner uses `/admin/add-novels.html` for individual entries, CSV/JSON bulk imports, private EPUB attachments, and review of public suggestions.
- New catalogue IDs start at 100000 and never overwrite the original 962 records.
- Private-only entries never appear on the public site; public pages never serve EPUB files.
- Public browser-only Collections can save both original and additional novels.

## Everyday editing

Edit public headlines and contact links at `/admin/site-settings.html`, and catalogue corrections at `/admin/catalogue-editor.html`, with no deployment needed for each content edit.

**Never commit EPUB books, private member information, authentication credentials, or Cloudflare tokens.**
