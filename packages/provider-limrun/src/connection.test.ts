import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PluginConnectionContext } from '@agent-device/plugins/contract';
import { AppError } from '@agent-device/kernel/errors';
import { createLimrunConnection } from './connection.ts';
import { LIMRUN_CONNECTION_CAPABILITIES } from './device.ts';

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

test('resolve gives an unscoped connect a run of its own and leaves identity to the host', async () => {
  const first = await resolve({ platform: 'android' });
  const second = await resolve({ platform: 'android' });
  assert.match(String(first.profile.runId), /^limrun-[a-f0-9]{16}$/);
  assert.notEqual(first.profile.runId, second.profile.runId);

  // A named session reconnects under the run the host derives from that session, and a run the
  // caller passed is theirs to share; neither is the provider's to name.
  assert.equal((await resolve({ platform: 'android', session: 'ci' })).profile.runId, undefined);
  assert.equal((await resolve({ platform: 'android', runId: 'run-a' })).profile.runId, undefined);
});
