import assert from 'node:assert/strict';
import { test } from 'vitest';
import { toIosSnapshotEngineErrorDetails } from './errors.ts';
import { IosSnapshotEngineError } from './types.ts';

test('engine error details expose only the public reason and field', () => {
  const error = new IosSnapshotEngineError('invalid-viewport', 'invalid viewport', {
    field: 'viewport',
    index: 4,
    frame: { x: 0, y: 0, width: 10, height: 10 },
  });

  assert.deepEqual(toIosSnapshotEngineErrorDetails(error), {
    reason: 'invalid-viewport',
    field: 'viewport',
  });
});
