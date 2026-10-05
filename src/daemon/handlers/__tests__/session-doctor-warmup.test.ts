import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isActiveProviderDevice } from '../../provider-device-admission.ts';
import { handleDoctorCommand } from '../session-doctor.ts';
import { createHostDiagnostics } from '../../../platform-runtime-host-diagnostics.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { withTestDeviceInventory } from '../../../__tests__/test-utils/device-inventory-gateways.ts';
import type { DaemonResponse } from '../../daemon-request.ts';

const { mockAppleRunnerWarmupCheck } = vi.hoisted(() => ({
  mockAppleRunnerWarmupCheck: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/doctor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/doctor')>()),
  appleRunnerWarmupCheck: mockAppleRunnerWarmupCheck,
}));
vi.mock('../session-doctor-app.ts', () => ({
  appendAppChecks: vi.fn(async () => {}),
}));
vi.mock('../session-doctor-metro.ts', () => ({
  probeMetro: vi.fn(async () => ({ id: 'metro', status: 'pass', summary: 'mocked' })),
}));
vi.mock('../../provider-device-admission.ts', () => ({
  isActiveProviderDevice: vi.fn(() => false),
}));

const mockIsActiveProviderDevice = vi.mocked(isActiveProviderDevice);

async function withMockedPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'doctor-sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

beforeEach(() => {
  mockAppleRunnerWarmupCheck.mockReset();
  mockAppleRunnerWarmupCheck.mockResolvedValue(undefined);
  mockIsActiveProviderDevice.mockReset();
  mockIsActiveProviderDevice.mockReturnValue(false);
});

async function runDoctorWithSessionDevice(device: DeviceInfo): Promise<DaemonResponse | null> {
  const sessionStore = makeSessionStore('agent-device-doctor-warmup-');
  sessionStore.publish('doctor-session', {
    name: 'doctor-session',
    createdAt: Date.now(),
    device,
    actions: [],
  });
  return await withTestDeviceInventory(
    {},
    async () =>
      await handleDoctorCommand({
        req: {
          token: 't',
          session: 'doctor-session',
          command: 'doctor',
          positionals: [],
          flags: { session: 'doctor-session' },
        },
        sessionName: 'doctor-session',
        sessionStore,
        hostDiagnostics: createHostDiagnostics(),
      }),
  );
}

async function runSessionlessDoctor(
  source: 'host' | 'provider',
  flags: { targetApp?: string } = {},
): Promise<DaemonResponse | null> {
  const inventory =
    source === 'host'
      ? { local: async () => [IOS_SIMULATOR] }
      : {
          provider: {
            discover: async () => ({ kind: 'inventory' as const, devices: [IOS_SIMULATOR] }),
          },
        };
  return await withTestDeviceInventory(
    inventory,
    async () =>
      await handleDoctorCommand({
        req: { token: 't', session: 'default', command: 'doctor', positionals: [], flags },
        sessionName: 'default',
        sessionStore: makeSessionStore('agent-device-doctor-warmup-'),
        hostDiagnostics: createHostDiagnostics(),
      }),
  );
}

function readCheck(response: DaemonResponse | null, id: string): Record<string, unknown> | null {
  if (!response?.ok) return null;
  const checks = (response.data as { checks?: Array<Record<string, unknown>> }).checks ?? [];
  return checks.find((check) => check.id === id) ?? null;
}

test('doctor warms the iOS runner cache in the background when the artifact is missing', async () => {
  mockAppleRunnerWarmupCheck.mockResolvedValue({
    id: 'ios-runner-cache',
    status: 'pass',
    summary: 'iOS runner build started in the background',
  });
  const response = await withMockedPlatform('darwin', () =>
    runDoctorWithSessionDevice(IOS_SIMULATOR),
  );

  expect(response?.ok).toBe(true);
  expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledTimes(1);
  const check = readCheck(response, 'ios-runner-cache');
  expect(check?.status).toBe('pass');
  expect(String(check?.summary)).toMatch(/background/i);
});

test('doctor reports a cached iOS runner artifact without rebuilding', async () => {
  mockAppleRunnerWarmupCheck.mockResolvedValue({
    id: 'ios-runner-cache',
    status: 'pass',
    summary: 'iOS runner artifact cached',
  });

  const response = await withMockedPlatform('darwin', () =>
    runDoctorWithSessionDevice(IOS_SIMULATOR),
  );

  expect(response?.ok).toBe(true);
  expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledTimes(1);
  const check = readCheck(response, 'ios-runner-cache');
  expect(String(check?.summary)).toMatch(/cached/i);
});

test('doctor skips the runner warmup for non-simulator devices', async () => {
  const response = await withMockedPlatform('darwin', () =>
    runDoctorWithSessionDevice({
      ...IOS_SIMULATOR,
      id: 'doctor-device-1',
      kind: 'device',
    }),
  );

  expect(response?.ok).toBe(true);
  expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledTimes(1);
  expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'device' }),
    expect.any(Object),
  );
  expect(readCheck(response, 'ios-runner-cache')).toBeNull();
});

test('doctor skips the runner warmup on non-macOS hosts', async () => {
  const response = await withMockedPlatform('linux', () =>
    runDoctorWithSessionDevice(IOS_SIMULATOR),
  );

  expect(response?.ok).toBe(true);
  expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledTimes(1);
  expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledWith(IOS_SIMULATOR, expect.any(Object));
  expect(readCheck(response, 'ios-runner-cache')).toBeNull();
});

test('doctor skips the runner warmup for provider-backed devices', async () => {
  mockIsActiveProviderDevice.mockReturnValue(true);

  const response = await withMockedPlatform('darwin', () =>
    runDoctorWithSessionDevice(IOS_SIMULATOR),
  );

  expect(response?.ok).toBe(true);
  expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledTimes(1);
  expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledWith(IOS_SIMULATOR, expect.any(Object));
  expect(readCheck(response, 'ios-runner-cache')).toBeNull();
});

const SESSIONLESS_WARMUP_CANDIDATES = [
  { name: 'an inventory simulator', flags: {} },
  { name: 'the --app device', flags: { targetApp: 'com.example.demo' } },
];

test.each(SESSIONLESS_WARMUP_CANDIDATES)(
  'doctor warms the runner cache for $name this host discovered',
  async ({ flags }) => {
    const response = await runSessionlessDoctor('host', flags);

    expect(response?.ok).toBe(true);
    expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledTimes(1);
    expect(mockAppleRunnerWarmupCheck).toHaveBeenCalledWith(
      expect.objectContaining({ id: IOS_SIMULATOR.id }),
      expect.any(Object),
    );
  },
);

test.each(SESSIONLESS_WARMUP_CANDIDATES)(
  'doctor starts no runner warmup for $name a provider reported',
  async ({ flags }) => {
    const response = await runSessionlessDoctor('provider', flags);

    expect(response?.ok).toBe(true);
    expect(mockAppleRunnerWarmupCheck).not.toHaveBeenCalled();
  },
);
