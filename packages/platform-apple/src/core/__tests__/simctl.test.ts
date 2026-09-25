import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildSimctlArgsForAddress,
  buildSimctlArgsForDevice,
  readSimctlDevicesByRuntime,
  readSimctlDeviceState,
  scopeSimctlArgsForDevice,
  simctlAvailabilityProbeArgs,
  simctlListDevicesArgs,
  simulatorAddressFor,
  type SimulatorAddress,
} from '../simctl.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 17',
  kind: 'simulator',
  target: 'mobile',
};

test('buildSimctlArgsForAddress uses --set when the address names a simulator set', () => {
  const args = buildSimctlArgsForAddress(
    simulatorAddressFor({ ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-a/simulator-set' }),
    ['list', 'devices', '-j'],
  );
  assert.deepEqual(args, [
    'simctl',
    '--set',
    '/tmp/tenant-a/simulator-set',
    'list',
    'devices',
    '-j',
  ]);
});

test('buildSimctlArgsForDevice includes simulator set from device metadata', () => {
  const args = buildSimctlArgsForDevice(
    { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-b/simulator-set' },
    ['bootstatus', 'sim-1', '-b'],
  );
  assert.deepEqual(args, [
    'simctl',
    '--set',
    '/tmp/tenant-b/simulator-set',
    'bootstatus',
    'sim-1',
    '-b',
  ]);
});

test('buildSimctlArgsForDevice leaves non-simulator commands unchanged', () => {
  const args = buildSimctlArgsForDevice({ ...IOS_SIMULATOR, kind: 'device' }, [
    'bootstatus',
    'sim-1',
    '-b',
  ]);
  assert.deepEqual(args, ['simctl', 'bootstatus', 'sim-1', '-b']);
});

test('simctlListDevicesArgs prefixes a trimmed simulator set and omits a blank one', () => {
  assert.deepEqual(simctlListDevicesArgs(' /tmp/set '), [
    '--set',
    '/tmp/set',
    'list',
    'devices',
    '-j',
  ]);
  assert.deepEqual(simctlListDevicesArgs('  '), ['list', 'devices', '-j']);
  assert.deepEqual(simctlListDevicesArgs(undefined), ['list', 'devices', '-j']);
});

test('simctlAvailabilityProbeArgs names no set', () => {
  assert.deepEqual(simctlAvailabilityProbeArgs(), ['help']);
});

test('scopeSimctlArgsForDevice scopes simulators only', () => {
  const scoped = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-c/simulator-set' };
  assert.deepEqual(scopeSimctlArgsForDevice(scoped, ['shutdown', 'sim-1']), [
    '--set',
    '/tmp/tenant-c/simulator-set',
    'shutdown',
    'sim-1',
  ]);
  assert.deepEqual(scopeSimctlArgsForDevice({ ...scoped, kind: 'device' }, ['shutdown', 'sim-1']), [
    'shutdown',
    'sim-1',
  ]);
});

test('simulatorAddressFor carries the set of iOS-family simulators only', () => {
  const scoped = { ...IOS_SIMULATOR, simulatorSetPath: '/tmp/tenant-d/simulator-set' };
  assert.deepEqual(simulatorAddressFor(scoped), {
    udid: 'sim-1',
    simulatorSetPath: '/tmp/tenant-d/simulator-set',
  });
  assert.deepEqual(simulatorAddressFor({ ...scoped, kind: 'device' }), {
    udid: 'sim-1',
    simulatorSetPath: undefined,
  });
  assert.deepEqual(simulatorAddressFor({ ...scoped, platform: 'android', kind: 'emulator' }), {
    udid: 'sim-1',
    simulatorSetPath: undefined,
  });
});

test('simulatorAddressFor names a blank set path as the default set', () => {
  assert.deepEqual(simulatorAddressFor({ ...IOS_SIMULATOR, simulatorSetPath: '   ' }), {
    udid: 'sim-1',
    simulatorSetPath: undefined,
  });
});

function compileTimeSimulatorScopeProof(): void {
  // @ts-expect-error A simulator address is minted from its DeviceInfo, never written by hand.
  const forged: SimulatorAddress = { udid: 'sim-1', simulatorSetPath: undefined };
  void forged;
  // @ts-expect-error Set scope is private; a call that names no device goes through a named mint.
  type SetScope = (typeof import('../simctl.ts'))['scopeSimctlArgs'];
  const setScope: SetScope | undefined = undefined;
  void setScope;
}
void compileTimeSimulatorScopeProof;

const LISTING = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
      { udid: 'sim-a', state: 'Shutdown', name: 'iPhone 16' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'sim-b', state: 'Booted', name: 'iPhone 17' },
    ],
  },
});

test('readSimctlDeviceState reports the listed state of the requested simulator', () => {
  assert.equal(readSimctlDeviceState(LISTING, 'sim-b'), 'Booted');
  assert.equal(readSimctlDeviceState(LISTING, 'sim-a'), 'Shutdown');
});

test('readSimctlDeviceState is null for an unlisted, unreadable, or empty listing', () => {
  assert.equal(readSimctlDeviceState(LISTING, 'sim-missing'), null);
  assert.equal(readSimctlDeviceState('not json', 'sim-b'), null);
  assert.equal(readSimctlDeviceState('{}', 'sim-b'), null);
  assert.equal(readSimctlDeviceState(JSON.stringify({ devices: { runtime: {} } }), 'sim-b'), null);
});

test('readSimctlDevicesByRuntime keys each device list by its runtime', () => {
  const devicesByRuntime = readSimctlDevicesByRuntime(LISTING);
  assert.deepEqual(
    Object.entries(devicesByRuntime).map(([runtime, devices]) => [
      runtime,
      devices.map(({ udid }) => udid),
    ]),
    [
      ['com.apple.CoreSimulator.SimRuntime.iOS-18-0', ['sim-a']],
      ['com.apple.CoreSimulator.SimRuntime.iOS-26-0', ['sim-b']],
    ],
  );
  assert.deepEqual(readSimctlDevicesByRuntime('{}'), {});
  assert.throws(() => readSimctlDevicesByRuntime('not json'), SyntaxError);
});
