import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { applySimctlSetting, type SimctlSettingRequest } from '../simctl-settings.ts';

function recordingRunner(outputs: Array<{ stdout: string; stderr: string } | AppError> = []) {
  const queue = [...outputs];
  return vi.fn(async (_args: string[]) => {
    const next = queue.shift() ?? { stdout: '', stderr: '' };
    if (next instanceof AppError) throw next;
    return next;
  });
}

function request(
  runSimctl: SimctlSettingRequest['runSimctl'],
  overrides: Partial<SimctlSettingRequest>,
): SimctlSettingRequest {
  return { runSimctl, udid: 'SIM-1', setting: 'appearance', state: 'dark', ...overrides };
}

test('every simctl argv addresses the udid the runner was given', async () => {
  const runSimctl = recordingRunner([{ stdout: 'light\n', stderr: '' }]);

  await applySimctlSetting(request(runSimctl, { state: 'toggle' }));
  await applySimctlSetting(
    request(runSimctl, {
      setting: 'permission',
      state: 'deny',
      appBundleId: 'com.example.app',
      options: { permissionTarget: 'photos', permissionMode: 'limited' },
    }),
  );
  const location = await applySimctlSetting(
    request(runSimctl, {
      setting: 'location',
      state: 'set',
      options: { latitude: 1, longitude: 2 },
    }),
  );

  expect(runSimctl.mock.calls.map(([args]) => args)).toEqual([
    ['ui', 'SIM-1', 'appearance'],
    ['ui', 'SIM-1', 'appearance', 'dark'],
    ['privacy', 'SIM-1', 'revoke', 'photos-add', 'com.example.app'],
    ['location', 'SIM-1', 'set', '1,2'],
  ]);
  expect(location).toEqual({ latitude: 1, longitude: 2 });
});

test('a privacy service the runtime refuses is unsupported; other failures pass through', async () => {
  const refused = new AppError('COMMAND_FAILED', 'simctl exited with code 1', {
    stderr: 'Failed to grant access to com.example.app\nOperation not permitted',
  });
  const failed = new AppError('COMMAND_FAILED', 'simctl exited with code 2', {
    stderr: 'Invalid device: booted',
  });
  const runSimctl = recordingRunner([refused, failed]);
  const grant = request(runSimctl, {
    setting: 'permission',
    state: 'grant',
    appBundleId: 'com.example.app',
    options: { permissionTarget: 'notifications' },
  });

  await expect(applySimctlSetting(grant)).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    message:
      'iOS simulator does not support setting notifications permission via simctl privacy on this runtime.',
    details: { deviceId: 'SIM-1', appBundleId: 'com.example.app' },
    cause: refused,
  });
  await expect(applySimctlSetting(grant)).rejects.toBe(failed);
});

test('an app-scoped setting without an app refuses before running simctl', async () => {
  const runSimctl = recordingRunner();

  for (const [setting, state] of [
    ['permission', 'grant'],
    ['location', 'on'],
  ] as const) {
    await expect(
      applySimctlSetting(
        request(runSimctl, { setting, state, options: { permissionTarget: 'camera' } }),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      message: `${setting} setting requires an active app in session`,
      details: { reason: 'session_app_required' },
    });
  }
  expect(runSimctl).not.toHaveBeenCalled();
});
