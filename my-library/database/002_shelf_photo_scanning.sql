-- My Library | Shelf photos | phase 6 preparation.
-- Companion to 001_initial_schema.sql. Independent D1 database ONLY.
-- Shelf photos and bounding-box crops stay PRIVATE until explicitly shared.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shelf_photos (
  id TEXT PRIMARY KEY,
  batch_id TEXT REFERENCES import_batches(id),
  private_object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT 'image/jpeg',
  photo_type TEXT NOT NULL DEFAULT 'mixed'
    CHECK(photo_type IN ('covers','spines','mixed')),
  caption TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '',
  bookcase TEXT NOT NULL DEFAULT '',
  shelf TEXT NOT NULL DEFAULT '',
  analysis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(analysis_status IN ('pending','processing','complete','partial','failed')),
  is_shared INTEGER NOT NULL DEFAULT 0 CHECK(is_shared IN (0,1)),
  -- Public previews use a separate sanitized, explicitly approved object.
  shared_preview_key TEXT,
  exif_removed INTEGER NOT NULL DEFAULT 0 CHECK(exif_removed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(is_shared=0 OR (shared_preview_key IS NOT NULL AND exif_removed=1))
);
CREATE INDEX IF NOT EXISTS idx_shelf_photos_location
  ON shelf_photos(room,bookcase,shelf);

-- A single shelf photo may contain dozens of different books.
-- Bounding coordinates are fractions of image width/height.
CREATE TABLE IF NOT EXISTS shelf_photo_detections (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL REFERENCES shelf_photos(id) ON DELETE CASCADE,
  x REAL NOT NULL DEFAULT 0 CHECK(x BETWEEN 0 AND 1),
  y REAL NOT NULL DEFAULT 0 CHECK(y BETWEEN 0 AND 1),
  width REAL NOT NULL DEFAULT 1 CHECK(width > 0 AND width <= 1),
  height REAL NOT NULL DEFAULT 1 CHECK(height > 0 AND height <= 1),
  detected_title TEXT NOT NULL DEFAULT '',
  detected_author TEXT NOT NULL DEFAULT '',
  detected_format TEXT NOT NULL DEFAULT '',
  matched_book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
  matched_edition_id TEXT REFERENCES editions(id) ON DELETE SET NULL,
  matched_copy_id TEXT REFERENCES copies(id) ON DELETE SET NULL,
  match_score REAL CHECK(match_score IS NULL OR match_score BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'unprocessed'
    CHECK(status IN ('unprocessed','auto_matched','needs_review','added','dismissed')),
  resolution TEXT NOT NULL DEFAULT 'none'
    CHECK(resolution IN ('none','link_book','update_copy_location','add_copy','new_book','dismiss')),
  resolution_batch_id TEXT REFERENCES import_batches(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(x+width <= 1.000001 AND y+height <= 1.000001)
);
CREATE INDEX IF NOT EXISTS idx_shelf_detections_photo
  ON shelf_photo_detections(photo_id,status);
CREATE INDEX IF NOT EXISTS idx_shelf_detections_book
  ON shelf_photo_detections(matched_book_id);

-- Store candidates rather than silently guessing when a spine is unclear.
CREATE TABLE IF NOT EXISTS shelf_detection_candidates (
  detection_id TEXT NOT NULL REFERENCES shelf_photo_detections(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  edition_id TEXT REFERENCES editions(id) ON DELETE SET NULL,
  score REAL NOT NULL CHECK(score BETWEEN 0 AND 1),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(detection_id,book_id)
);
