import { vi } from 'vitest';
import type { TypeTextBackendResult } from '@agent-device/contracts/interaction';
import {
  createUnavailablePlatformRuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
  applicationLifecycleOperationFacts,
  type CaptureSnapshotInput,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type ElementTextReadOutcome,
  type FocusPointInput,
  type TypeTextInput,
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
 * `find <q> focus` shares the `focus` unit's bound operation (R40), so this fixture owns it too:
 * mutating find binds the same runtime the generic `focus` leaf does.
 */
export const mockFocusPoint = vi.fn(async (_input: FocusPointInput): Promise<void> => undefined);

/**
 * `type` and `find <q> type` share the `type` unit's bound operation (R41), exactly as focus
 * does: mutating handlers bind the same runtime the interaction route admits.
 */
export const mockTypeText = vi.fn(
  async (_input: TypeTextInput): Promise<TypeTextBackendResult | void> => undefined,
);

/**
 * Flip to model an exact owner cell: no live element read (web, HarmonyOS, provider), no capture
 * at all (the watchOS sentinel, an inactive provider), which refuses admission outright, or no
 * touch (a device kind whose family cannot drive a point focus).
 */
export const elementReadFixtureState = {
  readTextAtPointAvailable: true,
  captureSnapshotAvailable: true,
  focusPointAvailable: true,
  typeTextAvailable: true,
};

export function resetGetRuntimeFixture(): void {
  mockReadTextAtPoint.mockReset();
  mockReadTextAtPoint.mockResolvedValue(
    Object.freeze({ status: 'unreadable', reason: 'no-text-at-point' } as const),
  );
  mockFocusPoint.mockReset();
  mockFocusPoint.mockResolvedValue(undefined);
  mockTypeText.mockReset();
  mockTypeText.mockResolvedValue(undefined);
  (mockInspectElementReadFacts as unknown as ReturnType<typeof vi.fn>).mockClear();
  (mockBindElementReadRuntime as unknown as ReturnType<typeof vi.fn>).mockClear();
  elementReadFixtureState.readTextAtPointAvailable = true;
  elementReadFixtureState.captureSnapshotAvailable = true;
  elementReadFixtureState.focusPointAvailable = true;
  elementReadFixtureState.typeTextAvailable = true;
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
    focus: unavailable,
    typeText: unavailable,
    elementText: unavailable,
    screenshot: unavailable,
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
      focusPoint: elementReadFixtureState.focusPointAvailable ? available : unavailable,
      typeText: elementReadFixtureState.typeTextAvailable ? available : unavailable,
    },
  });
}

const mockInspectElementReadFacts: InspectDeviceRuntimeFacts = vi.fn(async (device: DeviceInfo) =>
  elementReadFacts(device),
);

const mockBindElementReadRuntime: BindDeviceRuntime = vi.fn(async (device: DeviceInfo, use) => {
  const facts = elementReadFacts(device);
  // Delegates to the interactor capture the surrounding suites already mock, so only the two
  // selector operations are fixture-owned here.
  const capture = async (input: CaptureSnapshotInput) =>
    await captureSnapshotWithInteractor({
      device,
      runnerContext: { ...input.execution, appBundleId: input.options?.appBundleId },
      options: { ...input.options },
    });
  const binding: DeviceBinding<PlatformRuntimeOperations> = Object.freeze({
    device,
    owner: localRuntimeOwner('apple'),
    facts,
    operations: Object.freeze({
      captureSnapshot: capture,
      // The selector plan takes this row on a session with no tracked app, so an owner that
      // advertises it must implement it or `narrowDeviceBinding` rejects the contract.
      captureSnapshotWithoutActiveApp: capture,
      ...(elementReadFixtureState.readTextAtPointAvailable
        ? { readTextAtPoint: mockReadTextAtPoint }
        : {}),
      ...(elementReadFixtureState.focusPointAvailable ? { focusPoint: mockFocusPoint } : {}),
      ...(elementReadFixtureState.typeTextAvailable ? { typeText: mockTypeText } : {}),
    }),
    [Symbol.asyncDispose]: async () => undefined,
  }) as DeviceBinding<PlatformRuntimeOperations>;
  return narrowDeviceBinding(binding, use);
}) as BindDeviceRuntime;

/**
 * Spread into a handler's params so a selector command can admit and bind. Consumed by `get` and
 * by read-only `find`, which share the bound element read.
 */
export function getRuntimeBindings(): Readonly<{
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
}> {
  return { inspectFacts: mockInspectElementReadFacts, bindDevice: mockBindElementReadRuntime };
}

/** The binding spies, exposed so handler tests can assert the ADR 0019 §9 one-bind invariant. */
export function runtimeBindingSpies(): Readonly<{
  inspectFacts: ReturnType<typeof vi.fn>;
  bindDevice: ReturnType<typeof vi.fn>;
}> {
  return {
    inspectFacts: mockInspectElementReadFacts as unknown as ReturnType<typeof vi.fn>,
    bindDevice: mockBindElementReadRuntime as unknown as ReturnType<typeof vi.fn>,
  };
}
