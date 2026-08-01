import { expect, test } from 'vitest';
import {
  mergeSnapshotDiagnostics,
  recordSnapshotTiming,
  summarizeSnapshotDiagnostics,
} from '@agent-device/contracts/capture';

test('records session snapshot timing stats', () => {
  const session = {};

  recordSnapshotTiming(session, { durationMs: 400, backend: 'android', platform: 'android' });
  recordSnapshotTiming(session, { durationMs: 2_100, backend: 'android', platform: 'android' });

  expect(summarizeSnapshotDiagnostics(session)).toEqual({
    stats: {
      count: 2,
      p50Ms: 400,
      p95Ms: 2_100,
      maxMs: 2_100,
      slowThresholdMs: 1_500,
      platform: 'android',
      backends: { android: 2 },
    },
    warning: expect.stringContaining('p95 2100ms over 2 captures'),
  });
});

test('merges snapshot diagnostics without inflating capture count', () => {
  const merged = mergeSnapshotDiagnostics([
    {
      stats: {
        count: 1,
        p50Ms: 300,
        p95Ms: 300,
        maxMs: 300,
        slowThresholdMs: 1_500,
        platform: 'android',
      },
    },
    {
      stats: {
        count: 2,
        p50Ms: 500,
        p95Ms: 1_900,
        maxMs: 1_900,
        slowThresholdMs: 1_500,
        platform: 'android',
      },
    },
  ]);

  expect(merged?.stats).toMatchObject({
    count: 3,
    p50Ms: 500,
    p95Ms: 1_900,
    maxMs: 1_900,
    platform: 'android',
  });
  expect(merged?.warning).toContain('p95 1900ms over 3 captures');
});
