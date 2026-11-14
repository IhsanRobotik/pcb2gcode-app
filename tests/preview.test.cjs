const assert = require('node:assert/strict');
const test = require('node:test');
const { reflectToolpath } = require('../preview.js');

test('back machine coordinates align with front coordinates on one board', () => {
  const result = reflectToolpath('G90\nG0 X-10 Y3 Z2\nG1 X-20 Y3 Z-0.05');
  assert.match(result, /G0 X10\.00000 Y3 Z2/);
  assert.match(result, /G1 X20\.00000 Y3 Z-0\.05/);
});

test('reflection uses the configured flip axis without moving sparse layers to their own origin', () => {
  const result = reflectToolpath('G90\nG1 X27 Y4 Z-0.05', { axis: 20 });
  assert.match(result, /X13\.00000 Y4 Z-0\.05/);
});

test('Y-axis flipping leaves X coordinates unchanged', () => {
  const result = reflectToolpath('G90\nG0 X8 Y-12 Z2', { flipY: true, axis: 5 });
  assert.match(result, /G0 X8 Y22\.00000 Z2/);
});

test('mirroring reverses arcs and relative center offsets while preserving radius, Z and feed', () => {
  const result = reflectToolpath('G02 X-20 Y5 I-2 J3 Z-0.05 F100\nG03 X-10 Y5 R5');
  assert.match(result, /G03 X20\.00000 Y5 I2\.00000 J3 Z-0\.05 F100/);
  assert.match(result, /G02 X10\.00000 Y5 R5/);
});

test('incremental moves reverse direction without adding the absolute flip offset', () => {
  const result = reflectToolpath('G90 X-2\nG91\nG1 X-3 Y1\nG90 X-4', { axis: 10 });
  assert.match(result, /G90 X22\.00000/);
  assert.match(result, /G1 X3\.00000 Y1/);
  assert.match(result, /G90 X24\.00000/);
});

test('comments and rapid clearance heights are unchanged', () => {
  const result = reflectToolpath('G00 X-3 Z2 (G91 X99) ; G02 X-9\nG00 Z10');
  assert.equal(result, 'G00 X3.00000 Z2 (G91 X99) ; G02 X-9\nG00 Z10');
});
