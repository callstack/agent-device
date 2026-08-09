import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInventoryHost, PlatformRequestScope } from '@agent-device/contracts/platform';
import { createWebInventory } from './inventory.ts';

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};

test('Web inventory exposes the established static browser target without host probing', async () => {
  const observed: string[] = [];
  const host = createHost(observed);
  assert.deepEqual(await createWebInventory(host).discover({}, scope), [
    {
      platform: 'web',
      id: 'agent-browser-chrome',
      name: 'Agent Browser Chrome',
      kind: 'device',
      target: 'desktop',
      booted: true,
    },
  ]);
  assert.deepEqual(observed, []);
});

function createHost(observed: string[]): DeviceInventoryHost {
  return {
    commands: {
      which: async () => {
        throw new Error('must stay lazy');
      },
      run: async () => {
        throw new Error('must stay lazy');
      },
    },
    toolchains: { prepare: async () => undefined },
    files: {
      isExecutable: async () => {
        throw new Error('must stay lazy');
      },
      createTemporaryTextFile: async () => {
        throw new Error('must stay lazy');
      },
    },
    hostOs: 'darwin',
    hostName: 'test-host',
    homeDirectory: '/Users/test',
    observations: {
      deviceBooted: async (device) => {
        observed.push(device.id);
      },
    },
  };
}
