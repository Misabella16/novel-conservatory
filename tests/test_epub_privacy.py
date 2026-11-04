"""Offline guardrails for private EPUB status and reviewed metadata publishing."""
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
def read(path):return (ROOT/path).read_text(encoding='utf-8')

class EpubVisibilityTests(unittest.TestCase):
    def test_availability_is_private_and_permissioned(self):
        private=read('private/_worker.js')
        public=read('public/_worker.js')
        self.assertIn("path==='/api/private/epub/availability'",private)
        self.assertIn("canReadEpubs(email,role,env)",private)
        self.assertIn("FROM epub_editions GROUP BY novel_id",private)
        self.assertIn("FROM additional_epub_editions GROUP BY novel_id",private)
        self.assertNotIn("path==='/api/private/epub/availability'",public)
        self.assertNotIn("epubLinkedIds",read('public/index.html'))

    def test_private_cards_show_guide_and_filter(self):
        private=read('private/index.html')
        self.assertIn("id=\"epub-linked-only\"",private)
        self.assertIn("epub-linked-badge",private)
        self.assertIn("has-private-epub",private)
        self.assertIn("if(epubLinkedOnly&&!epubLinkedIds.has(Number(d.id)))return false",private)
        self.assertIn("if(u.canReadEpubs)loadPrivateEpubAvailability()",private)

    def test_epub_first_and_missing_fields_only(self):
        client=read('private/admin/epub-insights.js')
        self.assertIn("if(!v.draft)$('inspect').click()",client)
        self.assertIn("if(parsed.synopsis&&!$('synopsis').value.trim())",client)
        self.assertIn("if(tags.length&&!$('tags').value.trim())",client)
        self.assertIn("/api/admin/epub-insights/publish-public",client)

    def test_public_includes_genres_but_not_epub_status(self):
        public_worker=read('public/_worker.js')
        public_page=read('public/index.html')
        self.assertIn("'tags','genres','nuUrl'",public_worker)
        self.assertIn("['tags','genres','nuUrl'",public_page)
        private_worker=read('private/_worker.js')
        self.assertIn("path==='/api/admin/epub-insights/publish-public'",private_worker)
        self.assertIn("path==='/api/admin/nu/apply-to-existing'",private_worker)
        self.assertIn("This novel has a linked EPUB",private_worker)
        self.assertIn("published_catalogue_overrides",private_worker)

if __name__=='__main__':unittest.main()
