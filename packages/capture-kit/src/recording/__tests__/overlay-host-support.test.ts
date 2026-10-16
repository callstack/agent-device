import { test } from 'vitest';
import assert from 'node:assert/strict';
import { getRecordingOverlaySupportWarning } from '../overlay.ts';

test('recording overlays are explicitly unsupported on non-macOS hosts', () => {
  assert.equal(
    getRecordingOverlaySupportWarning('linux'),
    'touch overlay burn-in is only available on macOS hosts; returning raw video plus gesture telemetry',
  );
  assert.equal(getRecordingOverlaySupportWarning('darwin'), undefined);
});
