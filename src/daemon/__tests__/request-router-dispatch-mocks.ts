import { vi } from 'vitest';

const dispatchMocks = vi.hoisted(() => ({
  resolveTargetDevice: vi.fn(),
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
