import math
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import server

CONFIG = {
    'toolDiameter': 0.2, 'isolation': 0, 'feedRate': 100,
    'passDepth': -0.05, 'zSafe': 2, 'zchange': 10, 'cutFeed': 80,
    'zeroStart': True, 'eulerian': True, 'optimise': 0.00254,
    'tolerance': 0.003, 'pathFindingLimit': 1, 'millingOverlap': 50,
    'millSpeed': 10000, 'cutSpeed': 10000, 'cutterDiameter': 1,
    'zcut': -1.8, 'cutInfeed': 0.6,
}


class GenerationOptionsTests(unittest.TestCase):
    def test_omitted_backtrack_disables_implicit_unlimited_retracing(self):
        args = server.option_args(CONFIG, '/tmp/output')
        self.assertEqual([x for x in args if x.startswith('--backtrack=')], ['--backtrack=0'])

    def test_blank_and_zero_backtrack_are_disabled(self):
        for value in (None, 0):
            with self.subTest(value=value):
                args = server.option_args({**CONFIG, 'backtrack': value}, '/tmp/output')
                self.assertEqual([x for x in args if x.startswith('--backtrack=')], ['--backtrack=0'])

    def test_backtracking_requires_an_explicit_positive_value(self):
        args = server.option_args({**CONFIG, 'backtrack': 0.5}, '/tmp/output')
        self.assertEqual([x for x in args if x.startswith('--backtrack=')], ['--backtrack=0.5'])

    def test_negative_backtracking_is_rejected(self):
        with self.assertRaises(ValueError):
            server.option_args({**CONFIG, 'backtrack': -1}, '/tmp/output')


class RealGerberRegressionTests(unittest.TestCase):
    def test_ebike_disconnected_traces_are_not_joined_at_cutting_depth(self):
        paths = list(server.EXAMPLES_ROOT.rglob('bike lcd-B_Cu.gbr'))
        if not paths or not os.access(server.PCB2GCODE, os.X_OK):
            self.skipTest('Bundled e-bike Gerbers or pcb2gcode binary unavailable')
        folder = paths[0].parent
        with tempfile.TemporaryDirectory() as output:
            args = server.option_args(CONFIG, output)
            for role, suffix in [('front', 'F_Cu'), ('back', 'B_Cu'), ('outline', 'Edge_Cuts')]:
                args.append(f'--{role}={folder / ("bike lcd-" + suffix + ".gbr")}')
            result = subprocess.run([str(server.PCB2GCODE), *args], capture_output=True, text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stderr[-1500:])
            text = (Path(output) / 'board_back.ngc').read_text()
        position = {'X': 0., 'Y': 0., 'Z': 0.}
        mode = 0
        cutting = []
        rapid_count = 0
        for line in text.splitlines():
            code = re.sub(r'\([^)]*\)', '', line).split(';')[0]
            for value in re.findall(r'G\s*(\d+)', code):
                if int(value) in (0, 1):
                    mode = int(value)
            target = dict(position)
            for axis, value in re.findall(r'([XYZ])\s*([+-]?(?:\d+\.?\d*|\.\d+))', code):
                target[axis] = float(value)
            if (position['X'], position['Y']) != (target['X'], target['Y']):
                if mode == 0:
                    rapid_count += 1
                    self.assertGreaterEqual(min(position['Z'], target['Z']), CONFIG['zSafe'] - 1e-6)
                elif min(position['Z'], target['Z']) < 0:
                    cutting.append(((position['X'], position['Y']), (target['X'], target['Y'])))
            position = target
        self.assertGreater(rapid_count, 27)
        # The supplied broken file cuts directly between these disconnected traces.
        # Its midpoint must remain outside the corrected cutting paths.
        point = (-2.100325, 20.51593)
        def distance(segment):
            a, b = segment
            dx, dy = b[0] - a[0], b[1] - a[1]
            length2 = dx * dx + dy * dy
            t = max(0, min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2)) if length2 else 0
            return math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy)
        self.assertGreater(min(map(distance, cutting)), 1)


if __name__ == '__main__':
    unittest.main()
