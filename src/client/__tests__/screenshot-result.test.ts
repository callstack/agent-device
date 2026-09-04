import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  normalizeScreenshotCaptureResult,
  pickScreenshotResultData,
} from '../screenshot-result.ts';

const CROP_WARNING =
  'CROP_PARTIAL_INTERSECTION: the selector frame extends past the captured image; the crop was clipped to the image frame';

test('normalizeScreenshotCaptureResult surfaces response-level warnings', () => {
  const result = normalizeScreenshotCaptureResult(
    {
      path: '/tmp/screenshot.png',
      width: 40,
      height: 20,
      warnings: [CROP_WARNING],
    },
    'qa',
  );
  assert.equal(result.path, '/tmp/screenshot.png');
  assert.equal(result.width, 40);
  assert.equal(result.height, 20);
  assert.deepEqual(result.warnings, [CROP_WARNING]);
  assert.deepEqual(result.identifiers, { session: 'qa' });
});

test('normalizeScreenshotCaptureResult omits warnings when the response carries none', () => {
  const result = normalizeScreenshotCaptureResult({ path: '/tmp/screenshot.png' }, 'qa');
  assert.equal(result.path, '/tmp/screenshot.png');
  assert.ok(!('warnings' in result));
  assert.deepEqual(result.identifiers, { session: 'qa' });
});

test('pickScreenshotResultData keeps warnings only when present and non-empty', () => {
  assert.deepEqual(
    pickScreenshotResultData({ path: '/tmp/a.png', width: 40, warnings: [CROP_WARNING] }),
    { path: '/tmp/a.png', width: 40, warnings: [CROP_WARNING] },
  );
  assert.deepEqual(pickScreenshotResultData({ path: '/tmp/a.png', warnings: [] }), {
    path: '/tmp/a.png',
  });
});
