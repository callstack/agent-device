import assert from 'node:assert/strict';
import { test } from 'vitest';
import { snapshotSourceCaptureError, snapshotSourceError } from './errors.ts';

// The scope decides whether the route retires the app generation from the bridge, so it is a
// required constructor argument (no default): a failure cannot be built without naming its side of
// the rule. These two factories are the only constructors, and each names its scope.
test('snapshotSourceError is evidence about the app generation', () => {
  const error = snapshotSourceError('transport-failure', 'bridge-disconnected');
  assert.equal(error.failureScope, 'generation');
});

test('snapshotSourceCaptureError is evidence about this capture only', () => {
  const preparing = snapshotSourceCaptureError('preparing', 'bridge-preparation-pending');
  assert.equal(preparing.failureScope, 'capture');
  const rotated = snapshotSourceCaptureError('unsupported', 'window-coordinate-space-unresolved', {
    windows: 1,
  });
  assert.equal(rotated.failureScope, 'capture');
  assert.equal(rotated.details?.windows, 1);
});
