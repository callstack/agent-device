import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLayout, fitScale } from './layout.js';

test('fits a large graph into a canvas narrower than the usual padding', () => {
  const scale = fitScale(108, 500, 70, 3000, 2000);
  assert.ok(scale > 0);
  assert.ok(3000 * scale <= 108);
  assert.ok(2000 * scale <= 500);
});

test('shows all public subpaths that resolve to the same source file', () => {
  const nodes = [{ id: 'packages/provider/src/index.ts', index: 0, z: 0, entry: null }];
  const zones = [{ id: 'provider', index: 0, rank: 1, files: 1 }];
  createLayout({
    zones,
    nodes,
    raw: { edges: [] },
    entryManifest: {
      'packages/provider': [
        { id: nodes[0].id, subpath: '.' },
        { id: nodes[0].id, subpath: './agent-device' },
      ],
    },
    PALETTE: [],
  });
  assert.equal(nodes[0].entry, '., ./agent-device');
});
