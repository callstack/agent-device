import { vi } from 'vitest';
import {
  createUnavailablePlatformRuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
  applicationLifecycleOperationFacts,
  type CaptureSnapshotInput,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type ReadTextAtPointInput,
  type RuntimeFacts,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import { captureSnapshotWithInteractor } from '../snapshot-interactor-capture.ts';

/**
 * The request-bound runtime seam `get` consumes, faked at `inspectFacts` / `bindDevice` — never
 * at `core/dispatch.ts`. The bound capture still runs the interactor capture the surrounding
 * interaction tests already mock, so only the two `get` operations are fixture-owned here.
 */
export const mockReadTextAtPoint = vi.fn(async (_input: ReadTextAtPointInput) => '');

/** Flip to model an owner whose facts advertise no live element read (web, HarmonyOS, provider). */
export const elementReadFixtureState = { readTextAtPointAvailable: true };

export function resetGetRuntimeFixture(): void {
  mockReadTextAtPoint.mockReset();
  mockReadTextAtPoint.mockResolvedValue('');
  elementReadFixtureState.readTextAtPointAvailable = true;
}

const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
} as const);

function elementReadFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  const base = createUnavailablePlatformRuntimeFacts(device, localRuntimeOwner('apple'), {
    appLog: unavailable,
    network: unavailable,
    viewport: unavailable,
    elementText: unavailable,
    lifecycle: applicationLifecycleOperationFacts({
      resolveOpenTarget: unavailable,
      prepareApplicationOpen: unavailable,
      openApplication: unavailable,
      applyRuntimeHints: unavailable,
      clearRuntimeHints: unavailable,
      closeApplication: unavailable,
      finalizeApplicationClose: unavailable,
      prepareAppleRunner: unavailable,
      configureProviderPortReverse: unavailable,
    }),
  });
  return Object.freeze({
    device: base.device,
    operations: {
      ...base.operations,
      captureSnapshot: available,
      readTextAtPoint: elementReadFixtureState.readTextAtPointAvailable ? available : unavailable,
    },
  });
}

const mockInspectElementReadFacts: InspectDeviceRuntimeFacts = vi.fn(async (device: DeviceInfo) =>
  elementReadFacts(device),
);

const mockBindElementReadRuntime: BindDeviceRuntime = vi.fn(async (device: DeviceInfo, use) => {
  const facts = elementReadFacts(device);
  const binding: DeviceBinding<PlatformRuntimeOperations> = Object.freeze({
    device,
    owner: localRuntimeOwner('apple'),
    facts,
    operations: Object.freeze({
      captureSnapshot: async (input: CaptureSnapshotInput) =>
        await captureSnapshotWithInteractor({
          device,
          runnerContext: { ...input.execution, appBundleId: input.options?.appBundleId },
          options: { ...input.options },
        }),
      ...(elementReadFixtureState.readTextAtPointAvailable
        ? { readTextAtPoint: mockReadTextAtPoint }
        : {}),
    }),
    [Symbol.asyncDispose]: async () => undefined,
  }) as DeviceBinding<PlatformRuntimeOperations>;
  return narrowDeviceBinding(binding, use);
}) as BindDeviceRuntime;

/** Spread into any interaction-handler params so `get` can admit and bind. */
export function getRuntimeBindings(): Readonly<{
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
}> {
  return { inspectFacts: mockInspectElementReadFacts, bindDevice: mockBindElementReadRuntime };
}
