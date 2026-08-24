import { vi } from 'vitest';

const dispatchMocks = vi.hoisted(() => ({
  resolveTargetDevice: vi.fn(),
  resolveTargetDeviceSelection: vi.fn(async (...args: unknown[]) => {
    const device = await dispatchMocks.resolveTargetDevice(...args);
    return {
      device,
      reason: 'explicit-selector',
      source: 'local',
      candidateCount: 1,
      booted: device?.booted === true,
      bootOccurred: false,
    };
  }),
}));

vi.mock('../../core/dispatch-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch-resolve.ts')>();
  return {
    ...actual,
    resolveTargetDevice: dispatchMocks.resolveTargetDevice,
    resolveTargetDeviceSelection: dispatchMocks.resolveTargetDeviceSelection,
  };
});

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
    resolveTargetDevice: dispatchMocks.resolveTargetDevice,
    resolveTargetDeviceSelection: dispatchMocks.resolveTargetDeviceSelection,
  };
});

export function getResolveTargetDeviceMock(): typeof dispatchMocks.resolveTargetDevice {
  return dispatchMocks.resolveTargetDevice;
}
