-- Run against Cloudflare D1: novel-conservatory-community.
-- Backup database first. All imported titles remain unpublished until an editor publishes.
-- Existing additional_catalogue_novels and private EPUB tables are not modified.
CREATE TABLE IF NOT EXISTS nu_staged_series (
  slug TEXT PRIMARY KEY,
  nu_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  cover_url TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published')),
  published_id INTEGER,
  custom_locked INTEGER NOT NULL DEFAULT 0 CHECK(custom_locked IN (0,1)),
  source_hash TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (state <> 'published' OR published_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS nu_staged_state_title ON nu_staged_series(state, title COLLATE NOCASE, slug);
CREATE INDEX IF NOT EXISTS nu_staged_title ON nu_staged_series(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS nu_staged_seen ON nu_staged_series(last_seen_at);

CREATE TABLE IF NOT EXISTS nu_import_progress (
  source TEXT PRIMARY KEY,
  next_page INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_success_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  processed_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO nu_import_progress(source,next_page) VALUES ('novelupdates',1)
  ON CONFLICT(source) DO NOTHING;
