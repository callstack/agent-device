import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withCommandHost } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import {
  buildSimctlArgsForAddress,
  buildSimctlArgsForDevice,
  readSimctlContainerPath,
  readSimctlDevicesByRuntime,
  readSimctlDeviceState,
  scopeSimctlArgsForDevice,
  simctlAvailabilityProbeArgs,
  simctlListInventoryArgs,
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

test('simctlListInventoryArgs prefixes a trimmed simulator set and omits a blank one', () => {
  assert.deepEqual(simctlListInventoryArgs(' /tmp/set '), ['--set', '/tmp/set', 'list', '-j']);
  assert.deepEqual(simctlListInventoryArgs('  '), ['list', '-j']);
  assert.deepEqual(simctlListInventoryArgs(undefined), ['list', '-j']);
});

/**
 * The default device root is where `simctl` looks when argv names no set, and `simctl` resolves it
 * from the environment it is spawned with. A daemon request runs on a bound command host whose HOME
 * can differ from this process's, so the identity of "the default set" belongs to that host.
 */
async function withHostHome<T>(home: string | undefined, run: () => Promise<T>): Promise<T> {
  return await withCommandHost(
    { host: { env: home === undefined ? {} : { HOME: home }, cwd: '/' }, requestEnv: undefined },
    run,
  );
}

test('an explicit set is kept when the executing host names a different home', async () => {
  // The regression: this process's home is the real default root, the host that will run `simctl`
  // names another one. Erasing the caller's explicit set here would run the command against the
  // process user's simulators instead of the ones the caller asked for.
  const requested = await mkdtempForTest('sm11-host-home-set-');
  const canonicalRequested = await fs.realpath(requested);
  const processHome = await fs.realpath(process.env.HOME ?? '');
  const processHomeDefault = path.join(
    processHome,
    'Library',
    'Developer',
    'CoreSimulator',
    'Devices',
  );

  await withHostHome('/tmp/another-host-home', async () => {
    assert.deepEqual(simctlListInventoryArgs(canonicalRequested), [
      '--set',
      canonicalRequested,
      'list',
      '-j',
    ]);
    assert.deepEqual(
      simulatorAddressFor({ ...IOS_SIMULATOR, simulatorSetPath: canonicalRequested }),
      { udid: 'sim-1', simulatorSetPath: canonicalRequested },
    );
  });

  // Naming the process user's own default root is not the host's default either.
  await withHostHome('/tmp/another-host-home', async () => {
    assert.deepEqual(simctlListInventoryArgs(processHomeDefault), [
      '--set',
      processHomeDefault,
      'list',
      '-j',
    ]);
  });
});

test('naming the executing host default root answers as the default set', async () => {
  // The host that runs the command is the authority: when its own HOME names the default root,
  // spelling it explicitly is the same set as naming none, so both share one lock/cache identity.
  const hostHome = await fs.realpath(process.env.HOME ?? '');
  const defaultSet = path.join(hostHome, 'Library', 'Developer', 'CoreSimulator', 'Devices');

  await withHostHome(hostHome, async () => {
    assert.deepEqual(simctlListInventoryArgs(defaultSet), ['list', '-j']);
    assert.deepEqual(simulatorAddressFor({ ...IOS_SIMULATOR, simulatorSetPath: defaultSet }), {
      udid: 'sim-1',
      simulatorSetPath: undefined,
    });
  });
});

test('an explicit set survives a host that names no home', async () => {
  // No authority means no default to compare against: the caller's scope is kept, never guessed.
  const requested = await mkdtempForTest('sm11-unbound-set-');
  const canonicalRequested = await fs.realpath(requested);
  await withHostHome(undefined, async () => {
    assert.deepEqual(simctlListInventoryArgs(canonicalRequested), [
      '--set',
      canonicalRequested,
      'list',
      '-j',
    ]);
  });
  await withCommandHost(
    { host: { env: { HOME: 'relative-home' }, cwd: '/' }, requestEnv: undefined },
    async () => {
      assert.deepEqual(simctlListInventoryArgs(canonicalRequested), [
        '--set',
        canonicalRequested,
        'list',
        '-j',
      ]);
    },
  );
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

// Production prints these verbatim from `xcrun simctl get_app_container sim-1 <bundle> data`:
// an app with no container exits 0 and prints the literal `(null)` or nothing at all.
test('readSimctlContainerPath reads the printed path and rejects the no-container answers', () => {
  assert.equal(readSimctlContainerPath('/containers/data/App/abc\n'), '/containers/data/App/abc');
  assert.equal(readSimctlContainerPath('(null)\n'), undefined);
  assert.equal(readSimctlContainerPath('  (null)  '), undefined);
  assert.equal(readSimctlContainerPath(''), undefined);
  assert.equal(readSimctlContainerPath(' \n'), undefined);
});
