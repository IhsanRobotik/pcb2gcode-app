const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const { resolve } = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadSource(name) {
  const filename = resolve(__dirname, '../src/lib/simulator', name + '.ts');
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = new Module(filename, module);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}
const { parseGCode } = loadSource('gcode-parser');
const { simulateHeightmap, applyMovesToHeightmap } = loadSource('heightmap');
const { displayZ } = loadSource('display');
const config = { stock: { width: 10, depth: 10, height: 1.6 }, tool: { diameter: 1, type: 'flat' }, cellSize: 0.1 };
const source = 'G21\nG90\nG00 Z2\nG00 X2 Y2\nG01 F50\nG01 Z-0.05\nG01 F100\nG01 X8 Y2\nG00 Z2\nG00 X8 Y8';

test('pcb2gcode modal XY moves retain cutting Z and rapids retain clearance Z', () => {
  const moves = parseGCode(source);
  assert.equal(moves[3].type, 'linear');
  assert.equal(moves[3].from.z, -0.05);
  assert.equal(moves[3].to.z, -0.05);
  assert.equal(moves.at(-1).type, 'rapid');
  assert.equal(moves.at(-1).to.z, 2);
});

test('rapid movement never removes stock, even below Z zero', () => {
  const moves = parseGCode('G00 X2 Y2 Z-0.05\nG00 X8 Y8');
  const full = simulateHeightmap(moves, config);
  const incremental = new Float32Array(full.data.length);
  applyMovesToHeightmap(moves, config, incremental);
  assert.ok(full.data.every((z) => z === 0));
  assert.deepEqual(incremental, full.data);
});

test('vertical plunge cuts to its endpoint before any XY feed, matching playback', () => {
  const moves = parseGCode('G00 X2 Y2 Z2\nG01 Z-0.05 F50');
  const full = simulateHeightmap(moves, config);
  assert.ok(Math.abs(full.minZ + 0.05) < 1e-7);
  const incremental = new Float32Array(full.data.length);
  applyMovesToHeightmap([moves[0]], config, incremental);
  assert.ok(incremental.every((z) => z === 0));
  const plunge = moves[1];
  const halfway = { x: 2, y: 2, z: 0.975 };
  applyMovesToHeightmap([{ ...plunge, to: halfway }], config, incremental);
  assert.ok(incremental.every((z) => z === 0));
  applyMovesToHeightmap([{ ...plunge, from: halfway }], config, incremental);
  assert.deepEqual(incremental, full.data);
});

test('rapid travel corridor remains uncut after cutting and retraction', () => {
  const full = simulateHeightmap(parseGCode(source), config);
  const at = (x, y) => full.data[Math.floor(y / config.cellSize) * full.cols + Math.floor(x / config.cellSize)];
  assert.ok(at(5, 2) < 0);
  assert.equal(at(8, 5), 0);
});

test('visual relief preserves safe and tool-change heights', () => {
  assert.equal(displayZ(2, 13.44), 2);
  assert.equal(displayZ(10, 13.44), 10);
  assert.equal(displayZ(0, 13.44), 0);
  assert.ok(Math.abs(displayZ(-0.05, 13.44) + 0.672) < 1e-9);
});
