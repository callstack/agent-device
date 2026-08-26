import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  DeviceInventoryHostFor,
  PlatformRequestScope,
} from '@agent-device/contracts/platform-runtime-host';
import { createLinuxInventory } from './inventory.ts';

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('Linux inventory derives the local desktop solely from injected host facts', async () => {
  const inventory = createLinuxInventory(createHost('linux'));
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
  assert.deepEqual(await createLinuxInventory(createHost('darwin')).discover({}, scope), []);
});

function createHost(
  hostOs: DeviceInventoryHostFor<'linux'>['hostOs'],
): DeviceInventoryHostFor<'linux'> {
  return {
    hostOs,
    hostName: 'linux-host',
  };
}
