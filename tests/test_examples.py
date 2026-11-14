import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import server
from examples import discover_examples, resolve_example_file


class IncludedExamplesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'gerber'
        self.root.mkdir()

    def add(self, name, content='G04 sample*\n'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def test_empty_or_missing_directory(self):
        self.assertEqual(discover_examples(self.root), [])
        self.assertEqual(discover_examples(self.root / 'missing'), [])

    def test_kicad_set_groups_outer_layers_and_drills(self):
        for suffix in ['F_Cu.gbr', 'B_Cu.gbr', 'Edge_Cuts.gbr', 'PTH.drl', 'NPTH.drl', 'In1_Cu.gbr', 'F_Silkscreen.gbr']:
            self.add('board-' + suffix)
        self.add('board-job.gbrjob', json.dumps({'GeneralSpecs': {'BoardThickness': 1.6}}))
        catalog = discover_examples(self.root)
        self.assertEqual(len(catalog), 1)
        self.assertEqual(catalog[0]['name'], 'board')
        self.assertEqual([f['role'] for f in catalog[0]['files']], ['front', 'back', 'outline', 'drill', 'npth', 'job'])

    def test_common_extensions_and_x2_headers(self):
        for name in ['sample.gtl', 'sample.gbl', 'sample.gko', 'sample.drl']:
            self.add(name)
        self.add('second.gbr', '%TF.FileFunction,Copper,L2,Bot*%\n')
        self.add('internal-front.gbr', '%TF.FileFunction,Copper,L2,Inr*%\n')
        catalog = {x['id']: x for x in discover_examples(self.root)}
        self.assertEqual([f['role'] for f in catalog['sample']['files']], ['front', 'back', 'outline', 'drill'])
        self.assertEqual(catalog['second']['files'][0]['role'], 'back')
        self.assertNotIn('internal', catalog)

    def test_job_metadata_groups_arbitrary_filenames(self):
        self.add('project/random-a.gbr')
        self.add('project/random-b.gbr')
        self.add('project/random-inner.gbr')
        job = {'FilesAttributes': [
            {'Path': 'random-a.gbr', 'FileFunction': 'Copper,L1,Top'},
            {'Path': 'random-b.gbr', 'FileFunction': 'Copper,L4,Bot'},
            {'Path': 'random-inner.gbr', 'FileFunction': 'Copper,L2,Inr'},
        ]}
        self.add('project/demo-job.gbrjob', json.dumps(job))
        catalog = discover_examples(self.root)
        self.assertEqual(len(catalog), 1)
        self.assertEqual(catalog[0]['id'], 'project/demo')
        self.assertEqual([f['role'] for f in catalog[0]['files']], ['front', 'back', 'job'])

    def test_added_and_removed_subfolders_are_discovered_each_time(self):
        self.add('first/board-F_Cu.gbr')
        self.assertEqual(len(discover_examples(self.root)), 1)
        added = self.add('second/board-B_Cu.gbr')
        self.assertEqual(len(discover_examples(self.root)), 2)
        added.unlink()
        self.assertEqual(len(discover_examples(self.root)), 1)

    def test_paths_are_confined_and_unsupported_files_are_rejected(self):
        outside = Path(self.temp.name) / 'outside.gbr'
        outside.write_text('outside')
        (self.root / 'escape-F_Cu.gbr').symlink_to(outside)
        self.add('.hidden/board-F_Cu.gbr')
        self.add('note.md')
        for name in ['../outside.gbr', str(outside), 'escape-F_Cu.gbr', '.hidden/board-F_Cu.gbr', 'note.md']:
            with self.assertRaises((ValueError, FileNotFoundError)):
                resolve_example_file(self.root, name)
        self.assertEqual(discover_examples(self.root), [])

    def test_http_catalog_and_file_download(self):
        content = '%TF.FileFunction,Copper,L1,Top*%\nG04 exact content*\n'
        self.add('folder/space board-F_Cu.gbr', content)
        with patch.object(server, 'EXAMPLES_ROOT', self.root), patch.object(server.Handler, 'log_message'):
            with server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler) as httpd:
                thread = threading.Thread(target=httpd.serve_forever, daemon=True)
                thread.start()
                try:
                    base = f'http://127.0.0.1:{httpd.server_port}'
                    with urllib.request.urlopen(base + '/api/examples') as response:
                        catalog = json.load(response)['examples']
                        self.assertEqual(response.headers['Cache-Control'], 'no-store')
                    with urllib.request.urlopen(base + catalog[0]['files'][0]['url']) as response:
                        self.assertEqual(response.read(), content.encode())
                    with self.assertRaises(urllib.error.HTTPError) as raised:
                        urllib.request.urlopen(base + '/api/examples/file?path=..%2Foutside.gbr')
                    self.assertEqual(raised.exception.code, 404)
                finally:
                    httpd.shutdown()
                    thread.join()


if __name__ == '__main__':
    unittest.main()
