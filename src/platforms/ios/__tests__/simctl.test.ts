import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildSimctlArgs, buildSimctlArgsForDevice } from '../../apple/core/simctl.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'ios',
  id: 'sim-1',
  name: 'iPhone 17',
  kind: 'simulator',
  target: 'mobile',
};

test('buildSimctlArgs uses --set when simulator set path is provided', () => {
  const args = buildSimctlArgs(['list', 'devices', '-j'], {
    simulatorSetPath: '/tmp/tenant-a/simulator-set',
  });
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
