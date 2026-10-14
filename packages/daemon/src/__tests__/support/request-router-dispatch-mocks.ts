import { vi, type Mock } from 'vitest';

// The explicit Mock annotation is what lets the daemon package's composite project emit
// this fixture's declaration; the inferred vi.fn() type names @vitest/spy internals that
// are not importable from the emitted .d.ts (TS2883) — the capture-kit fixtures' pattern.
const dispatchMocks = vi.hoisted(() => ({
  resolveTargetDevice: vi.fn() as Mock,
}));

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const { selectionFromResolveTargetDevice } = await import('./device-selection-stub.ts');
  return {
    ...actual,
    resolveTargetDevice: dispatchMocks.resolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(
      selectionFromResolveTargetDevice(dispatchMocks.resolveTargetDevice),
    ),
  };
});

export function getResolveTargetDeviceMock(): typeof dispatchMocks.resolveTargetDevice {
  return dispatchMocks.resolveTargetDevice;
}
