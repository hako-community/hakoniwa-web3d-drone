import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTerrainGeometryData } from '../src/terrain_grid_geometry.mjs';

const fixtureUrl = new URL('../tests/fixtures/terrain-grid-3x3.json', import.meta.url);
const grid = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const geometry = createTerrainGeometryData(grid);

assert.equal(geometry.diagnostics.vertexCount, 9);
assert.equal(geometry.diagnostics.triangleCount, 8);
assert.equal(geometry.positions.length, 27);
assert.equal(geometry.indices.length, 24);
assert.equal(geometry.diagnostics.minimumModelHeightM, 0);
assert.equal(geometry.diagnostics.maximumModelHeightM, 8);
assert.equal(geometry.diagnostics.usesZBaselineInGeometry, false);
assert.deepEqual(Array.from(geometry.positions.slice(0, 3)), [1, 0, 1]);
assert.deepEqual(Array.from(geometry.positions.slice(-3)), [-1, 8, -1]);
assert.deepEqual(Array.from(geometry.indices.slice(0, 6)), [0, 1, 3, 1, 4, 3]);

console.log('terrain geometry contract: PASSED');
