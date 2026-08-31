import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, test } from 'vitest';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  prepareRunnerLeaseForStartup,
  runnerOwnerStartTime,
  writeRunnerLease,
  type RunnerLease,
  type RunnerLeaseCleanupAdapter,
} from '../runner-lease.ts';
import { makeRunnerLease } from './runner-session-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

// #1320 retained-runner rule, tested at the lease seam directly: device claims
// are exclusive per device, so claim authority proves a busy lease's owner
// released the device and merely kept its runner warm.

let ownerStateDir: string;

beforeEach(() => {
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync(
    'agent-device-claim-takeover-lease-',
  );
  // The owner state dir must exist on disk: an owner whose state dir is gone
  // classifies as stale (reclaimable) instead of busy.
  ownerStateDir = mkdtempForTestSync('agent-device-claim-takeover-owner-');
});

afterEach(() => {
  fs.rmSync(ownerStateDir, { recursive: true, force: true });
});

function liveForeignLease(deviceId: string, overrides: Partial<RunnerLease> = {}): RunnerLease {
  return makeRunnerLease({
    deviceId,
    ownerToken: 'owner-foreign-live',
    ownerPid: process.pid,
    ownerStartTime: runnerOwnerStartTime(),
    ownerStateDir,
    ...overrides,
  });
}

function recordingCleanupAdapter(): RunnerLeaseCleanupAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    cleanupRunnerProcessTree: async (_pid, signal) => {
      calls.push(`process-tree:${signal}`);
    },
    cleanupRunnerXcodebuildProcesses: async (_deviceId, ownerToken) => {
      calls.push(`xcodebuild:${ownerToken ?? 'any'}`);
    },
    cleanupTempFile: (filePath) => {
      calls.push(`temp:${filePath}`);
    },
  };
}

test('device-claim authority reclaims a live foreign claim-aware lease', async () => {
  const deviceId = 'claim-takeover-sim';
  writeRunnerLease(liveForeignLease(deviceId, { deviceClaimProtocol: 1 }));
  appleRunnerTestHost.update({ hasDeviceClaimAuthority: (id) => id === deviceId });
  const cleanup = recordingCleanupAdapter();

  await prepareRunnerLeaseForStartup(deviceId, cleanup);

  assert.ok(cleanup.calls.includes('xcodebuild:owner-foreign-live'));
  // The lease was released as part of the takeover, so the next classification
  // sees an empty store instead of the foreign owner.
  const emptyCleanup = recordingCleanupAdapter();
  await prepareRunnerLeaseForStartup(deviceId, emptyCleanup);
  assert.ok(emptyCleanup.calls.includes('xcodebuild:any'));
});

test('a claim-aware lease still refuses without device-claim authority', async () => {
  const deviceId = 'claim-no-authority-sim';
  writeRunnerLease(liveForeignLease(deviceId, { deviceClaimProtocol: 1 }));
  const cleanup = recordingCleanupAdapter();

  await assert.rejects(
    async () => await prepareRunnerLeaseForStartup(deviceId, cleanup),
    /already owned by another agent-device daemon/,
  );
  assert.deepEqual(cleanup.calls, []);
});

test('a pre-claims lease is never preempted despite device-claim authority', async () => {
  // A lease without deviceClaimProtocol was written by a build that never
  // arbitrates through device claims, so its owner may be actively using the
  // runner without holding any claim.
  const deviceId = 'legacy-lease-sim';
  writeRunnerLease(liveForeignLease(deviceId));
  appleRunnerTestHost.update({ hasDeviceClaimAuthority: () => true });
  const cleanup = recordingCleanupAdapter();

  await assert.rejects(
    async () => await prepareRunnerLeaseForStartup(deviceId, cleanup),
    /already owned by another agent-device daemon/,
  );
  assert.deepEqual(cleanup.calls, []);
});
