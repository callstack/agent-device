import { beforeEach, expect, test, vi } from 'vitest';
import type { HostDiagnosticsContext } from '@agent-device/contracts/host-diagnostics';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '@agent-device/test-kit';
import { createHostDiagnostics } from './platform-runtime-host-diagnostics.ts';

const { mockAppleRunnerWarmupCheck } = vi.hoisted(() => ({
  mockAppleRunnerWarmupCheck: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/doctor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/doctor')>()),
  appleRunnerWarmupCheck: mockAppleRunnerWarmupCheck,
}));

const context: HostDiagnosticsContext = Object.freeze({
  stateDir: '/tmp/state',
  metroPort: 8081,
  shouldProbeMetro: false,
  isProviderDevice: () => false,
  emitProgress: vi.fn(),
  listLocalDeviceInventory: async () => [],
  shouldPropagateInventoryProbeError: () => false,
  transportOverrides: Object.freeze({}),
});

beforeEach(() => {
  mockAppleRunnerWarmupCheck.mockReset();
});

test('warmup hands an Apple device to the Apple runner warmup and returns its check', async () => {
  const check = {
    id: 'ios-runner-cache',
    status: 'pass',
    summary: 'iOS runner build started in the background',
  };
  mockAppleRunnerWarmupCheck.mockResolvedValue(check);

  const result = await createHostDiagnostics(process.env).warmupCheck(IOS_SIMULATOR, context);

  expect(result).toEqual(check);
  expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledWith(IOS_SIMULATOR, context);
});

test('warmup runs no probe for a non-Apple device', async () => {
  expect(
    await createHostDiagnostics(process.env).warmupCheck(ANDROID_EMULATOR, context),
  ).toBeUndefined();
  expect(mockAppleRunnerWarmupCheck).not.toHaveBeenCalled();
});
