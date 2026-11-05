-- One-time migration for editable, reversible catalogue merges.
-- Run against the shared COMMUNITY_DB (novel-conservatory-community) after backing it up.
-- Never delete duplicate book rows: existing EPUB/review references may still point to their IDs.
CREATE TABLE IF NOT EXISTS catalogue_merge_aliases (
 duplicate_id INTEGER PRIMARY KEY,
 canonical_id INTEGER NOT NULL,
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(duplicate_id >= 100000),
 CHECK(canonical_id >= 1),
 CHECK(duplicate_id <> canonical_id)
);
CREATE INDEX IF NOT EXISTS idx_catalogue_merge_alias_target ON catalogue_merge_aliases(canonical_id);

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
