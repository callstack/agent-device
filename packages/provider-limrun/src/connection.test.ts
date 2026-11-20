import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { PluginConnectionContext, ProviderPluginHost } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import { createLimrunConnection } from './connection.ts';
import { LIMRUN_CONNECTION_CAPABILITIES } from './device.ts';

// `verify` reaches the Limrun SDK when it runs. Both routes in are stubbed so a case reads which
// one the selected platform takes, and no request leaves the process.
const limrunSdk = vi.hoisted(() => {
  const clients: Array<Record<string, unknown>> = [];
  const attached: Array<Record<string, unknown>> = [];
  return {
    clients,
    attached,
    androidList: vi.fn(async () => ({ getPaginatedItems: () => [] })),
    iosList: vi.fn(async () => ({ getPaginatedItems: () => [] })),
    connectAttached: vi.fn(async (options: Record<string, unknown>) => {
      attached.push(options);
      return { disconnect: () => undefined };
    }),
  };
});

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly androidInstances = { list: limrunSdk.androidList };
    readonly iosInstances = { list: limrunSdk.iosList };

    constructor(options: Record<string, unknown>) {
      limrunSdk.clients.push(options);
    }
  },
}));

vi.mock('@limrun/api/ios-client', () => ({ createInstanceClient: limrunSdk.connectAttached }));
vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: limrunSdk.connectAttached,
}));

afterEach(() => {
  limrunSdk.clients.length = 0;
  limrunSdk.attached.length = 0;
  limrunSdk.androidList.mockClear();
  limrunSdk.iosList.mockClear();
  limrunSdk.connectAttached.mockClear();
});

const IOS_INSTANCE = {
  LIM_IOS_INSTANCE_URL: 'https://region.limrun.example/v1/ios_x/api',
  LIM_IOS_INSTANCE_TOKEN: 'ios-instance-token',
};
const ANDROID_INSTANCE = {
  LIM_ANDROID_INSTANCE_URL: 'https://region.limrun.example/v1/android_x/api',
  LIM_ANDROID_INSTANCE_TOKEN: 'android-instance-token',
  LIM_ANDROID_INSTANCE_ADB_URL: 'wss://region.limrun.example/v1/android_x/adb',
};

/** The `resolve` context one `agent-device connect limrun` call gives the provider. */
function connectContext(
  flags: Partial<PluginConnectionContext['flags']> = {},
  env: Record<string, string | undefined> = { LIMRUN_API_KEY: 'lim_test_key' },
): PluginConnectionContext {
  return {
    flags: { json: true, help: false, version: false, ...flags },
    stateDir: '/state',
    cwd: '/project',
    env,
    // `resolve` reads only its call's flags and environment; the host stands for the rest.
    host: {} as PluginConnectionContext['host'],
  };
}

function resolve(
  flags: Partial<PluginConnectionContext['flags']> = {},
  env?: Record<string, string | undefined>,
) {
  const { resolve: resolveConnection } = createLimrunConnection();
  // `resolve` answers synchronously; wrap it so a refusal reads as a rejection either way.
  return Promise.resolve().then(async () => await resolveConnection(connectContext(flags, env)));
}

test('the connection declares Limrun as a local provider with a deferred app and device', () => {
  assert.deepEqual(createLimrunConnection().capabilities, LIMRUN_CONNECTION_CAPABILITIES);
  assert.deepEqual(
    {
      leaseKind: LIMRUN_CONNECTION_CAPABILITIES.leaseKind,
      requiresRemoteDaemon: LIMRUN_CONNECTION_CAPABILITIES.requiresRemoteDaemon,
      supportsDeferredAppSelection: LIMRUN_CONNECTION_CAPABILITIES.supportsDeferredAppSelection,
    },
    {
      leaseKind: 'direct-device-provider',
      requiresRemoteDaemon: false,
      supportsDeferredAppSelection: true,
    },
  );
});

test('resolve names the platform, its lease backend, and the capture opt-in it carries forward', async () => {
  const resolved = await resolve({
    platform: 'ios',
    session: 'ci',
    providerNetworkLogs: true,
    providerNetworkHosts: 'api.example',
  });
  assert.deepEqual(resolved.profile, {
    daemonTransport: 'auto',
    sessionIsolation: 'tenant',
    target: 'mobile',
    leaseBackend: 'ios-instance',
    leaseProvider: 'limrun',
    platform: 'ios',
    clientId: undefined,
    runId: 'limrun-803cad858538d077',
    providerNetworkLogs: true,
    providerNetworkHosts: 'api.example',
  });
});

test('resolve refuses the call until the platform names the one Limrun rents', async () => {
  await assert.rejects(resolve({}), {
    code: 'INVALID_ARGS',
    message: 'connect limrun requires --platform ios or android.',
  });
  await assert.rejects(resolve({ platform: 'macos' }), {
    code: 'INVALID_ARGS',
    message: 'connect limrun requires --platform ios or android.',
  });
});

test('resolve refuses a device selection and a lease backend of the other platform', async () => {
  await assert.rejects(resolve({ platform: 'ios', device: 'local-ios' }), {
    code: 'INVALID_ARGS',
    message:
      'connect limrun does not accept --device; Limrun selects a remote simulator or emulator.',
  });
  await assert.rejects(resolve({ platform: 'ios', leaseBackend: 'android-instance' }), {
    code: 'INVALID_ARGS',
    message: 'connect limrun --platform ios requires --lease-backend ios-instance.',
  });
});

test('resolve narrows the accepted credentials to the resolved platform', async () => {
  // Access to the iOS instance is not access to the Android one this call rents.
  await assert.rejects(
    resolve({ platform: 'android' }, { ...IOS_INSTANCE, LIMRUN_API_KEY: '' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.details?.reason, 'missing_provider_credentials');
      assert.equal(
        error.message,
        'connect limrun requires LIMRUN_API_KEY, or LIM_ANDROID_INSTANCE_URL, LIM_ANDROID_INSTANCE_TOKEN, LIM_ANDROID_INSTANCE_ADB_URL for an existing instance.',
      );
      return true;
    },
  );
  assert.equal(
    (await resolve({ platform: 'ios' }, IOS_INSTANCE)).profile.leaseBackend,
    'ios-instance',
  );
  assert.equal(
    (await resolve({ platform: 'android' }, ANDROID_INSTANCE)).profile.leaseBackend,
    'android-instance',
  );
});

test('resolve reads the refused profile fields before the credentials or the platform', async () => {
  await assert.rejects(
    resolve({ platform: 'ios', providerOsVersion: '18.0', providerGeoLocation: 'US' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.deepEqual(error.details?.flags, ['--provider-os-version', '--provider-geo-location']);
      return true;
    },
  );
  // The app to preinstall is one Limrun reads, so the same call carries it through.
  assert.equal(
    (await resolve({ platform: 'ios', providerApp: 'Example.ipa' })).profile.leaseBackend,
    'ios-instance',
  );
});

test('resolve gives each unscoped connect a run and preserves an explicit run', async () => {
  const first = await resolve({ platform: 'android' });
  const second = await resolve({ platform: 'android' });
  assert.match(String(first.profile.runId), /^limrun-[a-f0-9]{16}$/);
  assert.notEqual(first.profile.runId, second.profile.runId);

  assert.equal((await resolve({ platform: 'android', runId: 'run-a' })).profile.runId, 'run-a');
});

/**
 * The `verify` context the registry hands the callback: the same host `setup` receives, built from
 * this call's env, so its `clientVersion` is the host's own.
 */
function verifyContext(
  flags: Partial<PluginConnectionContext['flags']>,
  env: Record<string, string | undefined>,
): Pick<PluginConnectionContext, 'flags' | 'env' | 'host'> {
  return {
    flags: { json: true, help: false, version: false, ...flags },
    env,
    host: {
      env,
      options: {},
      clientVersion: '1.2.3',
      createError: (code, message, details) => new AppError(code, message, details),
      runHostCommand: async () => {
        throw new Error('connection verification runs no host command');
      },
    } satisfies ProviderPluginHost,
  };
}

function verify(
  flags: Partial<PluginConnectionContext['flags']>,
  env: Record<string, string | undefined> = { LIMRUN_API_KEY: 'lim_test_key' },
) {
  return createLimrunConnection().verify(verifyContext(flags, env));
}

test('verify asks the selected platform of the account the scoped credentials reach', async () => {
  const verification = await verify({ platform: 'ios' }, { LIMRUN_API_KEY: ' lim_test_key ' });

  assert.equal(verification.verificationMessage, 'Credentials and iOS instance access verified.');
  assert.deepEqual(limrunSdk.clients, [
    {
      apiKey: 'lim_test_key',
      userAgent: 'agent-device-cli/1.2.3',
      timeout: 15_000,
      maxRetries: 0,
    },
  ]);
  assert.deepEqual(limrunSdk.iosList.mock.calls, [[{ limit: 1 }]]);
  assert.deepEqual(limrunSdk.androidList.mock.calls, []);
  assert.deepEqual(limrunSdk.attached, []);
});

test('verify prefers the attached instance of the selected platform over the account', async () => {
  const verification = await verify(
    { platform: 'android' },
    { LIMRUN_API_KEY: 'lim_test_key', ...ANDROID_INSTANCE },
  );

  assert.equal(verification.device.status, 'verified');
  assert.deepEqual(limrunSdk.attached, [
    {
      apiUrl: 'https://region.limrun.example/v1/android_x/api',
      token: 'android-instance-token',
      adbUrl: 'wss://region.limrun.example/v1/android_x/adb',
      logLevel: 'none',
      maxReconnectAttempts: 0,
    },
  ]);
  assert.deepEqual(limrunSdk.clients, []);
});

test('verify refuses a profile that missed a platform without asking the account or an instance', async () => {
  // The credentials of the call are read first, so this is the typed refusal a saved profile that
  // never recorded a platform gets, and no client is asked.
  await assert.rejects(verify({}, { LIMRUN_API_KEY: 'lim_test_key' }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.message, 'Limrun profile missed a mobile platform.');
    return true;
  });
  assert.deepEqual(limrunSdk.clients, []);
  assert.deepEqual(limrunSdk.attached, []);
});

test('verify refuses missing credentials before the platform it was not given', async () => {
  // A call missing both answers with the one the caller can still fix on the command line, and the
  // SDK stays closed.
  await assert.rejects(verify({}, {}), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'INVALID_ARGS');
    assert.equal(error.details?.reason, 'missing_provider_credentials');
    return true;
  });
  assert.deepEqual(limrunSdk.clients, []);
  assert.deepEqual(limrunSdk.attached, []);
});
