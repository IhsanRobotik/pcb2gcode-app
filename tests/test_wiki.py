import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import server
from wiki_content import wiki_file, wiki_pages


class WikiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / 'wiki'
        self.root.mkdir()

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding='utf-8')
        return path

    def test_pages_have_titles_summaries_and_readable_source(self):
        self.write('Home.md', 'Welcome to the wiki.')
        self.write('Options:-Milling.md', '# Options: Milling\n\nUse `--front` and [back copper](Options:-Back).')
        pages = wiki_pages(self.root)
        self.assertEqual([p['id'] for p in pages], ['Home', 'Options:-Milling'])
        self.assertEqual(pages[1]['title'], 'Milling')
        self.assertIn('Use --front and back copper.', pages[1]['summary'])
        self.assertIn('`--front`', pages[1]['content'])

    def test_new_nested_pages_are_discovered_without_configuration(self):
        self.assertEqual(wiki_pages(self.root), [])
        self.write('guides/New-Guide.md', '# New guide\n\nHelpful content.')
        pages = wiki_pages(self.root)
        self.assertEqual(pages[0]['id'], 'guides/New-Guide')
        self.assertEqual(pages[0]['title'], 'New guide')

    def test_legacy_page_is_identified(self):
        self.write('Manual.md', '# This document is obsolete.\n\nOlder manual.')
        page = wiki_pages(self.root)[0]
        self.assertTrue(page['legacy'])
        self.assertEqual(page['title'], 'Legacy manual')

    def test_repository_internals_and_outside_paths_are_not_exposed(self):
        self.write('.git/secret.md', 'private')
        self.write('_Sidebar.md', 'sidebar')
        outside = Path(self.directory.name) / 'outside.md'
        outside.write_text('outside')
        (self.root / 'Escape.md').symlink_to(outside)
        for name in ['../outside.md', str(outside), '.git/secret.md', 'Escape.md']:
            with self.assertRaises(ValueError):
                wiki_file(self.root, name)
        self.assertEqual(wiki_pages(self.root), [])

    def test_missing_folder_and_oversized_page_are_handled(self):
        self.assertEqual(wiki_pages(self.root / 'missing'), [])
        self.write('Huge.md', 'x' * (2 * 1024 * 1024 + 1))
        self.assertEqual(wiki_pages(self.root), [])

    def test_http_view_catalog_and_local_illustrations(self):
        self.write('Home.md', '# Local wiki\n\nWelcome.')
        image = self.root / 'images' / 'diagram.svg'
        image.parent.mkdir()
        image.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        with patch.object(server, 'WIKI_ROOT', self.root), patch.object(server.Handler, 'log_message'):
            with server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler) as httpd:
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                try:
                    base = f'http://127.0.0.1:{httpd.server_port}'
                    with urllib.request.urlopen(base + '/wiki/') as response:
                        self.assertIn(b'/wiki.js', response.read())
                    with urllib.request.urlopen(base + '/api/wiki') as response:
                        self.assertEqual(json.load(response)['pages'][0]['content'], '# Local wiki\n\nWelcome.')
                        self.assertEqual(response.headers['Cache-Control'], 'no-store')
                    with urllib.request.urlopen(base + '/api/wiki/asset?path=images%2Fdiagram.svg') as response:
                        self.assertEqual(response.headers['Content-Type'], 'image/svg+xml')
                        self.assertEqual(response.read(), image.read_bytes())
                    for path in ['..%2Foutside.md', '.git%2Fsecret.md', 'Home.md']:
                        with self.assertRaises(urllib.error.HTTPError) as error:
                            urllib.request.urlopen(base + '/api/wiki/asset?path=' + path)
                        self.assertEqual(error.exception.code, 404)
                finally:
                    httpd.shutdown()
                    thread.join()


if __name__ == '__main__':
    unittest.main()
