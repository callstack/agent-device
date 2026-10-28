import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import { IOS_DEVICE, IOS_SIMULATOR, TVOS_SIMULATOR } from './device-fixtures.ts';
import { STUBBED_APPLE_TOOLCHAIN } from './apple-toolchain-fixtures.ts';
import {
  isSameRunnerSimulator,
  runnerSimulatorSetFailureDetails,
  xcodebuildDestinationArgs,
} from '../runner-device-set.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

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
  assert.deepEqual(
    runnerSimulatorSetFailureDetails({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/sims' }),
    { simulatorSetPath: '/tmp/tenant-a/sims', xcodeVersion: STUBBED_APPLE_TOOLCHAIN.xcodeVersion },
  );
  assert.deepEqual(runnerSimulatorSetFailureDetails(IOS_SIMULATOR), {});
});

test('a failure under an unreadable Xcode names the scoped set alone', () => {
  appleRunnerTestHost.update({ commandDeveloperDir: () => mkdtempForTestSync('no-xcode-') });
  assert.deepEqual(
    runnerSimulatorSetFailureDetails({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/sims' }),
    { simulatorSetPath: '/tmp/tenant-a/sims' },
  );
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
