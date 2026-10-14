import {
  type DeviceInventorySource,
  type InventoryPlatformModule,
  createPlatformModuleRegistry,
} from '@agent-device/contracts/platform-module';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { testInventoryHost } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { resolveTargetDeviceSelection } from '@agent-device/device-selection/dispatch-resolve';
import { withDeviceInventoryContext } from '@agent-device/device-selection/device-inventory-context';
import { PLATFORMS, type DeviceInfo } from '@agent-device/kernel/device';
import { describe, expect, test, vi } from 'vitest';
import { attachAppleInstalledAppProbe } from './platform-runtime-device-inventory.ts';

const simctl = vi.hoisted(() => ({
  listapps: [] as Array<{ deviceId: string; apps: Record<string, unknown> }>,
  calls: [] as string[],
}));

vi.mock('../packages/platform-apple/src/core/tool-provider.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/tool-provider')>()),
  runXcrun: async (args: string[]) => {
    const idx = args.indexOf('listapps');
    const deviceId = idx >= 0 ? args[idx + 1] : undefined;
    if (deviceId) simctl.calls.push(deviceId);
    const entry = simctl.listapps.find((l) => l.deviceId === deviceId);
    return { stdout: entry ? JSON.stringify(entry.apps) : '{}', stderr: '', exitCode: 0 };
  },
  runAppleToolCommand: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
}));

const scope: PlatformRequestScope = Object.freeze({
  signal: new AbortController().signal,
  diagnostics: Object.freeze({ emit: () => {} }),
  progress: Object.freeze({ report: () => {} }),
});

function simulator(id: string): DeviceInfo {
  return {
    platform: 'apple',
    id,
    name: id,
    kind: 'simulator',
    appleOs: 'ios',
    target: 'mobile',
    booted: true,
  };
}

function source(devices: readonly DeviceInfo[]): DeviceInventorySource {
  return { discover: async () => devices };
}

describe('production device inventory composition', () => {
  test('narrows app-based simulator selection through the factory-installed probe', async () => {
    // Guards the production wiring: the package-level composer only knows the injected
    // probe, so only this path proves the root factory attaches the Apple one to the
    // request context.
    simctl.listapps = [
      {
        deviceId: 'sim-b',
        apps: { 'com.example.demo': { Bundle: 'com.example.demo', CFBundleName: 'Demo' } },
      },
    ];
    const modules: InventoryPlatformModule[] = PLATFORMS.map((family) => ({
      family,
      loadInventory: async () =>
        source(family === 'apple' ? [simulator('sim-a'), simulator('sim-b')] : []),
    }));
    const gateways = await attachAppleInstalledAppProbe({
      registry: createPlatformModuleRegistry(modules),
      loadHost: async () => testInventoryHost,
    });

    const selection = await withDeviceInventoryContext({ ...gateways, requestScope: scope }, () =>
      resolveTargetDeviceSelection(
        { platform: 'ios' },
        {
          appleSimulatorAppTarget: 'com.example.demo',
        },
      ),
    );

    expect(selection.device.id).toBe('sim-b');
    expect(selection.reason).toBe('single-app-installed-local');
    expect(selection.source).toBe('local');
    expect(selection.candidateCount).toBe(1);
    expect([...simctl.calls].sort()).toEqual(['sim-a', 'sim-b']);
  });
});
