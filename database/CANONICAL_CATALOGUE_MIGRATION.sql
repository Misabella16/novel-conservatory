-- Shared COMMUNITY_DB only. Apply after taking D1 and R2 backups.
-- Do not grant public Cloudflare project access to private D1 or EPUB R2.
-- Legacy seed IDs 1-962 and additional novel IDs remain stable.
CREATE TABLE IF NOT EXISTS canonical_novel_keys (
 identity_key TEXT PRIMARY KEY,
 novel_id INTEGER NOT NULL CHECK(novel_id >= 1),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_canonical_novel_id ON canonical_novel_keys(novel_id);
-- A public projection of a privately stored novel. The private payload,
-- private cover and EPUB object keys are NEVER copied into this table.
CREATE TABLE IF NOT EXISTS public_novel_projections (
 novel_id INTEGER PRIMARY KEY CHECK(novel_id >= 100000),
 payload_json TEXT NOT NULL,
 cover_key TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Public projections do not change the visibility of private master rows.
-- When reverting an edit, restore/delete this projection only.
CREATE INDEX IF NOT EXISTS idx_public_novel_projection_recent ON public_novel_projections(updated_at DESC);
