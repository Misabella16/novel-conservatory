# Novel Updates browser-assisted metadata capture

The private Cloudflare Worker receives HTTP 403 when trying to fetch Novel Updates pages. If an authorized person can open the series normally in a browser, they can capture **only existing metadata from that page** and stage it privately, without external network fetches from the Cloudflare Worker and without AI-generated content.

## First-time bookmarklet setup (desktop Chrome, Safari, Brave)
1. After deploying the private Pages project, open `https://novel-conservatory.pages.dev/admin/novel-updates.html#nu-browser-import`.
2. Display your browser's bookmarks/favorites bar if hidden (Safari: View → Show Favorites Bar; Chrome: View → Always Show Bookmarks Bar).
3. Drag the **Capture Novel Updates** link from the private dashboard into the bar. Alternatively select **Copy bookmarklet code**, create a bookmark called `Capture Novel Updates`, edit its address/URL, and paste the code starting with `javascript:`. Some browsers require editing the bookmark URL manually.
4. Open a specific `https://www.novelupdates.com/series/<slug>/` page in the same browser. Wait for description and tags to load. Select the **Capture Novel Updates** bookmark. The bookmarklet reads the rendered page's visible original metadata and attempts to copy a small JSON payload to the clipboard. If clipboard access is blocked, it prompts you to copy the payload manually.
5. Return to the private dashboard, paste into **Copied metadata**, select **Review copied metadata**, verify fields against the Novel Updates page, and click **Save as unpublished draft**.
6. The existing staging dashboard lets an Editor inspect and selectively publish the series later. A saved draft cannot overwrite manually locked or already published records.

## Security properties
- The bookmarklet only runs when explicitly invoked on the canonical `www.novelupdates.com` series path. It does not collect cookies, identity tokens, page HTML, browser history or EPUB content.
- The bookmarklet makes **no network requests**. Users copy structured fields and paste them into the already-authenticated private dashboard.
- `POST /api/admin/nu/stage-browser` requires a valid private Cloudflare Access session, Owner/Editor role, the canonical source hostname and path, same-origin request, and valid series metadata.
- Records are inserted into `nu_staged_series` with the default `draft` state. Existing `published` or `custom_locked=1` rows are protected.
- No Novel Updates listing is automatically published. No Cloudflare permissions or site-wide browser security protections are bypassed.
- Exact field selectors may change when Novel Updates updates its page. The importer then refuses to stage missing/unverified metadata; users can still edit copied fields manually before submission.

## Limitations
This is a **one-series-at-a-time assisted import**, not a replacement for a large-scale authorized API/feed. It relies on a page the user can access normally. Browsers may restrict bookmarklet execution, clipboard write permission, or dynamic tags. The user should verify extracted fields and, if necessary, manually paste the actual source description and tags into the review form.

The GitHub branch must be merged and the **private** Pages target deployed via the existing manually confirmed GitHub Actions workflow before the tool is live. The existing D1 staging tables must be present. The public Pages target does not need deployment for this feature.
