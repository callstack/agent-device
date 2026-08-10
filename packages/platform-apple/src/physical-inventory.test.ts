import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  listPhysicalAppleDevices,
  parseXctracePhysicalAppleDevices,
} from './physical-inventory.ts';
import { commandResult, createInventoryHost, inventoryScope } from './inventory.fixtures.ts';

test('xctrace parser accepts Apple devices only from the online Devices section', () => {
  assert.deepEqual(
    parseXctracePhysicalAppleDevices(
      [
        '== Devices ==',
        'My iPhone [phone-1]',
        'Living Room Apple TV (18.0) (tv-1)',
        'Studio Mac [mac-1]',
        '== Devices Offline ==',
        'Offline iPhone [offline-1]',
        '== Simulators ==',
        'iPhone 16 (18.0) (sim-1)',
      ].join('\n'),
    ).map((device) => [device.id, device.target, device.appleOs]),
    [
      ['phone-1', 'mobile', 'ios'],
      ['tv-1', 'tv', 'tvos'],
    ],
  );
});

test('physical inventory prefers CoreDevice, supplements xctrace, and disposes its file', async () => {
  const calls: string[][] = [];
  let disposeCount = 0;
  const host = createInventoryHost({
    run: async (request) => {
      calls.push([request.tool, ...request.args]);
      if (request.tool === 'devicectl') return commandResult();
      return commandResult(['== Devices ==', 'Phone [core-1]', 'Apple TV [tv-1]'].join('\n'));
    },
    createTemporaryTextFile: async () => ({
      path: '/tmp/devices.json',
      readText: async () =>
        JSON.stringify({
          result: {
            devices: [
              {
                name: 'My iPhone',
                hardwareProperties: {
                  platform: 'iOS',
                  productType: 'iPhone16,2',
                  udid: 'core-1',
                },
              },
            ],
          },
        }),
      [Symbol.asyncDispose]: async () => {
        disposeCount += 1;
      },
    }),
  });

  const devices = await listPhysicalAppleDevices(host, inventoryScope);

  assert.deepEqual(
    devices.map((device) => [device.id, device.iosPhysicalDeviceBackend]),
    [
      ['core-1', 'coredevice'],
      ['tv-1', 'xctest'],
    ],
  );
  assert.equal(disposeCount, 1);
  assert.ok(calls.some((args) => args[0] === 'devicectl'));
  assert.ok(calls.some((args) => args[0] === 'xctrace'));
});

test('physical inventory fails soft when either native source is unavailable', async () => {
  const host = createInventoryHost({
    run: async (request) => {
      if (request.tool === 'devicectl') throw new Error('CoreDevice unavailable');
      return commandResult('== Devices ==\nMy iPhone [phone-1]');
    },
    createTemporaryTextFile: async () => {
      throw new Error('temporary storage unavailable');
    },
  });

  assert.deepEqual(
    (await listPhysicalAppleDevices(host, inventoryScope)).map((device) => device.id),
    ['phone-1'],
  );
});

test('physical inventory preserves request cancellation instead of failing soft', async () => {
  const controller = new AbortController();
  const reason = new Error('inventory cancelled');
  const requestScope = { ...inventoryScope, signal: controller.signal };
  const host = createInventoryHost({
    run: async () => {
      controller.abort(reason);
      throw reason;
    },
    createTemporaryTextFile: async () => ({
      path: '/tmp/devices.json',
      readText: async () => '{}',
      [Symbol.asyncDispose]: async () => undefined,
    }),
  });

  await assert.rejects(listPhysicalAppleDevices(host, requestScope), reason);
});
