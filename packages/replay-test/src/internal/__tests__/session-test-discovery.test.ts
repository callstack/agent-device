import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { discoverReplayTestEntries } from '../session-test-discovery.ts';
import type { ReplayTestManifest, ReplayTestSource } from '../session-test-types.ts';

// Scheduler-owned discovery policy (#1478 P3b): which sources a --platform filter runs, which
// it skips and with what message, and rejecting a suite that matched nothing. Inspection is the
// host's, so these drive fake sources rather than the filesystem — the ordering and routing
// behavior they used to share a file with is pinned host-side.
const declared = (value: 'ios' | 'android'): ReplayTestManifest => ({
  device: { platform: { kind: 'declared', value } },
});
const unspecified: ReplayTestManifest = { device: { platform: { kind: 'unspecified' } } };
const callerBound: ReplayTestManifest = { device: { platform: { kind: 'caller-bound' } } };

const sourcesOf =
  (...entries: ReplayTestSource[]) =>
  () =>
    entries;

test('platform filter skips sources that declared no platform', () => {
  const entries = discoverReplayTestEntries({
    inputs: ['suite'],
    platformFilter: 'android',
    discoverSources: sourcesOf(
      { path: '01-untyped.ad', manifest: unspecified },
      { path: '02-android.ad', manifest: declared('android') },
    ),
  });

  const untyped = entries.find((entry) => entry.path === '01-untyped.ad');
  assert.equal(untyped?.kind, 'skip');
  if (untyped?.kind === 'skip') {
    assert.match(untyped.message, /missing platform metadata for --platform android/);
  }
  assert.equal(entries.find((entry) => entry.path === '02-android.ad')?.kind, 'run');
});

test('platform filter runs caller-bound sources, which take their platform from the invocation', () => {
  const entries = discoverReplayTestEntries({
    inputs: ['suite'],
    platformFilter: 'android',
    discoverSources: sourcesOf({ path: '01-flow.yaml', manifest: callerBound }),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, 'run');
});

test('platform filter drops declared sources that do not match, without a skip entry', () => {
  const entries = discoverReplayTestEntries({
    inputs: ['suite'],
    platformFilter: 'android',
    discoverSources: sourcesOf(
      { path: '01-ios.ad', manifest: declared('ios') },
      { path: '02-android.ad', manifest: declared('android') },
    ),
  });

  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['02-android.ad'],
  );
});

test('a suite that matched nothing after filtering is rejected', () => {
  assert.throws(
    () =>
      discoverReplayTestEntries({
        inputs: ['suite'],
        platformFilter: 'android',
        discoverSources: sourcesOf({ path: '01-ios.ad', manifest: declared('ios') }),
      }),
    (error: unknown) => error instanceof AppError && /No replay tests matched/.test(error.message),
  );
});
