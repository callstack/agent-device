import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  buildSimctlListArgs,
  listAppleSimulators,
  parseSimctlAppleDevices,
} from './simulator-inventory.ts';
import { commandResult, createInventoryHost, inventoryScope } from './inventory.fixtures.ts';

const simulatorPayload = {
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
      {
        name: 'iPhone 16',
        udid: 'iphone-1',
        state: 'Booted',
        isAvailable: true,
      },
      {
        name: 'Unavailable iPad',
        udid: 'ipad-1',
        state: 'Shutdown',
        isAvailable: false,
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
      {
        name: 'Apple TV 4K',
        udid: 'tv-1',
        state: 'Shutdown',
        isAvailable: true,
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
      {
        name: 'Apple Watch',
        udid: 'watch-1',
        state: 'Booted',
        isAvailable: true,
      },
    ],
  },
};

test('simctl parser keeps available supported runtimes and their target semantics', () => {
  assert.deepEqual(parseSimctlAppleDevices(simulatorPayload, '/tmp/custom-set'), [
    {
      platform: 'apple',
      id: 'iphone-1',
      name: 'iPhone 16',
      kind: 'simulator',
      target: 'mobile',
      appleOs: 'ios',
      booted: true,
      simulatorSetPath: '/tmp/custom-set',
    },
    {
      platform: 'apple',
      id: 'tv-1',
      name: 'Apple TV 4K',
      kind: 'simulator',
      target: 'tv',
      appleOs: 'tvos',
      booted: false,
      simulatorSetPath: '/tmp/custom-set',
    },
  ]);
});

test('simulator inventory scopes bounded simctl and reports fresh booted observations', async () => {
  const calls: Array<{ tool: string; args: readonly string[]; timeoutMs?: number }> = [];
  const observed: string[] = [];
  const host = createInventoryHost({
    observed,
    run: async (request) => {
      calls.push({ tool: request.tool, args: request.args, timeoutMs: request.timeoutMs });
      return commandResult(JSON.stringify(simulatorPayload));
    },
  });

  const devices = await listAppleSimulators(
    host,
    { iosSimulatorSetPath: ' /tmp/custom-set ', target: 'mobile', booted: true },
    inventoryScope,
  );

  assert.deepEqual(calls, [
    {
      tool: 'simctl',
      args: ['--set', '/tmp/custom-set', 'list', 'devices', '-j'],
      timeoutMs: 3_000,
    },
  ]);
  assert.deepEqual(
    devices.map((device) => device.id),
    ['iphone-1', 'tv-1'],
  );
  assert.deepEqual(observed, ['iphone-1']);
  assert.deepEqual(buildSimctlListArgs(undefined), ['list', 'devices', '-j']);
});

test('simulator inventory classifies malformed native output as a command failure', async () => {
  const host = createInventoryHost({ run: async () => commandResult('not json') });
  await assert.rejects(
    listAppleSimulators(host, {}, inventoryScope),
    (error: unknown) => error instanceof AppError && error.code === 'COMMAND_FAILED',
  );
});
