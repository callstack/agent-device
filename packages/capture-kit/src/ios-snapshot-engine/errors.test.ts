import assert from 'node:assert/strict';
import { test } from 'vitest';
import { toIosSnapshotEngineErrorDetails } from './errors.ts';
import { IosSnapshotEngineError } from './types.ts';

test('engine error details preserve typed public context', () => {
  const error = new IosSnapshotEngineError('invalid-viewport', 'invalid viewport', {
    field: 'viewport',
    index: 4,
    parentIndex: 2,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    clip: { x: 1, y: 2, width: 3, height: 4 },
    projection: 'regular',
  });

  assert.deepEqual(toIosSnapshotEngineErrorDetails(error), {
    reason: 'invalid-viewport',
    field: 'viewport',
    index: 4,
    parentIndex: 2,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    clip: { x: 1, y: 2, width: 3, height: 4 },
    projection: 'regular',
  });
});
