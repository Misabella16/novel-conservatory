# Private EPUB Insights (feature branch)

## What it does
- Private dashboard at `/admin/epub-insights.html` (linked from the main editorial dashboard).
- Authenticated owner/editor with **separately granted EPUB reading access** can list existing stored editions, including older legacy files, without uploading them again.
- Clicking **Inspect this stored EPUB privately** reads the R2-backed EPUB through existing protected endpoints into the browser, locally parses OPF metadata and samples up to nine readable HTML/XHTML spine files.
- Extracted title, existing embedded description and subject tags populate empty form fields. They remain editable.
- **Generate synopsis and tags** is an explicitly optional action. The user must opt in each time. Only up to 12,500 characters of selected EPUB excerpt, plus the title, are sent to a Cloudflare Workers AI model. AI text is returned as a provisional draft, not automatically applied, exposed publicly, or used to update the EPUB.
- **Save as review draft** and **Approve reviewed metadata** store only metadata in the private D1 `site_settings` table using a per-novel key `epub-insights-v1:<id>`; no raw chapter text is stored.
- Approval requires confirmation that the synopsis is original or authorized. Publishing to the public catalogue is a separate editorial workflow.
- The AI model is `@cf/meta/llama-3.1-8b-instruct-fp8`. Cloudflare's documentation identifies this hosted model as having zero data retention, but sending excerpts to this service is still external inference.

## Enable Cloudflare binding
The private Cloudflare Pages project must have a **Workers AI binding named `AI`**. In Cloudflare Dashboard: Workers & Pages → your private Pages project → Settings → Bindings → Add Workers AI binding → variable name `AI`. Do not attach any AI binding to the public project for this feature. No additional secret/token should be pasted in the GitHub repo or chat.

## Limitations
- The model receives sampled opening spine files, *not the entire EPUB*. It may miss late-story tropes, twists, relationships and warnings. Approve all text carefully. This is **not full-book semantic analysis** and the draft should never be represented as verified facts.
- Browser inspection refuses EPUB files larger than 120 MiB. Reading a large stored EPUB downloads that edition into the browser; use a secure trusted device.
- Listing currently queries up to 1500 newer editions from each private table, plus 1100 legacy settings records. Pagination is offered over that fetched set. Extend server-side pagination if these limits are reached.
- The owner/editor must also have `canReadEpubs` permission. The current role model does not automatically allow an Editor to read private EPUBs, intentionally.
- Current implementation stores drafts and approvals, but **does not yet publish the approved metadata automatically or apply it to original catalogue entries**. Public catalogue changes remain separate.
- Cloudflare bindings, migration, browser tests, moderation, rate limits and cost monitoring still need production verification.
- The entire feature remains on a review branch, not yet deployed. Check Cloudflare costs and AI inference limits before enabling.
