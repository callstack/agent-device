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

  // Two samples cannot distinguish chronic slowness from a one-off — stats are
  // reported, but no warning fires.
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
  });
});

test('a slow cold-start capture alone does not warn', () => {
  const session = {};

  // First capture folds runner/helper startup (12s); warm captures are fast.
  recordSnapshotTiming(session, { durationMs: 12_400, backend: 'xctest', platform: 'ios' });
  for (const durationMs of [520, 540, 510, 530, 525]) {
    recordSnapshotTiming(session, { durationMs, backend: 'xctest', platform: 'ios' });
  }

  const summary = summarizeSnapshotDiagnostics(session);
  expect(summary?.warning).toBeUndefined();
  // The cold sample still shows in the full stats.
  expect(summary?.stats).toMatchObject({ count: 6, maxMs: 12_400 });
});

test('chronically slow warm captures warn without counting the cold start', () => {
  const session = {};

  recordSnapshotTiming(session, { durationMs: 12_400, backend: 'xctest', platform: 'ios' });
  for (const durationMs of [2_600, 2_700, 2_500, 2_800]) {
    recordSnapshotTiming(session, { durationMs, backend: 'xctest', platform: 'ios' });
  }

  const summary = summarizeSnapshotDiagnostics(session);
  expect(summary?.warning).toContain('p95 2800ms over 4 captures');
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
