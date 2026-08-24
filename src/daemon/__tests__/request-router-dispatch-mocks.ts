import { vi } from 'vitest';

const dispatchMocks = vi.hoisted(() => ({
  resolveTargetDevice: vi.fn(),
}));

vi.mock('../../core/dispatch-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch-resolve.ts')>();
  const { selectionFromResolveTargetDevice } = await import('./device-selection-stub.ts');
  return {
    ...actual,
    resolveTargetDevice: dispatchMocks.resolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(
      selectionFromResolveTargetDevice(dispatchMocks.resolveTargetDevice),
    ),
  };
});

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
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
