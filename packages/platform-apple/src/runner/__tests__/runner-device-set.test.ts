import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import { IOS_DEVICE, IOS_SIMULATOR, TVOS_SIMULATOR } from './device-fixtures.ts';
import { STUBBED_APPLE_TOOLCHAIN, stubAppleToolchainProbes } from './apple-toolchain-fixtures.ts';
import {
  isSameRunnerSimulator,
  runnerSimulatorSetFailureDetails,
  xcodebuildDestinationArgs,
} from '../runner-device-set.ts';
import { resolveExpectedRunnerCacheMetadata } from '../runner-cache-metadata.ts';

const toolchainProbe = stubAppleToolchainProbes();
beforeEach(resetAllProcessMemosForTests);
afterEach(() => {
  vi.restoreAllMocks();
});

const DESTINATION = 'platform=iOS Simulator,id=sim-1';

test('a scoped-set simulator names its set to xcodebuild beside the destination', () => {
  const device = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulators' };

  assert.deepEqual(xcodebuildDestinationArgs(device, DESTINATION), [
    '-destination',
    DESTINATION,
    '-DVTSimulatorSetLocation=/tmp/tenant-a/simulators',
  ]);
});

test('every Apple simulator family in a scoped set names its set', () => {
  const device = { ...TVOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulators' };

  assert.ok(
    xcodebuildDestinationArgs(device, DESTINATION).includes(
      '-DVTSimulatorSetLocation=/tmp/tenant-a/simulators',
    ),
  );
});

test('the default set, a blank set path and a physical device leave the destination alone', () => {
  for (const device of [
    IOS_SIMULATOR,
    { ...IOS_SIMULATOR, simulatorSetPath: '   ' },
    { ...IOS_DEVICE, simulatorSetPath: '/tmp/tenant-a/simulators' },
  ]) {
    assert.deepEqual(xcodebuildDestinationArgs(device, DESTINATION), ['-destination', DESTINATION]);
  }
});

test('a failure reports the scoped set and the selected Xcode only for a scoped-set simulator', () => {
  const scoped = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulators' };
  resolveExpectedRunnerCacheMetadata(scoped);

  assert.deepEqual(runnerSimulatorSetFailureDetails(scoped), {
    simulatorSetPath: '/tmp/tenant-a/simulators',
    xcodeVersion: STUBBED_APPLE_TOOLCHAIN.xcodeVersion,
  });
  assert.deepEqual(runnerSimulatorSetFailureDetails(IOS_SIMULATOR), {});
});

test('a failure before any cache decision read the Xcode names the scoped set, never probing', () => {
  toolchainProbe.mockClear();
  assert.deepEqual(
    runnerSimulatorSetFailureDetails({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/sims' }),
    { simulatorSetPath: '/tmp/tenant-a/sims' },
  );
  assert.equal(toolchainProbe.mock.calls.length, 0);
});

test('one udid in two simulator sets names two simulators', () => {
  const tenantA = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulators' };

  assert.equal(isSameRunnerSimulator(tenantA, { ...tenantA }), true);
  assert.equal(
    isSameRunnerSimulator(IOS_SIMULATOR, { ...IOS_SIMULATOR, simulatorSetPath: ' ' }),
    true,
  );
  assert.equal(isSameRunnerSimulator(tenantA, IOS_SIMULATOR), false);
  assert.equal(
    isSameRunnerSimulator(tenantA, { ...tenantA, simulatorSetPath: '/tmp/tenant-b/simulators' }),
    false,
  );
});
