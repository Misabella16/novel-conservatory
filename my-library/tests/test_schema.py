"""Offline tests for My Library's standalone Cloudflare D1 schema.
Run: python3 -m unittest discover -s my-library/tests -p 'test_*.py'
"""
from pathlib import Path
import sqlite3
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]

def ident():
    return str(uuid.uuid4())

class SchemaTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys=ON")
        for name in ("001_initial_schema.sql", "002_shelf_photo_scanning.sql"):
            self.db.executescript((ROOT / "database" / name).read_text())

    def tearDown(self):
        self.db.close()

    def test_work_edition_and_separate_copies(self):
        self.db.execute("INSERT INTO books (id,title,author,normalized_title,normalized_author) VALUES (?,?,?,?,?)",
                        ("book-1","Babel","R. F. Kuang","babel","r f kuang"))
        self.db.execute("INSERT INTO editions (id,book_id,edition_name,vendor,is_special) VALUES (?,?,?,?,?)",
                        ("fairyloot","book-1","FairyLoot exclusive","FairyLoot",1))
        for loc in ("Bookcase 1","Bookcase 2"):
            self.db.execute("INSERT INTO copies (id,edition_id,bookcase,signature) VALUES (?,?,?,?)",
                            (ident(),"fairyloot",loc,"signed"))
        self.assertEqual(self.db.execute("SELECT count(*) FROM books").fetchone()[0],1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM copies").fetchone()[0],2)
        self.assertEqual(self.db.execute("SELECT count(DISTINCT bookcase) FROM copies").fetchone()[0],2)

    def test_no_shared_photo_without_sanitized_preview(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO shelf_photos (id,private_object_key,is_shared) VALUES (?,?,?)",
                            ("bad","private/photo.jpg",1))
        self.db.execute("""INSERT INTO shelf_photos
            (id,private_object_key,is_shared,shared_preview_key,exif_removed)
            VALUES (?,?,?,?,?)""",("okay","private/photo2.jpg",1,"shared/preview.jpg",1))
        self.assertEqual(self.db.execute("SELECT count(*) FROM shelf_photos").fetchone()[0],1)

    def test_same_file_hash_is_deduplicated_but_copies_are_not(self):
        self.db.execute("INSERT INTO epub_files (id,sha256,original_filename,private_object_key) VALUES (?,?,?,?)",
                        ("epub-a","samebytes","Babel (z-library).epub","private/epub-a"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO epub_files (id,sha256,original_filename,private_object_key) VALUES (?,?,?,?)",
                            ("epub-b","samebytes","Babel (1).epub","private/epub-b"))

    def test_edition_specific_display_cover(self):
        self.db.execute("INSERT INTO books (id,title,normalized_title) VALUES (?,?,?)",("work","Book","book"))
        self.db.execute("INSERT INTO editions (id,book_id) VALUES (?,?)",("ed","work"))
        self.db.execute("""INSERT INTO edition_images
          (id,edition_id,origin,private_object_key,display_cover) VALUES (?,?,?,?,?)""",
          ("cover-1","ed","manual","private/cover1",1))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("""INSERT INTO edition_images
              (id,edition_id,origin,private_object_key,display_cover) VALUES (?,?,?,?,?)""",
              ("cover-2","ed","publisher","private/cover2",1))

    def test_photo_detection_and_multiple_books(self):
        self.db.execute("INSERT INTO shelf_photos (id,private_object_key) VALUES (?,?)",
                        ("photo","private/shelf.jpg"))
        for x in (0.0,0.4):
            self.db.execute("""INSERT INTO shelf_photo_detections
              (id,photo_id,x,y,width,height,detected_title)
              VALUES (?,?,?,?,?,?,?)""",
              (ident(),"photo",x,0.0,0.3,0.9,"Visible spine"))
        self.assertEqual(self.db.execute("SELECT count(*) FROM shelf_photo_detections").fetchone()[0],2)

if __name__ == "__main__":
    unittest.main()
