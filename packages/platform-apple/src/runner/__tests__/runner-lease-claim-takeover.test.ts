import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  prepareRunnerLeaseForStartup,
  runnerOwnerStartTime,
  writeRunnerLease,
  type RunnerLease,
  type RunnerLeaseCleanupAdapter,
} from '../runner-lease.ts';
import { IOS_SIMULATOR } from './device-fixtures.ts';
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

function takeoverDevice(id: string): DeviceInfo {
  return { ...IOS_SIMULATOR, id };
}

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
  const device = takeoverDevice('claim-takeover-sim');
  writeRunnerLease(liveForeignLease(device.id, { deviceClaimProtocol: 1 }));
  const probedDevices: DeviceInfo[] = [];
  appleRunnerTestHost.update({
    hasDeviceClaimAuthority: (probed) => {
      probedDevices.push(probed);
      return probed.id === device.id;
    },
  });
  const cleanup = recordingCleanupAdapter();

  await prepareRunnerLeaseForStartup(device, cleanup);

  assert.ok(cleanup.calls.includes('xcodebuild:owner-foreign-live'));
  // The probe must receive the full device identity, never a bare id: claim
  // ownership is canonical family/OS/id, and a same-id claim from another
  // platform family grants nothing.
  assert.equal(probedDevices[0]?.platform, 'apple');
  assert.equal(probedDevices[0]?.appleOs, 'ios');
  assert.equal(probedDevices[0]?.id, device.id);
  // The lease was released as part of the takeover, so the next classification
  // sees an empty store instead of the foreign owner.
  const emptyCleanup = recordingCleanupAdapter();
  await prepareRunnerLeaseForStartup(device, emptyCleanup);
  assert.ok(emptyCleanup.calls.includes('xcodebuild:any'));
});

test('a claim-aware lease still refuses without device-claim authority', async () => {
  const device = takeoverDevice('claim-no-authority-sim');
  writeRunnerLease(liveForeignLease(device.id, { deviceClaimProtocol: 1 }));
  const cleanup = recordingCleanupAdapter();

  await assert.rejects(
    async () => await prepareRunnerLeaseForStartup(device, cleanup),
    /already owned by another agent-device daemon/,
  );
  assert.deepEqual(cleanup.calls, []);
});

test('a pre-claims lease is never preempted despite device-claim authority', async () => {
  // A lease without deviceClaimProtocol was written by a build that never
  // arbitrates through device claims, so its owner may be actively using the
  // runner without holding any claim.
  const device = takeoverDevice('legacy-lease-sim');
  writeRunnerLease(liveForeignLease(device.id));
  appleRunnerTestHost.update({ hasDeviceClaimAuthority: () => true });
  const cleanup = recordingCleanupAdapter();

  await assert.rejects(
    async () => await prepareRunnerLeaseForStartup(device, cleanup),
    /already owned by another agent-device daemon/,
  );
  assert.deepEqual(cleanup.calls, []);
});
