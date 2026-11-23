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
    resolveApp: async (app) => app,
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

// Every target but the narrower ones that share a row (contacts-limited, location) and
// notifications, which SpringBoard's settings file holds.
const EVERY_SERVICE = [
  'calendar',
  'camera',
  'contacts',
  'location-always',
  'media-library',
  'microphone',
  'motion',
  'photos',
  'reminders',
  'siri',
];

function refusal(wording: string): AppError {
  return new AppError('COMMAND_FAILED', 'simctl exited with code 1', {
    stderr: `${wording}\nOperation not permitted`,
  });
}

// A revoke also takes back limited photo access, a service of its own.
const EVERY_REVOKED_SERVICE = [...EVERY_SERVICE, 'photos-add'];

test.for([
  { state: 'grant', action: 'grant', wording: 'Failed to grant access', services: EVERY_SERVICE },
  {
    state: 'deny',
    action: 'revoke',
    wording: 'Failed to revoke access',
    services: EVERY_REVOKED_SERVICE,
  },
])(
  '$state all changes each service in turn and skips the one the runtime refuses',
  async ({ state, action, wording, services }) => {
    // The simulator records `all` as one kTCCServiceAll row that iOS does not consult.
    const runSimctl = recordingRunner(
      services.map((service) =>
        service === 'siri' ? refusal(wording) : { stdout: '', stderr: '' },
      ),
    );

    const result = await applySimctlSetting(
      request(runSimctl, {
        setting: 'permission',
        state,
        appBundleId: 'com.example.app',
        options: { permissionTarget: 'all' },
      }),
    );

    expect(argvs(runSimctl)).toEqual(
      services.map((service) => ['privacy', 'SIM-1', action, service, 'com.example.app']),
    );
    expect(result).toEqual({
      permission: 'all',
      permissions: services.filter((service) => service !== 'siri'),
      warnings: [
        'Skipped siri: this iOS runtime does not let simctl privacy change it.',
        'Skipped notifications: iOS simulator notification permission needs the simulator files on this host.',
      ],
    });
  },
);

test('reset all stays one simctl call, which clears every service', async () => {
  const runSimctl = recordingRunner();

  const result = await applySimctlSetting(
    request(runSimctl, {
      setting: 'permission',
      state: 'reset',
      appBundleId: 'com.example.app',
      options: { permissionTarget: 'all' },
    }),
  );

  expect(argvs(runSimctl)).toEqual([['privacy', 'SIM-1', 'reset', 'all', 'com.example.app']]);
  expect(result).toBeUndefined();
});

test('grant all fails as unsupported only when the runtime refuses every service', async () => {
  const refused = refusal('Failed to grant access');
  const runSimctl = recordingRunner(EVERY_SERVICE.map(() => refused));

  await expect(
    applySimctlSetting(
      request(runSimctl, {
        setting: 'permission',
        state: 'grant',
        appBundleId: 'com.example.app',
        options: { permissionTarget: 'all' },
      }),
    ),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    message:
      'iOS simulator does not support setting all permission via simctl privacy on this runtime.',
    details: { hint: expect.stringContaining('refused every privacy service') },
    cause: refused,
  });
  expect(runSimctl).toHaveBeenCalledTimes(EVERY_SERVICE.length);
});

test('grant all stops at a failure that is not a refusal', async () => {
  const failed = new AppError('COMMAND_FAILED', 'simctl exited with code 2', {
    stderr: 'Invalid device: booted',
  });
  const runSimctl = recordingRunner([{ stdout: '', stderr: '' }, failed]);

  await expect(
    applySimctlSetting(
      request(runSimctl, {
        setting: 'permission',
        state: 'grant',
        appBundleId: 'com.example.app',
        options: { permissionTarget: 'all' },
      }),
    ),
  ).rejects.toBe(failed);
  expect(argvs(runSimctl)).toEqual([
    ['privacy', 'SIM-1', 'grant', 'calendar', 'com.example.app'],
    ['privacy', 'SIM-1', 'grant', 'camera', 'com.example.app'],
  ]);
  // The error names what had already changed, beside what the failure itself reported.
  expect(failed.details).toEqual({ stderr: 'Invalid device: booted', permissions: ['calendar'] });
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
    options: { permissionTarget: 'siri' },
  });

  await expect(applySimctlSetting(grant)).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    message:
      'iOS simulator does not support setting siri permission via simctl privacy on this runtime.',
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
        options: { permissionTarget: 'siri' },
      }),
    ),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { deviceId: 'limrun:ios:lease-a', appBundleId: 'com.example.app' },
  });
  expect(argvs(runSimctl)).toEqual([['privacy', 'booted', 'grant', 'siri', 'com.example.app']]);
});

test.for([
  { state: 'deny', action: 'revoke', target: 'siri', wording: 'Failed to revoke access' },
  { state: 'grant', action: 'grant', target: 'calendar', wording: 'Failed to set access' },
  {
    state: 'grant',
    action: 'grant',
    target: 'motion',
    wording:
      'Underlying error (domain=NSPOSIXErrorDomain, code=1):\n\tFailed to create TCC authorization record',
  },
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
  const error = await appErrorFrom(applySimctlSetting(permission('reset', 'siri')));

  expect(error).toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    message:
      'iOS simulator does not support resetting siri permission via simctl privacy on this runtime.',
    details: { deviceId: 'SIM-1', appBundleId: 'com.example.app' },
    cause: refused,
  });
  expect(argvs(runSimctl)).toEqual([
    ['privacy', 'SIM-1', 'grant', 'microphone', 'com.example.app'],
    ['privacy', 'SIM-1', 'reset', 'siri', 'com.example.app'],
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
      details: { reason: PRE_DISPATCH_REFUSAL_REASONS.sessionAppRequired.reason, dispatched: 'no' },
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

test.for([
  { setting: 'permission', state: 'grant', service: 'camera' },
  { setting: 'location', state: 'on', service: 'location' },
] as const)(
  '$setting $state writes the bundle id the runner resolves the named app to',
  async ({ setting, state, service }) => {
    const runSimctl = recordingRunner();
    const resolveApp = vi.fn(async (app: string) => (app === 'Maps' ? 'com.apple.Maps' : app));

    await applySimctlSetting(
      request(runSimctl, {
        setting,
        state,
        appBundleId: 'Maps',
        resolveApp,
        options: { permissionTarget: 'camera' },
      }),
    );

    expect(resolveApp).toHaveBeenCalledWith('Maps');
    expect(argvs(runSimctl)).toEqual([['privacy', 'SIM-1', 'grant', service, 'com.apple.Maps']]);
  },
);

test('an app the runner cannot resolve refuses before running simctl', async () => {
  const runSimctl = recordingRunner();
  const refusal = new AppError('APP_NOT_INSTALLED', 'No app found matching "Nope"');

  const error = await appErrorFrom(
    applySimctlSetting(
      request(runSimctl, {
        setting: 'permission',
        state: 'grant',
        appBundleId: 'Nope',
        resolveApp: async () => {
          throw refusal;
        },
        options: { permissionTarget: 'photos' },
      }),
    ),
  );

  expect(error).toBe(refusal);
  expect(runSimctl).not.toHaveBeenCalled();
});
