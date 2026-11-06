import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  buildRunnerLease,
  cleanupRunnerLeasesForOwner,
  currentRunnerLeaseOwnerToken,
  withRunnerLeaseLock,
  writeRunnerLease,
  type RunnerLeaseCleanupAdapter,
} from '../runner-lease.ts';
import { IOS_SIMULATOR, IOS_DEVICE, MACOS_DEVICE, TVOS_SIMULATOR } from './device-fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

beforeEach(() => {
  process.env.AGENT_DEVICE_IOS_RUNNER_LEASE_DIR = mkdtempForTestSync('agent-device-ax-lease-');
});

function leaseFor(device: DeviceInfo) {
  return buildRunnerLease({
    device,
    sessionId: 'ax-test',
    runnerPid: undefined,
    endpoint: { port: 8123, token: 'test-token' },
    xctestrunPath: '/tmp/ax-test.xctestrun',
    jsonPath: '/tmp/ax-test.json',
  });
}

for (const confirmed of [true, false]) {
  test(`lease cleanup repairs only after confirmed termination (${confirmed}), before releasing`, async () => {
    const lease = leaseFor({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/ax-simlock-set' });
    writeRunnerLease(lease);
    const calls: string[] = [];
    const cleanup: RunnerLeaseCleanupAdapter = {
      cleanupRunnerProcessTree: async (_pid, signal) => {
        calls.push(signal);
      },
      cleanupRunnerXcodebuildProcesses: async () => {
        calls.push('xcodebuild');
      },
      confirmRunnerTermination: async () => {
        calls.push('confirm');
        return confirmed;
      },
      prepareIosSimulatorAccessibility: async (device) => {
        assert.equal(currentRunnerLeaseOwnerToken(device.id), lease.ownerToken);
        assert.equal(device.appleOs, 'ios');
        assert.equal(device.simulatorSetPath, '/tmp/ax-simlock-set');
        calls.push('repair');
      },
      cleanupTempFile: () => {
        calls.push('temp');
      },
    };
    await cleanupRunnerLeasesForOwner({ pid: lease.ownerPid }, cleanup);
    assert.deepEqual(calls, [
      'SIGTERM',
      'xcodebuild',
      'SIGKILL',
      'confirm',
      ...(confirmed ? ['repair'] : []),
      'temp',
      'temp',
    ]);
    assert.equal(currentRunnerLeaseOwnerToken(lease.deviceId), null);
  });
}

test('failed repair emits a diagnostic and still releases the lease', async () => {
  const lease = leaseFor(IOS_SIMULATOR);
  writeRunnerLease(lease);
  const diagnostic = vi.fn();
  appleRunnerTestHost.update({ emitDiagnostic: diagnostic });
  await cleanupRunnerLeasesForOwner(
    { pid: lease.ownerPid },
    {
      cleanupRunnerProcessTree: async () => {},
      cleanupRunnerXcodebuildProcesses: async () => {},
      confirmRunnerTermination: async () => true,
      prepareIosSimulatorAccessibility: async () => {
        throw new Error('repair unavailable');
      },
      cleanupTempFile: () => {},
    },
  );
  assert.ok(
    diagnostic.mock.calls.some(
      ([event]) => event.phase === 'ios_runner_accessibility_repair_failed',
    ),
  );
  assert.equal(currentRunnerLeaseOwnerToken(lease.deviceId), null);
});

for (const device of [
  IOS_SIMULATOR,
  IOS_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  { ...IOS_SIMULATOR, appleOs: 'visionos' },
] as DeviceInfo[]) {
  test(`legacy or excluded ${device.kind}/${device.appleOs} lease never repairs`, async () => {
    const lease = leaseFor(device);
    if (device === IOS_SIMULATOR) {
      delete lease.simulatorTarget;
      lease.simulatorSetPath = '/tmp/legacy-set';
    } else assert.equal(lease.simulatorTarget, undefined);
    writeRunnerLease(lease);
    const prepare = vi.fn();
    await cleanupRunnerLeasesForOwner(
      { pid: lease.ownerPid },
      {
        cleanupRunnerProcessTree: async () => {},
        cleanupRunnerXcodebuildProcesses: async () => {},
        confirmRunnerTermination: async () => true,
        prepareIosSimulatorAccessibility: prepare,
        cleanupTempFile: () => {},
      },
    );
    assert.equal(prepare.mock.calls.length, 0);
    assert.equal(currentRunnerLeaseOwnerToken(lease.deviceId), null);
  });
}

test('owner cleanup skips a lease replaced while waiting for the ownership fence', async () => {
  const lease = leaseFor(IOS_SIMULATOR);
  writeRunnerLease(lease);
  const repair = vi.fn();
  const terminate = vi.fn();
  let cleanup: Promise<void> | undefined;
  await withRunnerLeaseLock(lease.deviceId, async () => {
    cleanup = cleanupRunnerLeasesForOwner(
      { pid: lease.ownerPid },
      {
        cleanupRunnerProcessTree: terminate,
        cleanupRunnerXcodebuildProcesses: async () => {},
        confirmRunnerTermination: async () => true,
        prepareIosSimulatorAccessibility: repair,
        cleanupTempFile: () => {},
      },
    );
    writeRunnerLease({ ...lease, ownerToken: 'successor-token' });
  });
  await cleanup;
  assert.equal(terminate.mock.calls.length, 0);
  assert.equal(repair.mock.calls.length, 0);
  assert.equal(currentRunnerLeaseOwnerToken(lease.deviceId), 'successor-token');
});
