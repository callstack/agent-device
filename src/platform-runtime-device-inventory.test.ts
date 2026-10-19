import {
  type DeviceInventorySource,
  type InventoryPlatformModule,
  createPlatformModuleRegistry,
} from '@agent-device/contracts/platform-module';
import {
  testInventoryHost,
  testRequestScope,
} from '@agent-device/device-selection/inventory-gateways-fixtures';
import { resolveTargetDeviceSelection } from '@agent-device/device-selection/dispatch-resolve';
import { withDeviceInventoryContext } from '@agent-device/device-selection/device-inventory-context';
import { PLATFORMS, type DeviceInfo } from '@agent-device/kernel/device';
import { describe, expect, test, vi } from 'vitest';
import { attachAppleInstalledAppProbe } from './platform-runtime-device-inventory.ts';

const simctl = vi.hoisted(() => ({
  listapps: [] as Array<{ deviceId: string; apps: Record<string, unknown> }>,
  calls: [] as string[],
}));

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

    // The fake answers through the production tool-provider scope — the same seam the
    // package's own tests install with — so no module mock has to guess which loader
    // identity the probe's dynamic import will land on.
    const { withAppleToolProvider, createLocalAppleToolProvider } =
      await import('@agent-device/platform-apple/tool-provider');
    const selection = await withAppleToolProvider(
      createLocalAppleToolProvider({
        runCommand: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
        simctl: {
          run: async (args) => {
            const [command, deviceId] = args as readonly string[];
            if (command !== 'listapps') return { stdout: '{}', stderr: '', exitCode: 0 };
            simctl.calls.push(deviceId!);
            const entry = simctl.listapps.find((l) => l.deviceId === deviceId);
            return { stdout: entry ? JSON.stringify(entry.apps) : '{}', stderr: '', exitCode: 0 };
          },
        },
        devicectl: { run: async () => ({ stdout: '', stderr: '', exitCode: 1 }) },
      }),
      () =>
        withDeviceInventoryContext({ ...gateways, requestScope: testRequestScope }, () =>
          resolveTargetDeviceSelection(
            { platform: 'ios' },
            { env: process.env, appleSimulatorAppTarget: 'com.example.demo' },
          ),
        ),
    );

    expect(selection.device.id).toBe('sim-b');
    expect(selection.reason).toBe('single-app-installed-local');
    expect(selection.source).toBe('local');
    expect(selection.candidateCount).toBe(1);
    expect([...simctl.calls].sort()).toEqual(['sim-a', 'sim-b']);
  });
});
