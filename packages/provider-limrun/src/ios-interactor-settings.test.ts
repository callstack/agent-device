import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';

function sessionWithClient(results: Array<{ code: number; stdout: string; stderr: string }> = []) {
  const queue = [...results];
  const client = {
    simctl: vi.fn((_argv: string[]) => ({
      wait: async () => queue.shift() ?? { code: 0, stdout: '', stderr: '' },
    })),
    softReset: vi.fn(async (_bundleId: string, _options?: unknown) => ({})),
    terminateApp: vi.fn(async (_bundleId: string) => {}),
  };
  const session = {
    platform: 'ios',
    instanceId: 'limrun-settings-instance',
    device: { id: 'limrun:ios:settings', platform: 'ios' },
    client,
    dependencies: {
      ios: {
        resolveAppAlias: async (app: string) => app,
        settings: {
          privacyAction: (action: string) => (action === 'deny' ? 'revoke' : action),
          parsePrivacyService: (target?: string, mode?: string) =>
            target === 'photos' && mode === 'limited' ? 'photos-add' : target,
          parseAppearance: (stdout: string) => (/dark/.test(stdout) ? 'dark' : 'light'),
          isPrivacyServiceRefusal: (error: unknown) =>
            error instanceof AppError && error.details?.stderr === 'refused',
          privacyServiceRefusedError: (params: { target: string; appBundleId: string }) =>
            new AppError('UNSUPPORTED_OPERATION', `refused ${params.target}`, {
              appBundleId: params.appBundleId,
            }),
        },
      },
    },
  } as unknown as LimrunIosSession;
  return { interactor: createLimrunIosInteractor(session), client };
}

const argvOf = (client: { simctl: { mock: { calls: unknown[][] } } }) =>
  client.simctl.mock.calls.map((call) => call[0]);

test('appearance sets the requested value on the booted simulator', async () => {
  const { interactor, client } = sessionWithClient();

  await interactor.setSetting('appearance', 'dark');

  expect(argvOf(client)).toEqual([['ui', 'booted', 'appearance', 'dark']]);
});

test('appearance toggle reads the current value then sets the opposite', async () => {
  const { interactor, client } = sessionWithClient([{ code: 0, stdout: 'dark\n', stderr: '' }]);

  await interactor.setSetting('appearance', 'toggle');

  expect(argvOf(client)).toEqual([
    ['ui', 'booted', 'appearance'],
    ['ui', 'booted', 'appearance', 'light'],
  ]);
});

test('permission deny revokes the mapped service for the app', async () => {
  const { interactor, client } = sessionWithClient();

  await interactor.setSetting('permission', 'deny', 'com.example.app', {
    permissionTarget: 'photos',
    permissionMode: 'limited',
  });
  await interactor.setSetting('permission', 'grant', 'com.example.app', {
    permissionTarget: 'all',
  });

  expect(argvOf(client)).toEqual([
    ['privacy', 'booted', 'revoke', 'photos-add', 'com.example.app'],
    ['privacy', 'booted', 'grant', 'all', 'com.example.app'],
  ]);
});

test('location set sends coordinates, on and off grant and revoke the app', async () => {
  const { interactor, client } = sessionWithClient();

  const result = await interactor.setSetting('location', 'set', undefined, {
    latitude: 37.77,
    longitude: -122.42,
  });
  await interactor.setSetting('location', 'on', 'com.example.app');
  await interactor.setSetting('location', 'off', 'com.example.app');

  expect(result).toEqual({ latitude: 37.77, longitude: -122.42 });
  expect(argvOf(client)).toEqual([
    ['location', 'booted', 'set', '37.77,-122.42'],
    ['privacy', 'booted', 'grant', 'location', 'com.example.app'],
    ['privacy', 'booted', 'revoke', 'location', 'com.example.app'],
  ]);
});

test('clear-app-state soft resets the app data through Limrun', async () => {
  const { interactor, client } = sessionWithClient();

  const result = await interactor.setSetting('clear-app-state', 'clear', 'com.example.app');

  expect(client.softReset).toHaveBeenCalledWith('com.example.app', { strategy: 'data' });
  expect(client.terminateApp).toHaveBeenCalledWith('com.example.app');
  expect(client.softReset.mock.invocationCallOrder[0]).toBeLessThan(
    client.terminateApp.mock.invocationCallOrder[0]!,
  );
  expect(client.simctl).not.toHaveBeenCalled();
  expect(result).toEqual({ bundleId: 'com.example.app', cleared: true });
});

test('a plain SDK failure while clearing app state becomes a typed COMMAND_FAILED', async () => {
  const reset = sessionWithClient();
  const cause = new Error('HTTP 500');
  reset.client.softReset.mockRejectedValueOnce(cause);
  const stop = sessionWithClient();
  stop.client.terminateApp.mockRejectedValueOnce(cause);

  for (const { interactor } of [reset, stop]) {
    await expect(
      interactor.setSetting('clear-app-state', 'clear', 'com.example.app'),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      message: 'Limrun iOS could not clear app state.',
      details: { setting: 'clear-app-state', bundleId: 'com.example.app' },
      cause,
    });
  }
});

test('a failing simctl rejects with typed setting, exit code and stderr', async () => {
  const { interactor } = sessionWithClient([{ code: 3, stdout: '', stderr: 'denied\n' }]);

  await expect(interactor.setSetting('appearance', 'dark')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { setting: 'appearance', exitCode: 3, stderr: 'denied' },
  });
});

test('a permission service the runtime refuses is mapped by the injected Apple adapter', async () => {
  const { interactor } = sessionWithClient([{ code: 1, stdout: '', stderr: 'refused' }]);

  await expect(
    interactor.setSetting('permission', 'grant', 'com.example.app', {
      permissionTarget: 'notifications',
    }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    message: 'refused notifications',
    details: { appBundleId: 'com.example.app' },
  });
});

test('settings that need an app refuse with the local simulator message', async () => {
  const { interactor, client } = sessionWithClient();

  for (const [setting, state, message] of [
    ['permission', 'grant', 'permission setting requires an active app in session'],
    ['location', 'on', 'location setting requires an active app in session'],
    ['location', 'off', 'location setting requires an active app in session'],
    [
      'clear-app-state',
      'clear',
      'settings clear-app-state requires an app id or an active app session.',
    ],
  ] as const) {
    await expect(
      interactor.setSetting(setting, state, undefined, { permissionTarget: 'camera' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS', message });
  }
  expect(client.simctl).not.toHaveBeenCalled();
  expect(client.softReset).not.toHaveBeenCalled();
});

test('settings Limrun cannot serve are refused with the supported list', async () => {
  const { interactor, client } = sessionWithClient();

  for (const [setting, state] of [
    ['wifi', 'off'],
    ['reset-keychain', 'clear'],
  ] as const) {
    const rejection = interactor.setSetting(setting, state);
    await expect(rejection).rejects.toBeInstanceOf(AppError);
    await expect(rejection).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('appearance, permission, location'),
    });
  }
  expect(client.simctl).not.toHaveBeenCalled();
});
