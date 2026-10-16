import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { expect, test } from 'vitest';
import type { SessionState } from '../../../core/session-state.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { ANDROID_EMULATOR } from '@agent-device/test-kit';
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
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
    { wasInstalled: true, packageName: 'com.example.app' },
    { wasInstalled: true, appId: 'com.example.app', message: 'Uninstalled: com.example.app' },
  ],
  [{ wasInstalled: false }, { wasInstalled: false, message: 'Not installed: com.example.app' }],
] as const)('uninstall reports %j through one admitted binding', async (removed, expected) => {
  mockUninstallAppRuntime.mockResolvedValueOnce(removed);

  await expect(uninstall(ANDROID_EMULATOR, 'com.example.app')).resolves.toEqual({
    ok: true,
    data: { platform: 'android', app: 'com.example.app', ...expected },
  });
  expect(mockBindDeviceRuntime.mock.calls[0]?.[1]).toMatchObject({ required: ['uninstallApp'] });
});

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
    error: { code: 'UNSUPPORTED_OPERATION' },
  });
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(mockUninstallAppRuntime).not.toHaveBeenCalled();
});
