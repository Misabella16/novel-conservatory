"""Offline regression tests for authorized Novel Updates metadata imports."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import import_novelupdates as importer
import crawl_novelupdates as crawler

class SourceRetrievalTests(unittest.TestCase):
    def test_canonical_url_and_no_offsite_series(self):
        good = {"nuUrl": "https://www.novelupdates.com/series/example-story/", "title": "Example Story",
                "author": "Writer", "tags": ["Drama", "Drama", "Romance"], "synopsis": "Original synopsis"}
        data = importer.parse(good)
        self.assertEqual(data[0], "example-story")
        self.assertEqual(data[1], good["nuUrl"])
        self.assertIn('"tags":["Drama","Romance"]', data[4])
        for bad in ["http://www.novelupdates.com/series/x/", "https://evil.example/series/x/",
                    "https://www.novelupdates.com.evil.example/series/x/"]:
            self.assertIsNone(importer.parse({**good, "nuUrl": bad}))

    def test_html_extracts_existing_fields_without_generation(self):
        soup = BeautifulSoup("""<html><h1 class="seriestitlenu">A Book</h1>
         <div id="editdescription">Source synopsis only</div><div id="showauthors">Writer</div>
         <div id="seriesgenre"><a>Fantasy</a></div>
         <div id="showtags"><a>Found Family</a><a>Found Family</a></div></html>""", "html.parser")
        data = crawler.info(soup, "https://www.novelupdates.com/series/a-book/")
        self.assertEqual(data["synopsis"], "Source synopsis only")
        self.assertEqual(data["genres"], ["Fantasy"])
        self.assertEqual(data["tags"], ["Found Family"])

    def test_listing_rejects_noncanonical_links(self):
        html = BeautifulSoup("""<a href="/series/good-book/">One</a>
         <a href="https://evil.example/series/evil/">Two</a>
         <a href="/series/good-book/">Three</a>""", "html.parser")
        self.assertEqual(crawler.listing_links(html), ["https://www.novelupdates.com/series/good-book/"])

    def test_failed_series_does_not_advance_page_cursor(self):
        calls=[]
        directory=BeautifulSoup('<a href="/series/series-one/">One</a>', "html.parser")
        def fake_get(url):
            if "/novelslisting/" in url: return directory
            raise RuntimeError("403 from source")
        with patch.object(crawler, "get", fake_get), patch.object(crawler, "d1", side_effect=lambda *a: calls.append(a)), \
             patch.object(sys, "argv", ["crawler", "--start-page", "1", "--pages", "1"]):
            with self.assertRaisesRegex(RuntimeError, "Import stopped"):
                crawler.main()
        self.assertEqual(calls, [], "A failed series must never commit a next-page cursor")

    def test_successful_page_advances_cursor_exactly_once(self):
        calls=[]
        directory=BeautifulSoup('<a href="/series/series-one/">One</a>', "html.parser")
        series=BeautifulSoup('<h1 class="seriestitlenu">Series One</h1><div id="editdescription">A real description</div>', "html.parser")
        with patch.object(crawler, "get", side_effect=lambda u:directory if "/novelslisting/" in u else series), \
             patch.object(crawler, "d1", side_effect=lambda *a: calls.append(a)), \
             patch.object(sys, "argv", ["crawler", "--start-page", "1", "--pages", "1"]):
            crawler.main()
        self.assertEqual(len(calls), 2)
        self.assertIn("INSERT INTO nu_staged_series", calls[0][0])
        self.assertIn("UPDATE nu_import_progress", calls[1][0])
        self.assertEqual(calls[1][1], [2,1])

if __name__ == "__main__":
    unittest.main()
