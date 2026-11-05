-- One-time migration for reversible catalogue edits and safe duplicate resolution.
-- Run against shared COMMUNITY_DB (novel-conservatory-community) after a backup.
-- Merges keep the original duplicate row, IDs and EPUB files intact for Undo.
CREATE TABLE IF NOT EXISTS catalogue_edit_events (
 id TEXT PRIMARY KEY,
 operation TEXT NOT NULL CHECK(operation IN ('merge','metadata_sync')),
 target_id INTEGER NOT NULL,
 duplicate_id INTEGER,
 before_json TEXT NOT NULL,
 after_json TEXT NOT NULL,
 source_url TEXT NOT NULL DEFAULT '',
 actor_email TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 undone_at TEXT,
 undone_by TEXT NOT NULL DEFAULT '',
 CHECK(target_id >= 1)
);
CREATE INDEX IF NOT EXISTS idx_catalogue_edit_events_recent ON catalogue_edit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalogue_edit_events_target ON catalogue_edit_events(target_id, created_at DESC);
