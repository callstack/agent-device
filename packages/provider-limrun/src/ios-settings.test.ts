import { expect, test, vi } from 'vitest';
import type { LimrunIosSession } from './ios.ts';
import type { LimrunIosSimctlSettingRequest } from './runtime-dependencies.ts';
import { setLimrunIosSetting } from './ios-settings.ts';

function sessionWithClient(results: Array<{ code: number; stdout: string; stderr: string }> = []) {
  const queue = [...results];
  const client = {
    simctl: vi.fn((_argv: string[]) => ({
      wait: async () => queue.shift() ?? { code: 0, stdout: '', stderr: '' },
    })),
    softReset: vi.fn(async (_bundleId: string, _options?: unknown) => ({})),
    terminateApp: vi.fn(async (_bundleId: string) => {}),
  };
  const applySimctlSetting = vi.fn(async (request: LimrunIosSimctlSettingRequest) => {
    const output = await request.runSimctl(['ui', request.udid, 'appearance']);
    return { output };
  });
  const session = {
    platform: 'ios',
    device: { id: 'limrun:ios:settings', platform: 'ios' },
    client,
    dependencies: {
      ios: { applySimctlSetting, resolveAppAlias: async (app: string) => `resolved.${app}` },
    },
  } as unknown as LimrunIosSession;
  return { session, client, applySimctlSetting };
}

test('simctl settings run the Apple plan on the booted simulator with the resolved app', async () => {
  const { session, client, applySimctlSetting } = sessionWithClient([
    { code: 0, stdout: 'dark\n', stderr: '' },
  ]);
  const options = { permissionTarget: 'photos', permissionMode: 'limited' };

  const result = await setLimrunIosSetting(session, 'Permission', 'grant', 'camera-app', options);

  expect(applySimctlSetting).toHaveBeenCalledWith({
    runSimctl: expect.any(Function),
    udid: 'booted',
    setting: 'permission',
    state: 'grant',
    appBundleId: 'resolved.camera-app',
    options,
  });
  expect(client.simctl.mock.calls).toEqual([[['ui', 'booted', 'appearance']]]);
  expect(result).toEqual({ output: { code: 0, stdout: 'dark\n', stderr: '' } });
});

test('an appless simctl setting reaches the Apple plan without an app', async () => {
  const { session, applySimctlSetting } = sessionWithClient();

  await setLimrunIosSetting(session, 'appearance', 'toggle', undefined, undefined);

  expect(applySimctlSetting.mock.calls[0]?.[0].appBundleId).toBeUndefined();
});

test('a failing Limrun simctl rejects with its exit code and stderr', async () => {
  const { session } = sessionWithClient([{ code: 3, stdout: 'out', stderr: 'denied\n' }]);

  await expect(
    setLimrunIosSetting(session, 'appearance', 'dark', undefined, undefined),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { args: ['ui', 'booted', 'appearance'], exitCode: 3, stderr: 'denied\n' },
  });
});

test('clear-app-state soft resets the app data through Limrun, then stops the app', async () => {
  const { session, client, applySimctlSetting } = sessionWithClient();

  const result = await setLimrunIosSetting(session, 'clear-app-state', 'clear', 'app', undefined);

  expect(client.softReset).toHaveBeenCalledWith('resolved.app', { strategy: 'data' });
  expect(client.terminateApp).toHaveBeenCalledWith('resolved.app');
  expect(client.softReset.mock.invocationCallOrder[0]).toBeLessThan(
    client.terminateApp.mock.invocationCallOrder[0]!,
  );
  expect(applySimctlSetting).not.toHaveBeenCalled();
  expect(result).toEqual({ bundleId: 'resolved.app', cleared: true });
});

test('a plain SDK failure while clearing app state becomes a typed COMMAND_FAILED', async () => {
  const reset = sessionWithClient();
  const cause = new Error('HTTP 500');
  reset.client.softReset.mockRejectedValueOnce(cause);
  const stop = sessionWithClient();
  stop.client.terminateApp.mockRejectedValueOnce(cause);

  for (const { session } of [reset, stop]) {
    await expect(
      setLimrunIosSetting(session, 'clear-app-state', 'clear', 'app', undefined),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      message: 'Limrun iOS could not clear app state.',
      details: { setting: 'clear-app-state', bundleId: 'resolved.app' },
      cause,
    });
  }
});

test('clear-app-state refuses an appless session and any state but clear', async () => {
  const { session, client } = sessionWithClient();

  await expect(
    setLimrunIosSetting(session, 'clear-app-state', 'clear', undefined, undefined),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: 'settings clear-app-state requires an app id or an active app session.',
    details: { reason: 'session_app_required' },
  });
  await expect(
    setLimrunIosSetting(session, 'clear-app-state', 'wipe', 'app', undefined),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(client.softReset).not.toHaveBeenCalled();
});

test('settings Limrun cannot serve are refused with the supported list', async () => {
  const { session, client, applySimctlSetting } = sessionWithClient();

  for (const [setting, state] of [
    ['wifi', 'off'],
    ['reset-keychain', 'clear'],
    ['text-size', 'large'],
  ] as const) {
    await expect(
      setLimrunIosSetting(session, setting, state, 'app', undefined),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('appearance, permission, location, and clear-app-state'),
    });
  }
  expect(applySimctlSetting).not.toHaveBeenCalled();
  expect(client.simctl).not.toHaveBeenCalled();
});
