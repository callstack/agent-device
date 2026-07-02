import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { prewarmAppleRunnerCache } from '../../../platforms/apple/core/runner/runner-client.ts';
import { resolveCommandDevice } from '../session-device-utils.ts';
import { ensureDeviceReady } from '../../device-ready.ts';
import { handleSessionStateCommands } from '../session-state.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, prewarmAppleRunnerCache: vi.fn() };
});
vi.mock('../session-device-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-device-utils.ts')>();
  return { ...actual, resolveCommandDevice: vi.fn() };
});
vi.mock('../../device-ready.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../device-ready.ts')>();
  return { ...actual, ensureDeviceReady: vi.fn(async () => {}) };
});

const mockPrewarmCache = vi.mocked(prewarmAppleRunnerCache);
const mockResolveCommandDevice = vi.mocked(resolveCommandDevice);
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);

const BOOTED_IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'boot-sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

beforeEach(() => {
  mockPrewarmCache.mockReset();
  mockResolveCommandDevice.mockReset();
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
});

async function runBoot(device: DeviceInfo) {
  mockResolveCommandDevice.mockResolvedValue(device);
  return await handleSessionStateCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'boot',
      positionals: [],
      flags: { platform: 'ios', udid: device.id },
    },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: makeSessionStore('agent-device-boot-warmup-'),
  });
}

test('boot warms the iOS runner cache for an already-booted simulator', async () => {
  const response = await runBoot(BOOTED_IOS_SIMULATOR);

  expect(response?.ok).toBe(true);
  expect(mockPrewarmCache).toHaveBeenCalledTimes(1);
  expect(mockPrewarmCache.mock.calls[0]?.[0]).toMatchObject({ id: 'boot-sim-1' });
});

test('boot does not warm the runner cache for real iOS devices', async () => {
  const response = await runBoot({
    ...BOOTED_IOS_SIMULATOR,
    id: 'boot-device-1',
    kind: 'device',
  });

  expect(response?.ok).toBe(true);
  expect(mockPrewarmCache).not.toHaveBeenCalled();
});
