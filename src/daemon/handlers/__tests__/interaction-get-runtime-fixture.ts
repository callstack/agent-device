import { vi } from 'vitest';
import {
  createUnavailablePlatformRuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
  applicationLifecycleOperationFacts,
  type CaptureSnapshotInput,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type ElementTextReadOutcome,
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
export const mockReadTextAtPoint = vi.fn(
  async (_input: ReadTextAtPointInput): Promise<ElementTextReadOutcome> =>
    Object.freeze({ status: 'unreadable', reason: 'no-text-at-point' } as const),
);

/**
 * Flip to model an exact owner cell: no live element read (web, HarmonyOS, provider), or no
 * capture at all (the watchOS sentinel, an inactive provider), which refuses admission outright.
 */
export const elementReadFixtureState = {
  readTextAtPointAvailable: true,
  captureSnapshotAvailable: true,
};

export function resetGetRuntimeFixture(): void {
  mockReadTextAtPoint.mockReset();
  mockReadTextAtPoint.mockResolvedValue(
    Object.freeze({ status: 'unreadable', reason: 'no-text-at-point' } as const),
  );
  elementReadFixtureState.readTextAtPointAvailable = true;
  elementReadFixtureState.captureSnapshotAvailable = true;
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
      captureSnapshot: elementReadFixtureState.captureSnapshotAvailable ? available : unavailable,
      // The selector plan requires this row too on a session with no tracked app.
      captureSnapshotWithoutActiveApp: elementReadFixtureState.captureSnapshotAvailable
        ? available
        : unavailable,
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
