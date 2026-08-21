import { expect, test, vi } from 'vitest';
import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  SnapshotRuntimeHost,
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
    // The Linux read is value-first where the captured tree is label-first, so the desktop row
    // genuinely reads differently from its snapshot text and advertises the live read.
    expect(binding.facts.operations.readTextAtPoint.available).toBe(device.kind === 'device');
    expect(binding.facts.operations.captureSnapshotWithCustomActions.available).toBe(false);
    expect(binding.facts.operations.captureSnapshotWithoutActiveApp.available).toBe(
      device.kind === 'device',
    );
    expect(binding.facts.operations.setViewport).toMatchObject({ available: false });
    expect(binding.operations.setViewport).toBeUndefined();
    // R40/R41: the desktop is the only Linux cell with a pointer and keyboard to drive.
    expect(binding.facts.operations.focusPoint.available).toBe(device.kind === 'device');
    expect(binding.facts.operations.typeText.available).toBe(device.kind === 'device');
    expect(binding.operations.focusPoint).toBeTypeOf(
      device.kind === 'device' ? 'function' : 'undefined',
    );
    expect(binding.operations.typeText).toBeTypeOf(
      device.kind === 'device' ? 'function' : 'undefined',
    );
    expect(binding.facts.operations.captureScreenshot.available).toBe(device.kind === 'device');
    expect(binding.operations.captureScreenshot).toBeTypeOf(
      device.kind === 'device' ? 'function' : 'undefined',
    );
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
  captureSurface: SnapshotRuntimeHost['captureSurface'] = async () => ({
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

// `linuxSnapshotOperations` is the other direct `captureSurface` caller, so the shared
// `bindSnapshotInteractor` composition does not cover it either. Note it composes against
// `request.scope.signal` rather than `request.signal` — the Linux owner takes its signal off the
// request scope, which is exactly the detail a patch application can get wrong silently.
test('the Linux surface capture composes the per-capture signal with the request scope signal', async () => {
  const captureSurface = vi.fn<SnapshotRuntimeHost['captureSurface']>(async () => ({
    backend: 'linux-atspi' as const,
    nodes: [],
    truncated: false,
  }));
  const scope = new AbortController();
  const binding = await createLinuxPlatformRuntime(lifecycleHost(captureSurface)).bind({
    device: {
      platform: 'linux' as const,
      id: 'linux',
      name: 'Linux',
      kind: 'device' as const,
      target: 'desktop' as const,
      booted: true,
    },
    intent: { kind: 'ordinary' },
    scope: {
      signal: scope.signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  const poll = new AbortController();
  await binding.operations.captureSnapshot?.({ options: {}, signal: poll.signal });

  const passed = captureSurface.mock.calls[0]?.[2] as AbortSignal;
  expect(passed.aborted).toBe(false);
  poll.abort(new DOMException('Wait deadline exceeded', 'TimeoutError'));
  expect(passed.aborted).toBe(true);

  // The scope signal must still cancel too: composition adds a way to cancel, never replaces one.
  const second = new AbortController();
  await binding.operations.captureSnapshot?.({ options: {}, signal: second.signal });
  const passedSecond = captureSurface.mock.calls[1]?.[2] as AbortSignal;
  scope.abort();
  expect(passedSecond.aborted).toBe(true);
});
