import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createAppleInventorySource } from './inventory.ts';
import { commandResult, createInventoryHost, inventoryScope } from './inventory.fixtures.ts';
import { inventoryModule } from './index.ts';

test('Apple inventory projects the host Mac without loading native tools', async () => {
  let commands = 0;
  const host = createInventoryHost({
    which: async () => {
      commands += 1;
      return undefined;
    },
  });

  assert.deepEqual(
    await createAppleInventorySource(host).discover(
      { platform: 'apple', target: 'desktop' },
      inventoryScope,
    ),
    [
      {
        platform: 'apple',
        id: 'host-macos-local',
        name: 'Test Mac',
        kind: 'device',
        target: 'desktop',
        appleOs: 'macos',
        booted: true,
      },
    ],
  );
  assert.equal(commands, 0);
});

test('Apple inventory rejects unsupported hosts and missing tools with typed errors', async () => {
  await assert.rejects(
    createAppleInventorySource(createInventoryHost({ hostOs: 'linux' })).discover(
      {},
      inventoryScope,
    ),
    (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_PLATFORM',
  );
  await assert.rejects(
    createAppleInventorySource(createInventoryHost({ which: async () => undefined })).discover(
      {},
      inventoryScope,
    ),
    (error: unknown) => error instanceof AppError && error.code === 'TOOL_MISSING',
  );
});

test('simulator-only inventory avoids physical discovery and observes fresh booted devices', async () => {
  const calls: string[][] = [];
  const observed: string[] = [];
  const host = createInventoryHost({
    observed,
    run: async (request) => {
      calls.push([request.tool, ...request.args]);
      return commandResult(
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              {
                name: 'iPhone 16',
                udid: 'sim-1',
                state: 'Booted',
                isAvailable: true,
              },
            ],
          },
        }),
      );
    },
  });

  const source = await inventoryModule.loadInventory(host);
  const devices = await source.discover({ kind: 'simulator', booted: true }, inventoryScope);

  assert.equal(inventoryModule.family, 'apple');
  assert.ok(Object.isFrozen(inventoryModule));
  assert.deepEqual(
    devices.map((device) => device.id),
    ['sim-1'],
  );
  assert.deepEqual(observed, ['sim-1']);
  assert.deepEqual(calls, [['simctl', 'list', 'devices', '-j']]);
});

test('simulator-set inventory remains scoped while retaining the host Mac', async () => {
  const calls: string[][] = [];
  const host = createInventoryHost({
    run: async (request) => {
      calls.push([request.tool, ...request.args]);
      return commandResult(
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
              {
                name: 'Apple TV 4K',
                udid: 'tv-1',
                state: 'Shutdown',
                isAvailable: true,
              },
            ],
          },
        }),
      );
    },
  });

  const devices = await createAppleInventorySource(host).discover(
    { iosSimulatorSetPath: '/tmp/custom-set' },
    inventoryScope,
  );

  assert.deepEqual(
    devices.map((device) => device.id),
    ['tv-1', 'host-macos-local'],
  );
  assert.deepEqual(calls, [['simctl', '--set', '/tmp/custom-set', 'list', 'devices', '-j']]);
});

test('unscoped Apple inventory starts simulator and physical discovery concurrently', async () => {
  const calls: string[] = [];
  let releaseSimulators!: () => void;
  const simulatorsBlocked = new Promise<void>((resolve) => {
    releaseSimulators = resolve;
  });
  const host = createInventoryHost({
    run: async (request) => {
      calls.push(request.tool);
      if (request.tool === 'simctl') {
        await simulatorsBlocked;
        return commandResult(JSON.stringify({ devices: {} }));
      }
      return commandResult(request.tool === 'xctrace' ? '== Devices ==' : '');
    },
  });

  const discovery = createAppleInventorySource(host).discover({}, inventoryScope);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(calls.includes('simctl'));
  assert.ok(calls.includes('xctrace'));
  releaseSimulators();
  await discovery;
});
