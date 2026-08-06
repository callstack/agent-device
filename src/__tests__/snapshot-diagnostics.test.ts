import { expect, test } from 'vitest';
import {
  mergeSnapshotDiagnostics,
  recordSnapshotTiming,
  summarizeSnapshotDiagnostics,
  summarizeSnapshotTimingSamples,
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
  // First capture folds runner/helper startup (12s); warm captures are fast.
  const samples = [12_400, 520, 540, 510, 530, 525].map((durationMs) => ({
    durationMs,
    platform: 'ios' as const,
  }));

  const summary = summarizeSnapshotTimingSamples(samples);
  expect(summary?.warning).toBeUndefined();
  // The cold sample still shows in the full stats.
  expect(summary?.stats).toMatchObject({ count: 6, maxMs: 12_400 });
});

test('chronically slow warm captures warn without counting the cold start', () => {
  const samples = [12_400, 2_600, 2_700, 2_500, 2_800].map((durationMs) => ({
    durationMs,
    platform: 'ios' as const,
  }));

  const summary = summarizeSnapshotTimingSamples(samples);
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
  // Neither constituent judged a warning (reconstructed samples are lossy and
  // order-less), so the merge must not resurrect one from the aggregate.
  expect(merged?.warning).toBeUndefined();
});

test('merge carries a warning only when a constituent run judged one', () => {
  const stats = {
    count: 4,
    p50Ms: 2_600,
    p95Ms: 2_800,
    maxMs: 2_800,
    slowThresholdMs: 1_500,
    platform: 'ios',
  } as const;

  const merged = mergeSnapshotDiagnostics([
    { stats: { ...stats } },
    { stats: { ...stats }, warning: 'Warning: ios snapshots are slow in this run: …' },
  ]);

  expect(merged?.warning).toContain('snapshots are slow in this run');
});
