import { expect, test, vi } from 'vitest';
import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createLinuxPlatformRuntime } from './runtime.ts';

type LegacyLifecycleCell = Readonly<{
  openTarget: boolean;
  prepareAppleRunner: boolean;
  closeTarget: boolean;
  runtimeHints: boolean;
  portReverse: boolean;
}>;

test.each([
  {
    name: 'desktop device',
    device: {
      platform: 'linux' as const,
      id: 'linux',
      name: 'Linux',
      kind: 'device' as const,
      target: 'desktop' as const,
      booted: true,
    },
    // Legacy open/close descriptor cell: linux.device. Runtime and prepare had no dispatch cell.
    legacy: {
      openTarget: true,
      prepareAppleRunner: false,
      closeTarget: true,
      runtimeHints: false,
      portReverse: false,
    },
  },
  {
    name: 'synthetic emulator',
    device: {
      platform: 'linux' as const,
      id: 'linux-emulator',
      name: 'Linux emulator',
      kind: 'emulator' as const,
      target: 'desktop' as const,
      booted: true,
    },
    legacy: {
      openTarget: false,
      prepareAppleRunner: false,
      closeTarget: false,
      runtimeHints: false,
      portReverse: false,
    },
  },
  {
    name: 'synthetic simulator',
    device: {
      platform: 'linux' as const,
      id: 'linux-simulator',
      name: 'Linux simulator',
      kind: 'simulator' as const,
      target: 'desktop' as const,
      booted: true,
    },
    legacy: {
      openTarget: false,
      prepareAppleRunner: false,
      closeTarget: false,
      runtimeHints: false,
      portReverse: false,
    },
  },
] satisfies ReadonlyArray<
  Readonly<{ name: string; device: DeviceInfo; legacy: LegacyLifecycleCell }>
>)(
  'classifies the Linux $name lifecycle denominator against the legacy dispatch cell',
  async ({ device, legacy }) => {
    const captureSurface = vi.fn(async () => ({
      backend: 'linux-atspi' as const,
      nodes: [],
      truncated: false,
    }));
    const binding = await createLinuxPlatformRuntime(lifecycleHost(captureSurface)).bind({
      device,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });
    expect(binding.facts.operations.networkDump).toMatchObject({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.facts.operations.ensureReady).toMatchObject({ available: false });
    expect(binding.facts.operations.bootTarget).toMatchObject({ available: false });
    expect(binding.facts.operations.bootTargetHeadless).toMatchObject({ available: false });
    expect(binding.facts.operations.appState).toMatchObject({ available: false });
    expect(binding.facts.operations.listApps).toMatchObject({ available: false });
    expect(binding.facts.operations.captureSnapshot.available).toBe(device.kind === 'device');
    expect(binding.facts.operations.captureSnapshotWithCustomActions.available).toBe(false);
    expect(binding.facts.operations.captureSnapshotWithoutActiveApp.available).toBe(
      device.kind === 'device',
    );
    expect(binding.facts.operations.setViewport).toMatchObject({ available: false });
    expect(binding.operations.setViewport).toBeUndefined();
    expect(binding.operations.captureSnapshot).toBeTypeOf(
      device.kind === 'device' ? 'function' : 'undefined',
    );
    if (device.kind === 'device') {
      await binding.operations.captureSnapshot?.({
        options: { interactiveOnly: true, depth: 2, scope: 'Settings', surface: 'desktop' },
      });
      expect(captureSurface).toHaveBeenCalledWith(
        device,
        { interactiveOnly: true, depth: 2, scope: 'Settings', surface: 'desktop' },
        expect.any(AbortSignal),
      );
    }
    expectLifecycleFacts(binding, legacy);
  },
);

function lifecycleHost(
  captureSurface = async () => ({
    backend: 'linux-atspi' as const,
    nodes: [],
    truncated: false,
  }),
): PlatformRuntimeHost {
  return {
    localInteractors: { resolve: async () => ({}) },
    snapshot: { captureSurface },
  } as unknown as PlatformRuntimeHost;
}

function expectLifecycleFacts(
  binding: DeviceBinding<PlatformRuntimeOperations>,
  legacy: LegacyLifecycleCell,
): void {
  const operations = [
    ['openTarget', ['resolveOpenTarget', 'prepareApplicationOpen', 'openApplication']],
    ['prepareAppleRunner', ['prepareAppleRunner']],
    ['closeTarget', ['closeApplication', 'finalizeApplicationClose']],
    ['runtimeHints', ['applyRuntimeHints', 'clearRuntimeHints']],
    ['portReverse', ['configureProviderPortReverse']],
  ] as const;
  for (const [facet, names] of operations) {
    for (const name of names) {
      expect(binding.facts.operations[name].available).toBe(legacy[facet]);
      if (legacy[facet]) expect(binding.operations[name]).toBeTypeOf('function');
      else expect(binding.operations[name]).toBeUndefined();
    }
  }
}
