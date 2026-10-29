import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSimulation } from './simulation.js';

test('keeps pinned files in their zone and entry files on their slot', () => {
  const nodes = [
    { z: 0, x: 5, y: 5, vx: 0, vy: 0, fx: 200, fy: 200, r: 2, entry: null },
    { z: 0, x: 10, y: 10, vx: 0, vy: 0, r: 2, entry: './device', slot: { x: 40, y: 0 } },
  ];
  const { tick } = createSimulation({
    nodes,
    pairs: [],
    zones: [{ index: 0 }],
    hubs: [{ x: 0, y: 0 }],
    zoneRect: [{ x: 0, y: 0, w: 100, h: 100 }],
    pkgOfZone: ['kernel'],
  });
  tick();
  assert.deepEqual([nodes[0].x, nodes[0].y], [95, 95]);
  assert.deepEqual([nodes[1].x, nodes[1].y], [40, 0]);
});

test('repels large nodes throughout their force range across grid cells', () => {
  const nodes = [
    { z: 0, x: 40, y: 50, vx: 0, vy: 0, fx: null, fy: null, r: 12, entry: null },
    { z: 0, x: 100, y: 50, vx: 0, vy: 0, fx: null, fy: null, r: 12, entry: null },
  ];
  const { tick } = createSimulation({
    nodes,
    pairs: [],
    zones: [{ index: 0 }],
    hubs: [{ x: 0, y: 0 }],
    zoneRect: [{ x: 0, y: 0, w: 140, h: 100 }],
    pkgOfZone: ['kernel'],
  });
  tick();
  assert.ok(nodes[0].x < 40);
  assert.ok(nodes[1].x > 100);
});
