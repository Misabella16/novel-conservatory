-- Run once against novel-conservatory-community D1 after backing it up.
-- Keeps the original 962 titles and existing moderation tables unchanged.
CREATE TABLE IF NOT EXISTS additional_catalogue_novels (
 id INTEGER PRIMARY KEY CHECK (id >= 100000),
 normalized_title TEXT NOT NULL,
 title TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 cover_key TEXT NOT NULL DEFAULT '',
 visibility TEXT NOT NULL CHECK (visibility IN ('private','published')),
 source_submission_id TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_additional_novels_visibility ON additional_catalogue_novels(visibility,created_at);
CREATE INDEX IF NOT EXISTS idx_additional_novels_title ON additional_catalogue_novels(normalized_title);
CREATE TABLE IF NOT EXISTS additional_novel_submissions (
 id TEXT PRIMARY KEY,
 payload_json TEXT NOT NULL,
 cover_key TEXT NOT NULL DEFAULT '',
 display_name TEXT NOT NULL DEFAULT '',
 contact_email TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 published_novel_id INTEGER,
 moderated_by TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 moderated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_additional_submissions_queue ON additional_novel_submissions(status,created_at);
