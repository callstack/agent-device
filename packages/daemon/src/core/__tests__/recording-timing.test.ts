import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveGestureOffsetMs } from '../recording-timing.ts';

test('resolveGestureOffsetMs uses runner uptime anchor when available', () => {
  const offset = resolveGestureOffsetMs({
    recordingStartedAt: 1_000,
    runnerStartedAtUptimeMs: 10_000,
    gestureStartUptimeMs: 10_240,
    gestureEndUptimeMs: 10_300,
    fallbackStartedAtMs: 1_200,
    fallbackFinishedAtMs: 1_400,
  });

  assert.equal(offset, 240);
});

test('resolveGestureOffsetMs uses gesture clock origin when available', () => {
  const offset = resolveGestureOffsetMs({
    recordingStartedAt: 1_000,
    gestureClockOriginAtMs: 1_120,
    gestureClockOriginUptimeMs: 20_000,
    gestureStartUptimeMs: 20_240,
    gestureEndUptimeMs: 20_300,
    fallbackStartedAtMs: 1_500,
    fallbackFinishedAtMs: 1_900,
  });

  assert.equal(offset, 360);
});

test('resolveGestureOffsetMs derives simulator offset from gesture end uptime', () => {
  const offset = resolveGestureOffsetMs({
    recordingStartedAt: 1_000,
    gestureStartUptimeMs: 5_000,
    gestureEndUptimeMs: 5_150,
    fallbackStartedAtMs: 1_100,
    fallbackFinishedAtMs: 1_800,
  });

  assert.equal(offset, 650);
});

test('resolveGestureOffsetMs falls back to command start when no uptime data exists', () => {
  const offset = resolveGestureOffsetMs({
    recordingStartedAt: 1_000,
    fallbackStartedAtMs: 1_240,
    fallbackFinishedAtMs: 1_500,
  });

  assert.equal(offset, 240);
});
