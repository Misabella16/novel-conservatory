# Bulk fill from Novel Updates

Fills missing **tags, genres, synopsis and cover** (optionally author and NU status references) for many catalogue novels at once, using each novel's existing Novel Updates link.

Page: `/admin/nu-bulk.html` (owner or editor). It's linked from the editor dashboard under **Novel Updates requests → Bulk fill from NU**.

## Why it works this way

Novel Updates answers server requests (the Worker, GitHub Actions, scripts) with a Cloudflare "verify you are human" page, so `/api/admin/nu/lookup` and `scripts/crawl_novelupdates.py` get HTTP 403. The bulk fill therefore reads the pages from a Novel Updates tab that the owner opens in their own browser. The owner completes any check personally. Nothing tries to solve, skip or get around a check.

## Steps

1. **Build the script.** On `/admin/nu-bulk.html`, choose **Build script**. By default it includes only linked novels that are still missing a tag, genre, synopsis or cover (saved edits count as filled). Copy the script.
2. **Collect.** Open `https://www.novelupdates.com/` in a normal browser tab on a computer and complete any check. Open the developer console in that tab, paste the script and press Return.
   - It reads one `/series/<slug>/` page every 5 seconds (adjustable 4–12) with the same parser as the novel page (`ConservatoryNUSource.parseHtml`).
   - It saves progress in that browser.
   - It stops at once on any challenge, 403, 429 or 503. Reload, complete the check, wait a minute and paste again to resume. Pages that failed are retried, and collected ones are kept.
   - It also stops after 5 pages in a row with no metadata, which suggests a layout change.
   - At the end it downloads `nu-bulk-<date>.json`. **Download file** in its panel gives a partial file at any time.
3. **Preview.** Back on the bulk page, choose the file, pick the details to fill and use **Preview changes**. This calls the importer with `preview: true`, so nothing is written.
4. **Fill.** Use **Fill missing details**. Each novel is sent to the existing `/api/admin/nu/book-import` with its capture, which:
   - fills only empty fields and adds tags and genres without removing existing ones;
   - checks the capture matches the novel's own NU link;
   - keeps the result private (`private-nu-page:<id>`);
   - writes an Undo event.
   Novels the importer refuses are listed as **Needs a look**, for example when the novel has a different NU link or the link is already used by another novel.
5. **Undo.** **Undo this batch** reverses the last bulk run novel by novel, newest first. Single novels can also be undone from their own page.

## Notes

- Covers are stored as a private link to the Novel Updates image, exactly as the single-novel importer does. A private EPUB cover always takes precedence.
- The collector only runs on `www.novelupdates.com`, requests only same-site series paths, never reads cookies and sends nothing anywhere: its output is a file you download.
- Checks: `node tests/check_nu_bulk_fill.js` (also run in CI).
