# Navigation and EPUB metadata improvements

## Reader navigation
Both public and private homepages now use an **All sections** menu on narrower displays (up to 1280px). This replaces hidden horizontal tab scrolling. Menu is a visible two-column list; it supports keyboard Escape, click-outside closing, and keyboard focus. Wide screens retain the existing navigation.

## Private EPUB metadata
Open `/admin/add-novels.html`, choose **Attach EPUBs**, select a file and a target additional novel, then click **Scan first selected EPUB**. The scanner reads the EPUB's OPF metadata locally in your browser: embedded title, creator, description (if present), and subjects (if present). Review and edit those fields, then **Save reviewed metadata to selected novel**. It never changes publication visibility or uploads chapter text for analysis.

Limitations:
- This uses the EPUB **you select on your device**, not files previously stored in private R2. The next integration can scan stored EPUBs securely behind the private authentication Worker.
- An EPUB may have no description or subject tags. Generating original summaries, tropes and content warnings from book text is a separate text-analysis feature, not implemented in this PR.
- The review/save action currently supports additional novels with IDs >=100000. Existing original records have their own editor.
- Editors can write additional catalogue metadata; EPUB storage permissions are independently checked.
- The public site never sees the EPUB, its contents, or the draft metadata until an editor publishes the catalogue record.

## Deployment
These changes are on the feature branch in PR #2 and are NOT live. Test the responsive header on phone/tablet/desktop before deploying.
