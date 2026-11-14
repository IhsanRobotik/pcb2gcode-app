import concurrent.futures
import http.cookiejar
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

import server


class VisitorCounterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database = Path(self.directory.name) / 'data' / 'visitors.sqlite3'

    def test_refresh_does_not_count_browser_again(self):
        count, token = server.register_visitor('', self.database)
        self.assertEqual(count, 1)
        self.assertEqual(server.register_visitor(f'pcb2gcode_visitor={token}', self.database), (1, token))

    def test_new_browser_is_counted_and_stored(self):
        server.register_visitor('', self.database)
        count, token = server.register_visitor('', self.database)
        self.assertEqual(count, 2)
        with sqlite3.connect(self.database) as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM visitors').fetchone()[0], 2)
        self.assertEqual(server.register_visitor(f'pcb2gcode_visitor={token}', self.database)[0], 2)

    def test_invalid_cookie_gets_valid_random_identifier(self):
        count, token = server.register_visitor('pcb2gcode_visitor=invalid', self.database)
        self.assertEqual(count, 1)
        self.assertRegex(token, r'^[0-9a-f]{32}$')

    def test_simultaneous_unique_browsers_are_all_counted(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            visits = list(pool.map(lambda _: server.register_visitor('', self.database), range(16)))
        token = visits[0][1]
        self.assertEqual(server.register_visitor(f'pcb2gcode_visitor={token}', self.database)[0], 16)

    def test_simultaneous_requests_from_same_browser_count_once(self):
        cookie = 'pcb2gcode_visitor=' + 'a' * 32
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            visits = list(pool.map(lambda _: server.register_visitor(cookie, self.database), range(16)))
        self.assertEqual({count for count, _ in visits}, {1})

    def test_http_cookie_and_response_headers(self):
        with patch.object(server, 'VISITOR_DB', self.database), patch.object(server.Handler, 'log_message'):
            with server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler) as httpd:
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                try:
                    url = f'http://127.0.0.1:{httpd.server_port}/api/visitors'
                    browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                    with browser.open(url) as response:
                        self.assertEqual(json.load(response), {'visitors': 1})
                        self.assertEqual(response.headers['Cache-Control'], 'no-store')
                        self.assertIn('HttpOnly', response.headers['Set-Cookie'])
                        self.assertIn('SameSite=Lax', response.headers['Set-Cookie'])
                    with browser.open(url) as response:
                        self.assertEqual(json.load(response), {'visitors': 1})
                    with urllib.request.urlopen(url) as response:
                        self.assertEqual(json.load(response), {'visitors': 2})
                finally:
                    httpd.shutdown()
                    thread.join()


if __name__ == '__main__':
    unittest.main()
