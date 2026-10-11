// Shard suffix rendering for replay-test display names (#3420): the `[n/m device]` suffix is
// what operators scan in sharded runs, so device-name preference, whitespace collapse, and the
// missing-count fallback are pinned at the owning module's entry point.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ReplaySuiteTestResult } from '@agent-device/contracts/replay';
import {
  formatReplayTestShardSuffix,
  replayTestCaseName,
  replayTestDisplayNameWithFile,
} from '../format.ts';

function shardedResult(
  overrides: Partial<Extract<ReplaySuiteTestResult, { status: 'passed' }>> = {},
): ReplaySuiteTestResult {
  return {
    file: '/flows/login.ad',
    title: 'Login',
    session: 'default',
    status: 'passed',
    durationMs: 10,
    attempts: 1,
    replayed: 0,
    healed: 0,
    ...overrides,
  };
}

test('shard suffix renders the index, count, and device name', () => {
  assert.equal(
    formatReplayTestShardSuffix(
      shardedResult({ shardIndex: 0, shardCount: 2, deviceName: 'Pixel 8', deviceId: 'em-1' }),
    ),
    ' [1/2 Pixel 8]',
  );
});

test('shard suffix falls back to the device id when no name is carried', () => {
  assert.equal(
    formatReplayTestShardSuffix(shardedResult({ shardIndex: 1, shardCount: 3, deviceId: 'em-5' })),
    ' [2/3 em-5]',
  );
});

test('shard suffix drops blank device fields and unknown counts', () => {
  assert.equal(formatReplayTestShardSuffix(shardedResult({ shardIndex: 0 })), ' [1/?]');
  assert.equal(
    formatReplayTestShardSuffix(
      shardedResult({ shardIndex: 2, shardCount: 4, deviceName: '   ', deviceId: ' ' }),
    ),
    ' [3/4]',
  );
});

test('display names append the shard suffix to the title and fall back to the filename', () => {
  const sharded = shardedResult({ shardIndex: 0, shardCount: 2, deviceName: 'Pixel 8' });
  assert.equal(replayTestDisplayNameWithFile(sharded), 'Login [1/2 Pixel 8]');
  assert.equal(
    replayTestDisplayNameWithFile({
      ...sharded,
      title: '   ',
    }),
    'login.ad [1/2 Pixel 8]',
  );
  assert.equal(replayTestCaseName(sharded), 'Login [1/2 Pixel 8]');
});
