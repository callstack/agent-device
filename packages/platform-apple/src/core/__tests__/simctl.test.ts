import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildSimctlArgs,
  buildSimctlArgsForDevice,
  scopeSimctlArgs,
  scopeSimctlArgsForDevice,
} from '../simctl.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
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

test('scopeSimctlArgs prefixes a trimmed simulator set and omits a blank one', () => {
  assert.deepEqual(scopeSimctlArgs(['list', 'devices', '-j'], { simulatorSetPath: ' /tmp/set ' }), [
    '--set',
    '/tmp/set',
    'list',
    'devices',
    '-j',
  ]);
  assert.deepEqual(scopeSimctlArgs(['list', 'devices', '-j'], { simulatorSetPath: '  ' }), [
    'list',
    'devices',
    '-j',
  ]);
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
