-- One-time Cloudflare D1 migration for novel-conservatory-community.
CREATE TABLE IF NOT EXISTS conservatory_site_config (
 scope TEXT PRIMARY KEY CHECK(scope IN ('public','private')),
 config_json TEXT NOT NULL DEFAULT '{}',
 updated_by TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conservatory_site_feedback (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL CHECK(scope IN ('public','private')),
 kind TEXT NOT NULL CHECK(kind IN ('question','suggestion')),
 display_name TEXT NOT NULL,
 reply_to TEXT NOT NULL DEFAULT '',
 subject TEXT NOT NULL,
 message TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','archived')),
 member_email TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 moderated_at TEXT,
 moderated_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_conservatory_site_feedback_status
 ON conservatory_site_feedback(status,created_at);
