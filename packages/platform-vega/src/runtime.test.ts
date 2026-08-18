import { expect, test } from 'vitest';
import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createVegaPlatformRuntime } from './runtime.ts';

type LegacyLifecycleCell = Readonly<{
  openTarget: boolean;
  prepareAppleRunner: boolean;
  closeTarget: boolean;
  runtimeHints: boolean;
  portReverse: boolean;
}>;

test.each([
  {
    name: 'Vega Virtual Device TV',
    device: {
      platform: 'vega' as const,
      id: 'vega-vvd',
      name: 'Vega VVD',
      kind: 'emulator' as const,
      target: 'tv' as const,
      booted: true,
    },
    // Legacy open/close descriptor bucket plus the Vega dispatch target gate.
    legacy: {
      openTarget: true,
      prepareAppleRunner: false,
      closeTarget: true,
      runtimeHints: false,
      portReverse: false,
    },
  },
  {
    name: 'physical Vega TV',
    device: {
      platform: 'vega' as const,
      id: 'vega-device',
      name: 'Vega device',
      kind: 'device' as const,
      target: 'tv' as const,
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
    name: 'Vega emulator mobile target',
    device: {
      platform: 'vega' as const,
      id: 'vega-mobile',
      name: 'Vega mobile',
      kind: 'emulator' as const,
      target: 'mobile' as const,
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
    name: 'Vega emulator desktop target',
    device: {
      platform: 'vega' as const,
      id: 'vega-desktop',
      name: 'Vega desktop',
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
    name: 'synthetic Vega simulator TV',
    device: {
      platform: 'vega' as const,
      id: 'vega-simulator',
      name: 'Vega simulator',
      kind: 'simulator' as const,
      target: 'tv' as const,
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
  'classifies the $name lifecycle denominator against the legacy dispatch cell',
  async ({ device, legacy }) => {
    const binding = await createVegaPlatformRuntime(lifecycleHost()).bind({
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
    expect(binding.facts.operations.captureSnapshot).toMatchObject({
      available: false,
      reason: 'unsupported-platform-leaf',
    });
    expect(binding.operations.captureSnapshot).toBeUndefined();
    expect(binding.facts.operations.setViewport).toMatchObject({ available: false });
    expect(binding.operations.setViewport).toBeUndefined();
    expectLifecycleFacts(binding, legacy);
  },
);

function lifecycleHost(): PlatformRuntimeHost {
  return {
    localInteractors: { resolve: async () => ({}) },
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
