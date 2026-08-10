import { PLATFORMS } from '@agent-device/kernel/device';
import { describe, expect, test, vi } from 'vitest';

const hostAdapter = vi.hoisted(() => ({ evaluations: 0 }));

vi.mock('./platform-runtime-host.ts', () => {
  hostAdapter.evaluations += 1;
  return {
    createDeviceInventoryHost: () => ({
      commands: {
        which: async () => undefined,
        run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      },
      appleTools: {
        isXcrunAvailable: async () => false,
        run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      },
      toolchains: { prepare: async () => {} },
      files: {
        isExecutable: async () => false,
        createTemporaryTextFile: async () => {
          throw new Error('unused');
        },
      },
      hostOs: 'darwin',
      hostName: 'test-host',
      homeDirectory: '/tmp/test-home',
      observations: { deviceBooted: async () => {} },
    }),
  };
});

import {
  createPlatformDeviceInventoryGateways,
  platformModuleRegistry,
} from './platform-runtime.ts';

describe('platform module metadata composition', () => {
  test('registers each canonical family exactly once in canonical order', () => {
    expect(platformModuleRegistry.families).toEqual(PLATFORMS);
    expect(platformModuleRegistry.modules.map(({ family }) => family)).toEqual(PLATFORMS);
    for (const family of PLATFORMS) {
      expect(platformModuleRegistry.get(family).family).toBe(family);
    }
  });

  test('publishes immutable inventory facades without evaluating platform mechanics', () => {
    expect(Object.isFrozen(platformModuleRegistry)).toBe(true);
    expect(Object.isFrozen(platformModuleRegistry.families)).toBe(true);
    expect(Object.isFrozen(platformModuleRegistry.modules)).toBe(true);
    for (const module of platformModuleRegistry.modules) {
      expect(Object.isFrozen(module)).toBe(true);
      expect(Object.keys(module).sort()).toEqual(['family', 'loadInventory']);
    }
  });

  test('keeps the host adapter lazy through provider-authoritative discovery', async () => {
    expect(hostAdapter.evaluations).toBe(0);
    const scope = {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    } as const;
    const providerGateways = createPlatformDeviceInventoryGateways({
      discover: async () => ({
        kind: 'inventory',
        devices: [
          {
            platform: 'web',
            id: 'provider-web',
            name: 'Provider Web',
            kind: 'device',
            target: 'desktop',
            booted: true,
          },
        ],
      }),
    });
    expect(await providerGateways.providerFirst.discover({ platform: 'web' }, scope)).toHaveLength(
      1,
    );
    expect(hostAdapter.evaluations).toBe(0);

    const localGateways = createPlatformDeviceInventoryGateways();
    expect(await localGateways.localOnly.discover({ platform: 'web' }, scope)).toHaveLength(1);
    expect(hostAdapter.evaluations).toBe(0);

    await expect(
      localGateways.localOnly.discover({ platform: 'android' }, scope),
    ).rejects.toMatchObject({ code: 'TOOL_MISSING' });
    expect(hostAdapter.evaluations).toBe(1);
  });
});
