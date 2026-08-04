import assert from 'node:assert/strict';
import { test } from 'vitest';
import { deriveSelectorCapturePolicy } from './selector-capture-policy.ts';

// The two cells that used to pass a selector expression asserted that a
// parameter the function never read had no effect, so they could not fail;
// they went out with the parameter. The predicate is the only real input, and
// the pair below covers both sides of its one decision.

test('selector capture policy keeps rect reads separate from focus reads', () => {
  assert.deepEqual(deriveSelectorCapturePolicy('visible'), {
    includeRects: true,
    interactiveOnly: false,
  });
  assert.deepEqual(deriveSelectorCapturePolicy('hidden'), {
    includeRects: true,
    interactiveOnly: false,
  });
});

test('selector capture policy reads full snapshots for every non-geometry read', () => {
  assert.deepEqual(deriveSelectorCapturePolicy('focused'), {
    includeRects: false,
    interactiveOnly: false,
  });
  assert.deepEqual(deriveSelectorCapturePolicy(), {
    includeRects: false,
    interactiveOnly: false,
  });
});
