import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type {
  AppLogProcessMarkerReadOutcome,
  AppLogProcessOwnership,
} from '@agent-device/contracts/app-log-runtime';
import {
  cleanupManagedAppLogProcess,
  reattachCleanupOnlyAppLogProcess,
} from './app-log-process-recovery.ts';

const decoded = {
  status: 'decoded',
  marker: { pid: 42, startTime: 'started', command: 'adb logcat' },
} as const;

test.each([
  [
    undefined,
    'owned-alive',
    {
      status: 'unreattachable',
      reason: 'ownership-fence-lost',
      message: 'App-log process marker path is missing',
    },
  ],
  [{ status: 'missing' }, 'owned-alive', { status: 'missing' }],
  [
    { status: 'invalid', message: 'corrupt' },
    'owned-alive',
    { status: 'unreattachable', reason: 'ownership-fence-lost', message: 'corrupt' },
  ],
  [decoded, 'missing', { status: 'missing' }],
  [decoded, 'ownership-lost', { status: 'unreattachable', reason: 'ownership-fence-lost' }],
  [decoded, 'owned-alive', { status: 'unreattachable', reason: 'transport-not-reattachable' }],
] as const)(
  'cleanup-only reattach preserves marker trust state %#',
  async (read, ownership, expected) => {
    const fixture = processHost(read, ownership);
    assert.deepEqual(
      await reattachCleanupOnlyAppLogProcess(fixture.host, read ? '/pid' : undefined),
      expected,
    );
    assert.equal(fixture.terminate.mock.calls.length, 0);
  },
);

test('dead owned marker recovery clears terminal evidence before the next start', async () => {
  let marker: AppLogProcessMarkerReadOutcome = decoded;
  const clearMarker = vi.fn(async () => {
    marker = { status: 'missing' };
  });
  const host = {
    processes: {
      readMarker: vi.fn(async () => marker),
      clearMarker,
      inspect: vi.fn(async () => 'missing' as const),
      terminate: vi.fn(async () => 'already-missing' as const),
    },
  };
  const startReplacement = vi.fn(async () => {
    if (marker.status !== 'missing') throw new Error('stale marker still blocks replacement');
    return 'launched';
  });

  assert.deepEqual(await reattachCleanupOnlyAppLogProcess(host, '/pid'), { status: 'missing' });
  assert.equal(await startReplacement(), 'launched');
  assert.equal(clearMarker.mock.calls.length, 1);
});

test.each([
  [
    undefined,
    'owned-alive',
    'terminated',
    {
      status: 'cleanup-pending',
      reason: 'manual-recovery-required',
      message: 'App-log process marker path is missing',
    },
  ],
  [{ status: 'missing' }, 'owned-alive', 'terminated', { status: 'already-missing' }],
  [
    { status: 'invalid', message: 'corrupt' },
    'owned-alive',
    'terminated',
    { status: 'cleanup-pending', reason: 'manual-recovery-required', message: 'corrupt' },
  ],
  [
    decoded,
    'ownership-lost',
    'terminated',
    { status: 'cleanup-pending', reason: 'ownership-fence-lost' },
  ],
  [decoded, 'missing', 'terminated', { status: 'already-missing' }],
  [
    decoded,
    'owned-alive',
    'ownership-lost',
    { status: 'cleanup-pending', reason: 'ownership-fence-lost' },
  ],
  [decoded, 'owned-alive', 'already-missing', { status: 'already-missing' }],
  [decoded, 'owned-alive', 'terminated', { status: 'cleaned' }],
] as const)(
  'managed cleanup preserves ownership certainty %#',
  async (read, ownership, terminated, expected) => {
    const fixture = processHost(read, ownership, terminated);
    assert.deepEqual(
      await cleanupManagedAppLogProcess(fixture.host, read ? '/pid' : undefined),
      expected,
    );
    assert.equal(
      fixture.clearMarker.mock.calls.length,
      (expected.status === 'already-missing' && read === decoded) || expected.status === 'cleaned'
        ? 1
        : 0,
    );
  },
);

function processHost(
  read: AppLogProcessMarkerReadOutcome | undefined,
  ownership: AppLogProcessOwnership,
  terminated: 'terminated' | 'already-missing' | 'ownership-lost' = 'terminated',
) {
  const clearMarker = vi.fn(async () => undefined);
  const terminate = vi.fn(async () => terminated);
  return {
    host: {
      processes: {
        readMarker: vi.fn(async () => read!),
        clearMarker,
        inspect: vi.fn(async () => ownership),
        terminate,
      },
    },
    clearMarker,
    terminate,
  };
}
