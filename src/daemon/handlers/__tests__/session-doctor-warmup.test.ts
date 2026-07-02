import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '../../../kernel/device.ts';
import {
  hasCachedAppleRunnerArtifact,
  prewarmAppleRunnerCache,
} from '../../../platforms/apple/core/runner/runner-client.ts';
import { isActiveProviderDevice } from '../../../provider-device-runtime.ts';
import { handleDoctorCommand } from '../session-doctor.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { DaemonResponse } from '../../types.ts';

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', () => ({
  hasCachedAppleRunnerArtifact: vi.fn(async () => false),
  prewarmAppleRunnerCache: vi.fn(),
}));
vi.mock('../session-doctor-device.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-doctor-device.ts')>();
  return {
    ...actual,
    appendDeviceInventoryCheck: vi.fn(async () => undefined),
    resolveDoctorDeviceForAppCheck: vi.fn(() => undefined),
  };
});
vi.mock('../session-doctor-toolchain.ts', () => ({
  appendToolchainChecks: vi.fn(async () => {}),
}));
vi.mock('../session-doctor-app.ts', () => ({
  appendAppChecks: vi.fn(async () => {}),
}));
vi.mock('../session-doctor-android.ts', () => ({
  appendAndroidChecks: vi.fn(async () => {}),
}));
vi.mock('../session-doctor-metro.ts', () => ({
  probeMetro: vi.fn(async () => ({ id: 'metro', status: 'pass', summary: 'mocked' })),
}));
vi.mock('../../../provider-device-runtime.ts', () => ({
  isActiveProviderDevice: vi.fn(() => false),
}));

const mockHasCachedArtifact = vi.mocked(hasCachedAppleRunnerArtifact);
const mockPrewarmCache = vi.mocked(prewarmAppleRunnerCache);
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
  mockHasCachedArtifact.mockReset();
  mockHasCachedArtifact.mockResolvedValue(false);
  mockPrewarmCache.mockReset();
  mockIsActiveProviderDevice.mockReset();
  mockIsActiveProviderDevice.mockReturnValue(false);
});

async function runDoctorWithSessionDevice(device: DeviceInfo): Promise<DaemonResponse | null> {
  const sessionStore = makeSessionStore('agent-device-doctor-warmup-');
  sessionStore.set('doctor-session', {
    name: 'doctor-session',
    createdAt: Date.now(),
    device,
    actions: [],
  });
  return await handleDoctorCommand({
    req: {
      token: 't',
      session: 'doctor-session',
      command: 'doctor',
      positionals: [],
      flags: { session: 'doctor-session' },
    },
    sessionName: 'doctor-session',
    sessionStore,
  });
}

function readCheck(response: DaemonResponse | null, id: string): Record<string, unknown> | null {
  if (!response?.ok) return null;
  const checks = (response.data as { checks?: Array<Record<string, unknown>> }).checks ?? [];
  return checks.find((check) => check.id === id) ?? null;
}

test('doctor warms the iOS runner cache in the background when the artifact is missing', async () => {
  const response = await withMockedPlatform('darwin', () =>
    runDoctorWithSessionDevice(IOS_SIMULATOR),
  );

  expect(response?.ok).toBe(true);
  expect(mockPrewarmCache).toHaveBeenCalledTimes(1);
  const check = readCheck(response, 'ios-runner-cache');
  expect(check?.status).toBe('pass');
  expect(String(check?.summary)).toMatch(/background/i);
});

test('doctor reports a cached iOS runner artifact without rebuilding', async () => {
  mockHasCachedArtifact.mockResolvedValue(true);

  const response = await withMockedPlatform('darwin', () =>
    runDoctorWithSessionDevice(IOS_SIMULATOR),
  );

  expect(response?.ok).toBe(true);
  expect(mockPrewarmCache).not.toHaveBeenCalled();
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
  expect(mockPrewarmCache).not.toHaveBeenCalled();
  expect(readCheck(response, 'ios-runner-cache')).toBeNull();
});

test('doctor skips the runner warmup on non-macOS hosts', async () => {
  const response = await withMockedPlatform('linux', () =>
    runDoctorWithSessionDevice(IOS_SIMULATOR),
  );

  expect(response?.ok).toBe(true);
  expect(mockPrewarmCache).not.toHaveBeenCalled();
  expect(readCheck(response, 'ios-runner-cache')).toBeNull();
});

test('doctor skips the runner warmup for provider-backed devices', async () => {
  mockIsActiveProviderDevice.mockReturnValue(true);

  const response = await withMockedPlatform('darwin', () =>
    runDoctorWithSessionDevice(IOS_SIMULATOR),
  );

  expect(response?.ok).toBe(true);
  expect(mockPrewarmCache).not.toHaveBeenCalled();
  expect(readCheck(response, 'ios-runner-cache')).toBeNull();
});
