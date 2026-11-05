-- My Library | Phase 1 | NEW, INDEPENDENT Cloudflare D1 database only.
-- Do NOT run against Novel Conservatory's DB or COMMUNITY_DB.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  normalized_title TEXT NOT NULL,
  normalized_author TEXT NOT NULL DEFAULT '',
  synopsis TEXT NOT NULL DEFAULT '',
  reading_status TEXT NOT NULL DEFAULT 'unread'
    CHECK(reading_status IN ('unread','reading','read','paused','dnf')),
  rating REAL CHECK(rating IS NULL OR rating BETWEEN 0 AND 5),
  review TEXT NOT NULL DEFAULT '',
  private_notes TEXT NOT NULL DEFAULT '',
  goodreads_id TEXT UNIQUE,
  date_started TEXT,
  date_finished TEXT,
  preferred_edition_id TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_books_identity ON books(normalized_title,normalized_author);

CREATE TABLE IF NOT EXISTS book_aliases (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  UNIQUE(book_id,normalized_alias)
);
CREATE INDEX IF NOT EXISTS idx_book_aliases ON book_aliases(normalized_alias);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL COLLATE NOCASE UNIQUE,
  kind TEXT NOT NULL DEFAULT 'personal'
    CHECK(kind IN ('genre','imported','personal'))
);
CREATE TABLE IF NOT EXISTS book_tags (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY(book_id,tag_id)
);
CREATE TABLE IF NOT EXISTS shelves (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  origin TEXT NOT NULL DEFAULT 'personal'
    CHECK(origin IN ('personal','goodreads'))
);
CREATE TABLE IF NOT EXISTS book_shelves (
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
  PRIMARY KEY(book_id,shelf_id)
);

-- An intellectual work can have many published editions.
CREATE TABLE IF NOT EXISTS editions (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  edition_name TEXT NOT NULL DEFAULT 'Standard',
  publisher TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  isbn TEXT,
  format TEXT NOT NULL DEFAULT 'hardcover'
    CHECK(format IN ('hardcover','paperback','ebook','audiobook','other')),
  source_product_url TEXT,
  is_special INTEGER NOT NULL DEFAULT 0 CHECK(is_special IN (0,1)),
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_editions_book ON editions(book_id);
CREATE INDEX IF NOT EXISTS idx_editions_isbn ON editions(isbn);
CREATE INDEX IF NOT EXISTS idx_editions_vendor ON editions(vendor);

-- A physical copy is not the same thing as an edition.
CREATE TABLE IF NOT EXISTS copies (
  id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,
  medium TEXT NOT NULL DEFAULT 'physical'
    CHECK(medium IN ('physical','digital')),
  ownership TEXT NOT NULL DEFAULT 'owned'
    CHECK(ownership IN ('owned','preordered','wishlist','borrowed','sold','donated')),
  is_arc INTEGER NOT NULL DEFAULT 0 CHECK(is_arc IN (0,1)),
  signature TEXT NOT NULL DEFAULT 'unsigned'
    CHECK(signature IN ('unsigned','signed','personalized','signed_bookplate')),
  condition TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '',
  bookcase TEXT NOT NULL DEFAULT '',
  shelf TEXT NOT NULL DEFAULT '',
  shelf_position TEXT NOT NULL DEFAULT '',
  acquired_on TEXT,
  price_cents INTEGER CHECK(price_cents IS NULL OR price_cents >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_copies_edition ON copies(edition_id);
CREATE INDEX IF NOT EXISTS idx_copies_location ON copies(room,bookcase,shelf);

-- Covers can be different for each edition, and photo evidence may
-- belong to an individual copy. Never force an EPUB cover onto a special edition.
CREATE TABLE IF NOT EXISTS edition_images (
  id TEXT PRIMARY KEY,
  edition_id TEXT NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,
  copy_id TEXT REFERENCES copies(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'cover'
    CHECK(role IN ('cover','dust_jacket','naked_cover','sprayed_edges','signature','other')),
  origin TEXT NOT NULL
    CHECK(origin IN ('epub','publisher','retailer','manual','shelf_photo')),
  image_url TEXT,
  private_object_key TEXT,
  credit TEXT NOT NULL DEFAULT '',
  match_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK(match_status IN ('unverified','possible','exact','user_verified')),
  display_cover INTEGER NOT NULL DEFAULT 0 CHECK(display_cover IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(image_url IS NOT NULL OR private_object_key IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edition_display_cover
  ON edition_images(edition_id) WHERE display_cover=1;

-- Upload batches and changes are logged for safe reversible imports.
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('goodreads','epub','shelf_photo','manual')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','complete','partial','failed','undone')),
  report TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS epub_files (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  cleaned_title TEXT NOT NULL DEFAULT '',
  private_object_key TEXT NOT NULL UNIQUE,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  book_id TEXT REFERENCES books(id) ON DELETE RESTRICT,
  edition_id TEXT REFERENCES editions(id) ON DELETE RESTRICT,
  copy_id TEXT REFERENCES copies(id) ON DELETE SET NULL,
  batch_id TEXT REFERENCES import_batches(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS change_log (
  id TEXT PRIMARY KEY,
  batch_id TEXT REFERENCES import_batches(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  undone_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_change_log_batch ON change_log(batch_id,created_at);
