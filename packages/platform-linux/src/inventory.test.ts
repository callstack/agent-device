import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInventoryHost, PlatformRequestScope } from '@agent-device/contracts/platform';
import { createLinuxInventory } from './inventory.ts';

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('Linux inventory derives the local desktop solely from injected host facts', async () => {
  const observed: string[] = [];
  const inventory = createLinuxInventory(createHost('linux', observed));
  assert.deepEqual(await inventory.discover({}, scope), [
    {
      platform: 'linux',
      id: 'local',
      name: 'linux-host',
      kind: 'device',
      target: 'desktop',
      booted: true,
    },
  ]);
  assert.deepEqual(observed, []);
  assert.deepEqual(await createLinuxInventory(createHost('darwin', [])).discover({}, scope), []);
});

function createHost(
  hostOs: DeviceInventoryHost['hostOs'],
  observed: string[],
): DeviceInventoryHost {
  return {
    commands: {
      which: async () => undefined,
      run: async () => {
        throw new Error('unused');
      },
    },
    toolchains: { prepare: async () => undefined },
    files: {
      isExecutable: async () => false,
      createTemporaryTextFile: async () => {
        throw new Error('unused');
      },
    },
    hostOs,
    hostName: 'linux-host',
    homeDirectory: '/home/test',
    observations: {
      deviceBooted: async (device) => {
        observed.push(device.id);
      },
    },
  };
}
