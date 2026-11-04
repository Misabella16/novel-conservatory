-- Run once against PRIVATE novel-conservatory-content D1 after backing it up.
-- Previously uploaded EPUB editions remain unchanged.
CREATE TABLE IF NOT EXISTS additional_epub_editions (
 id TEXT PRIMARY KEY,
 novel_id INTEGER NOT NULL CHECK(novel_id >= 100000),
 label TEXT NOT NULL,
 translator TEXT NOT NULL DEFAULT '',
 language TEXT NOT NULL DEFAULT 'English',
 filename TEXT NOT NULL,
 object_key TEXT NOT NULL UNIQUE,
 bytes INTEGER NOT NULL CHECK(bytes > 0),
 uploaded_by TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_additional_epub_by_novel ON additional_epub_editions(novel_id,created_at);
CREATE TABLE IF NOT EXISTS additional_epub_upload_sessions (
 id TEXT PRIMARY KEY,
 novel_id INTEGER NOT NULL CHECK(novel_id >= 100000),
 owner_email TEXT NOT NULL,
 object_key TEXT NOT NULL,
 upload_id TEXT NOT NULL,
 filename TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 label TEXT NOT NULL,
 translator TEXT NOT NULL DEFAULT '',
 language TEXT NOT NULL DEFAULT 'English',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Existing epub_upload_parts stores chunk completion by unique session ID.
