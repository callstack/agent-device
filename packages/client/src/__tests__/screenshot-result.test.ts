import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SCREENSHOT_BURST_LIMITS } from '@agent-device/contracts/capture';
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

test('normalizeScreenshotCaptureResult surfaces the display rotation the daemon reported', () => {
  const result = normalizeScreenshotCaptureResult(
    { path: '/tmp/screenshot.png', displayRotation: 'landscape-left' },
    'qa',
  );
  assert.equal(result.displayRotation, 'landscape-left');
});

test('normalizeScreenshotCaptureResult drops a display rotation outside the rotation vocabulary', () => {
  const result = normalizeScreenshotCaptureResult(
    { path: '/tmp/screenshot.png', displayRotation: 'sideways' },
    'qa',
  );
  assert.ok(!('displayRotation' in result));
});

// The default daemon payload reaches this normalizer on the SDK's default path and, through
// `pickScreenshotResultData`, on the CLI's default `--json` path. A burst whose frames the
// normalizer dropped would break the result's "reports every frame" promise at both boundaries.
test('normalizeScreenshotCaptureResult carries the burst frames the daemon reported', () => {
  const result = normalizeScreenshotCaptureResult(
    {
      path: '/tmp/burst/page-0001.png',
      width: 100,
      height: 50,
      frames: [
        { path: '/tmp/burst/page-0001.png', capturedAtMs: 1_000, displayRotation: 'portrait' },
        { path: '/tmp/burst/page-0002.png', capturedAtMs: 1_400 },
      ],
    },
    'qa',
  );
  assert.deepEqual(result.frames, [
    { path: '/tmp/burst/page-0001.png', capturedAtMs: 1_000, displayRotation: 'portrait' },
    { path: '/tmp/burst/page-0002.png', capturedAtMs: 1_400 },
  ]);
  assert.equal(result.path, '/tmp/burst/page-0001.png');
  assert.deepEqual(result.identifiers, { session: 'qa' });
});

test('normalizeScreenshotCaptureResult keeps only frames with a path and a wall clock, within the burst bound', () => {
  const frames: unknown[] = [
    ...Array.from({ length: SCREENSHOT_BURST_LIMITS.maxCount }, (_, index) => ({
      path: `/tmp/burst/f-${index}.png`,
      capturedAtMs: index,
    })),
    { capturedAtMs: 9_999 },
    { path: '/tmp/burst/extra.png' },
    'frame',
  ];
  const result = normalizeScreenshotCaptureResult({ path: '/tmp/burst/f-0.png', frames }, 'qa');
  assert.equal(result.frames?.length, SCREENSHOT_BURST_LIMITS.maxCount);
  assert.deepEqual(result.frames?.[0], { path: '/tmp/burst/f-0.png', capturedAtMs: 0 });
});

test('normalizeScreenshotCaptureResult omits empty and absent frames', () => {
  assert.ok(!('frames' in normalizeScreenshotCaptureResult({ path: '/tmp/a.png' }, 'qa')));
  assert.ok(
    !('frames' in normalizeScreenshotCaptureResult({ path: '/tmp/a.png', frames: [] }, 'qa')),
  );
});

test('pickScreenshotResultData keeps the frames a normalized result carried', () => {
  const frames = [{ path: '/tmp/a-0001.png', capturedAtMs: 1 }];
  assert.deepEqual(pickScreenshotResultData({ path: '/tmp/a-0001.png', frames }), {
    path: '/tmp/a-0001.png',
    frames,
  });
});
