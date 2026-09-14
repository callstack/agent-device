import { test } from 'vitest';
import assert from 'node:assert/strict';
import { scrollSurfaceIsStuck } from '../scroll-edge-state.ts';

const cases: ReadonlyArray<readonly [string, readonly string[], boolean]> = [
  ['identical captures', ['a', 'a', 'a', 'a'], true],
  ['rubber-band alternation', ['bottom', 'top', 'bottom', 'top'], true],
  ['two stable signatures', ['a', 'b', 'a', 'b'], true],
  ['parked after one detour', ['a', 'b', 'a', 'a'], true],
  // A newest signature the window has not seen is a pass that just made progress: keep scrolling.
  ['fresh progress after identical passes', ['a', 'a', 'a', 'b'], false],
  ['three distinct signatures', ['a', 'b', 'c', 'a'], false],
  ['below the minimum length', ['a', 'a', 'a'], false],
];

for (const [label, signatures, expected] of cases) {
  test(`scrollSurfaceIsStuck: ${label}`, () => {
    assert.equal(scrollSurfaceIsStuck(signatures), expected);
  });
}
