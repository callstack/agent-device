import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { expect, test } from 'vitest';
import type { SessionState } from '../../../core/session-state.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import {
  ANDROID_EMULATOR,
  IOS_DEVICE,
  IOS_SIMULATOR,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockUninstallAppRuntime,
} from '../../../__tests__/support/handlers/session-command-harness.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';

async function uninstall(device: SessionState['device'], app: string) {
  const sessionStore = makeSessionStore('agent-device-session-uninstall-');
  sessionStore.publish('default', { name: 'default', createdAt: Date.now(), actions: [], device });
  return await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture({
      appleSessionObservation: {
        observeRunnerSession: async (deviceId) => ({ alive: true, sessionId: `${deviceId}:1` }),
        resolveSoleForegroundApp: async () => undefined,
      },
    }),
    req: { token: 't', session: 'default', command: 'uninstall', positionals: [app], flags: {} },
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore,
    invoke: async () => {
      throw new Error('uninstall must stay on the runtime route');
    },
  });
}

test.each([
  [
    'an Android removal',
    ANDROID_EMULATOR,
    { wasInstalled: true, packageName: 'com.example.app' },
    {
      platform: 'android',
      wasInstalled: true,
      appId: 'com.example.app',
      message: 'Uninstalled: com.example.app',
    },
  ],
  [
    'an Android no-op',
    ANDROID_EMULATOR,
    { wasInstalled: false },
    { platform: 'android', wasInstalled: false, message: 'Not installed: com.example.app' },
  ],
  [
    'an iOS simulator removal',
    IOS_SIMULATOR,
    { wasInstalled: true, bundleId: 'com.example.app' },
    {
      platform: 'ios',
      wasInstalled: true,
      appId: 'com.example.app',
      message: 'Uninstalled: com.example.app',
    },
  ],
  [
    'a CoreDevice removal',
    IOS_DEVICE,
    { wasInstalled: true, bundleId: 'com.example.app' },
    {
      platform: 'ios',
      wasInstalled: true,
      appId: 'com.example.app',
      message: 'Uninstalled: com.example.app',
    },
  ],
] as const)(
  'uninstall reports %s through one admitted binding',
  async (_name, device, removed, expected) => {
    mockUninstallAppRuntime.mockResolvedValueOnce(removed);

    await expect(uninstall(device, 'com.example.app')).resolves.toEqual({
      ok: true,
      data: { app: 'com.example.app', ...expected },
    });
    expect(mockUninstallAppRuntime).toHaveBeenCalledWith({ app: 'com.example.app' });
    expect(mockBindDeviceRuntime.mock.calls[0]?.[1]).toMatchObject({ required: ['uninstallApp'] });
  },
);

test('uninstall is refused before binding where the runtime fact closes it', async () => {
  const harmony = {
    platform: 'harmonyos',
    id: 'hdc-1',
    name: 'Harmony',
    kind: 'device',
    booted: true,
  } as const;

  await expect(uninstall(harmony, 'com.example.app')).resolves.toMatchObject({
    ok: false,
    error: { code: 'UNSUPPORTED_OPERATION', details: { reason: 'owner-capability-missing' } },
  });
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(mockUninstallAppRuntime).not.toHaveBeenCalled();
});
