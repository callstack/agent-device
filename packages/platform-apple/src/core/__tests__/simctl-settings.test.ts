import { expect, test, vi } from 'vitest';
import type { SimctlSettingRequest } from '@agent-device/contracts/settings';
import { AppError, PRE_DISPATCH_REFUSAL_REASONS } from '@agent-device/kernel/errors';
import { applySimctlSetting } from '../simctl-settings.ts';

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
  return {
    runSimctl,
    udid: 'SIM-1',
    deviceId: 'SIM-1',
    setting: 'appearance',
    state: 'dark',
    ...overrides,
  };
}

function argvs(runSimctl: ReturnType<typeof recordingRunner>): string[][] {
  return runSimctl.mock.calls.map(([args]) => args);
}

async function appErrorFrom(pending: Promise<unknown>): Promise<AppError> {
  const rejection = await pending.then(
    () => expect.unreachable('expected the setting to reject'),
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(AppError);
  return rejection as AppError;
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

  expect(argvs(runSimctl)).toEqual([
    ['ui', 'SIM-1', 'appearance'],
    ['ui', 'SIM-1', 'appearance', 'dark'],
    ['privacy', 'SIM-1', 'revoke', 'photos-add', 'com.example.app'],
    ['location', 'SIM-1', 'set', '1,2'],
  ]);
  expect(location).toEqual({ latitude: 1, longitude: 2 });
});

test.for([
  { current: 'dark', target: 'light' },
  { current: 'light', target: 'dark' },
])('appearance toggle reads $current and sets $target', async ({ current, target }) => {
  const runSimctl = recordingRunner([{ stdout: `${current}\n`, stderr: '' }]);

  await applySimctlSetting(request(runSimctl, { state: 'toggle' }));

  expect(argvs(runSimctl)).toEqual([
    ['ui', 'SIM-1', 'appearance'],
    ['ui', 'SIM-1', 'appearance', target],
  ]);
});

test('appearance toggle refuses a current appearance that is neither light nor dark', async () => {
  const runSimctl = recordingRunner([{ stdout: 'unsupported', stderr: '' }]);

  const error = await appErrorFrom(applySimctlSetting(request(runSimctl, { state: 'toggle' })));

  expect(error).toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Unable to determine current iOS appearance for toggle',
    details: { stdout: 'unsupported', stderr: '' },
  });
  expect(argvs(runSimctl)).toEqual([['ui', 'SIM-1', 'appearance']]);
});

test('location set sends one latitude,longitude argument and returns the coordinates', async () => {
  const runSimctl = recordingRunner();

  const result = await applySimctlSetting(
    request(runSimctl, {
      setting: 'location',
      state: 'set',
      options: { latitude: 37.3349, longitude: -122.009 },
    }),
  );

  expect(argvs(runSimctl)).toEqual([['location', 'SIM-1', 'set', '37.3349,-122.009']]);
  expect(result).toEqual({ latitude: 37.3349, longitude: -122.009 });
});

test.for([
  { options: { permissionTarget: 'calendar' }, service: 'calendar' },
  { options: { permissionTarget: 'all' }, service: 'all' },
  { options: { permissionTarget: 'camera' }, service: 'camera' },
  { options: { permissionTarget: 'photos', permissionMode: 'limited' }, service: 'photos-add' },
])(
  'grant $options.permissionTarget is one simctl privacy $service call with no capability probe',
  async ({ options, service }) => {
    const runSimctl = recordingRunner();

    await applySimctlSetting(
      request(runSimctl, {
        setting: 'permission',
        state: 'grant',
        appBundleId: 'com.example.app',
        options,
      }),
    );

    expect(argvs(runSimctl)).toEqual([['privacy', 'SIM-1', 'grant', service, 'com.example.app']]);
  },
);

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

test('a refused privacy service reports the device id the caller names, not the udid', async () => {
  const refused = new AppError('COMMAND_FAILED', 'simctl exited with code 1', {
    stderr: 'Failed to grant access to com.example.app\nOperation not permitted',
  });
  const runSimctl = recordingRunner([refused]);

  await expect(
    applySimctlSetting(
      request(runSimctl, {
        udid: 'booted',
        deviceId: 'limrun:ios:lease-a',
        setting: 'permission',
        state: 'grant',
        appBundleId: 'com.example.app',
        options: { permissionTarget: 'notifications' },
      }),
    ),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { deviceId: 'limrun:ios:lease-a', appBundleId: 'com.example.app' },
  });
  expect(argvs(runSimctl)).toEqual([
    ['privacy', 'booted', 'grant', 'notifications', 'com.example.app'],
  ]);
});

test.for([
  { state: 'deny', action: 'revoke', target: 'notifications', wording: 'Failed to revoke access' },
  { state: 'grant', action: 'grant', target: 'calendar', wording: 'Failed to set access' },
])(
  '$state $target refused as $wording is unsupported, with no capability probe',
  async ({ state, action, target, wording }) => {
    const refused = new AppError('COMMAND_FAILED', 'simctl exited with code 1', {
      stderr: `${wording}\nOperation not permitted`,
    });
    const runSimctl = recordingRunner([refused]);

    const error = await appErrorFrom(
      applySimctlSetting(
        request(runSimctl, {
          setting: 'permission',
          state,
          appBundleId: 'com.example.app',
          options: { permissionTarget: target },
        }),
      ),
    );

    expect(error).toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: `iOS simulator does not support setting ${target} permission via simctl privacy on this runtime.`,
      details: { deviceId: 'SIM-1', appBundleId: 'com.example.app' },
      cause: refused,
    });
    expect(argvs(runSimctl)).toEqual([['privacy', 'SIM-1', action, target, 'com.example.app']]);
  },
);

test('a refused targeted reset fails instead of a reset all that would clear earlier grants', async () => {
  const refused = new AppError('COMMAND_FAILED', 'simctl exited with code 1', {
    stderr: 'Failed to reset access\nOperation not permitted',
  });
  const runSimctl = recordingRunner([{ stdout: '', stderr: '' }, refused]);
  const permission = (state: string, permissionTarget: string) =>
    request(runSimctl, {
      setting: 'permission',
      state,
      appBundleId: 'com.example.app',
      options: { permissionTarget },
    });

  await applySimctlSetting(permission('grant', 'microphone'));
  const error = await appErrorFrom(applySimctlSetting(permission('reset', 'notifications')));

  expect(error).toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    message:
      'iOS simulator does not support resetting notifications permission via simctl privacy on this runtime.',
    details: { deviceId: 'SIM-1', appBundleId: 'com.example.app' },
    cause: refused,
  });
  expect(argvs(runSimctl)).toEqual([
    ['privacy', 'SIM-1', 'grant', 'microphone', 'com.example.app'],
    ['privacy', 'SIM-1', 'reset', 'notifications', 'com.example.app'],
  ]);
});

test.for([
  { setting: 'permission', state: 'grant' },
  { setting: 'location', state: 'on' },
] as const)(
  '$setting $state without an app refuses before running simctl',
  async ({ setting, state }) => {
    const runSimctl = recordingRunner();

    const error = await appErrorFrom(
      applySimctlSetting(
        request(runSimctl, { setting, state, options: { permissionTarget: 'camera' } }),
      ),
    );

    expect(error).toMatchObject({
      code: 'INVALID_ARGS',
      message: `${setting} setting requires an active app in session`,
      details: { reason: PRE_DISPATCH_REFUSAL_REASONS.sessionAppRequired, dispatched: 'no' },
    });
    expect(runSimctl).not.toHaveBeenCalled();
  },
);

test('a permission mode on a target other than photos refuses before running simctl', async () => {
  const runSimctl = recordingRunner();

  const error = await appErrorFrom(
    applySimctlSetting(
      request(runSimctl, {
        setting: 'permission',
        state: 'grant',
        appBundleId: 'com.example.app',
        options: { permissionTarget: 'camera', permissionMode: 'limited' },
      }),
    ),
  );

  expect(error).toMatchObject({
    code: 'INVALID_ARGS',
    message: 'Permission mode is only supported for photos. Received: limited.',
  });
  expect(runSimctl).not.toHaveBeenCalled();
});
