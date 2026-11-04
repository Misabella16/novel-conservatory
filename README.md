# Novel Conservatory

Private invitation-only reading library + separate public web-novel catalogue.

## Source and deployment
The current source is provided separately as `Novel_Conservatory_Suggestions_Site_Controls_Full_Source.zip`. Copy the *contents* of the unzipped source archive to the root of this private repository, preserving the `private/`, `public/`, `.github/workflows/`, and SQL files.

The existing workflow deploys the private Cloudflare Pages project `novel-conservatory` on changes to `main`, once repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are configured. Public deployment remains disabled until the actual backend-enabled Cloudflare Pages project name is set in the repository variable `PUBLIC_PAGES_PROJECT`.

**Never commit credentials, EPUB books, customer/member data, or Cloudflare Access secrets.** Do not bind the private D1 DB or private EPUB R2 bucket to the public deployment.

## New features
- Both sites have a Suggestions & Questions page and a small "Website created by Momo" footer.
- Public site headline/intro/section text and Instagram contact are editable from the private owner's `/admin/site-settings.html`.
- Reader questions are stored in the private owner's shared-D1 inbox, not in public discussions.
- Public feedback requires Cloudflare Turnstile.
- Existing EPUB covers, catalogue editor, reviews, translators, and reading features are preserved.

Run `database/COMMUNITY_SITE_SETTINGS_MIGRATION.sql` in the Cloudflare D1 database `novel-conservatory-community` **before** deploying the new feature.

This README initializes the repository; the full source files still need to be committed. No automatic deployments will start until the source workflow and Cloudflare credentials are present.
