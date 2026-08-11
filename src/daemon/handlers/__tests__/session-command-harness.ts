import {
  handleSessionCommands as handleProductionSessionCommands,
  type SessionCommandInput,
} from '../session.ts';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type EnsureReadyInput,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
} from '@agent-device/contracts/platform';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { beforeEach, vi } from 'vitest';

const unavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
} as const);
const available = Object.freeze({ available: true } as const);

export const mockInspectDeviceRuntimeFacts = vi.fn(async (device: DeviceInfo) =>
  readinessFacts(device),
);
export const mockEnsureReadyRuntime = vi.fn(
  async (_input: EnsureReadyInput): Promise<DeviceInfo | undefined> => undefined,
);
export const mockEnsureReadyHeadlessRuntime = vi.fn(
  async (_input: EnsureReadyInput): Promise<DeviceInfo | undefined> => undefined,
);
export const mockBindDeviceRuntime = vi.fn(async (device: DeviceInfo, use) =>
  narrowDeviceBinding(readinessBinding(device), use),
);

beforeEach(() => {
  mockInspectDeviceRuntimeFacts.mockClear();
  mockEnsureReadyRuntime.mockClear();
  mockEnsureReadyHeadlessRuntime.mockClear();
  mockBindDeviceRuntime.mockClear();
});

/** Unit-handler default is explicitly fail-closed; production must inject exact-owner recovery. */
export function handleSessionCommands(
  params: Omit<SessionCommandInput, 'reconcileOrphanedDeviceClaim'>,
): ReturnType<typeof handleProductionSessionCommands> {
  return handleProductionSessionCommands({
    ...params,
    inspectFacts: params.inspectFacts ?? mockInspectDeviceRuntimeFacts,
    bindDevice: params.bindDevice ?? mockBindDeviceRuntime,
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained',
      reason: 'test-harness-has-no-exact-owner-recovery',
    }),
  });
}

function readinessFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  const normalAvailable =
    (device.platform === 'apple' && device.appleOs !== 'macos' && device.appleOs !== 'watchos') ||
    device.platform === 'android';
  const headlessAvailable = device.platform === 'android' && device.kind === 'emulator';
  return {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: device.appleOs === 'watchos' ? unavailable : available,
      bootTarget: normalAvailable ? available : unavailable,
      bootTargetHeadless: headlessAvailable ? available : unavailable,
      listApps: unavailable,
    },
  };
}

function readinessBinding(device: DeviceInfo): DeviceBinding<PlatformRuntimeOperations> {
  return {
    device,
    owner: localRuntimeOwner(device.platform),
    facts: readinessFacts(device),
    operations: {
      ensureReady: async (input) =>
        (await mockEnsureReadyRuntime(input)) ?? { ...device, booted: true },
      ...(readinessFacts(device).operations.bootTarget.available
        ? {
            bootTarget: async (input) =>
              (await mockEnsureReadyRuntime(input)) ?? { ...device, booted: true },
          }
        : {}),
      listApps: async () => [],
      ...(device.platform === 'android' && device.kind === 'emulator'
        ? {
            bootTargetHeadless: async (input) =>
              (await mockEnsureReadyHeadlessRuntime(input)) ?? { ...device, booted: true },
          }
        : {}),
    },
    [Symbol.asyncDispose]: async () => {},
  };
}
