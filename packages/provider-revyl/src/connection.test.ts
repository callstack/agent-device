import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { CliFlags } from '@agent-device/contracts/command';
import { createRevylConnection, verifyRevylProfile } from './connection.ts';
import {
  revylLease,
  startRevylFixtureBackend,
  type RevylFixtureBackend,
} from './revyl-backend.fixtures.ts';
import { rejectRefusedRevylProfileFields } from './session-allocation.ts';

const HOST = {
  env: { REVYL_API_KEY: 'test-key' },
  clientVersion: '0.0.0-test',
  createError: (code: string, message: string) => new AppError(code as 'INVALID_ARGS', message),
} as never;

const openBackends: RevylFixtureBackend[] = [];

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((fixture) => fixture.close()));
});

async function backend(options?: Parameters<typeof startRevylFixtureBackend>[0]) {
  const started = await startRevylFixtureBackend(options);
  openBackends.push(started);
  return started;
}

test('verify authenticates with the cheap call and reports the profile without renting a device', async () => {
  const fixture = await backend();
  const result = await verifyRevylProfile(
    { apiKey: 'test-key', apiUrl: fixture.backendUrl },
    '0.0.0-test',
    'ios',
    { appUrl: 'https://apps.test/app.zip', deviceModel: 'iPhone 16', osVersion: '18.0' },
  );

  assert.deepEqual(fixture.paths(), ['GET /api/v1/entity/users/get_user_uuid']);
  assert.equal(fixture.requests[0]?.authorization, 'Bearer test-key');
  assert.equal(result.provider, 'revyl');
  assert.equal(
    result.verificationMessage,
    'Credentials verified; Revyl picks the device when the session starts.',
  );
  // The literals are asserted so a reworded report fails the test instead of being compared with
  // itself.
  assert.deepEqual(result.device, {
    status: 'configured',
    name: 'iPhone 16',
    platform: 'ios',
    osVersion: '18.0',
    message:
      'Revyl assigns a device of this platform when the session starts; a model or OS version it has no device for is reported then.',
  });
  assert.deepEqual(result.app, {
    status: 'configured',
    reference: 'https://apps.test/app.zip',
    message: 'Public app URL configured; Revyl fetches and installs it when the session starts.',
  });
});

test('verify reports a profile that names no device or OS version', async () => {
  const fixture = await backend();
  const result = await verifyRevylProfile(
    { apiKey: 'test-key', apiUrl: fixture.backendUrl },
    '0.0.0-test',
    'android',
    { appUrl: 'https://apps.test/app.apk' },
  );
  assert.deepEqual(result.device, {
    status: 'configured',
    platform: 'android',
    message:
      'Revyl assigns a device of this platform when the session starts; a model or OS version it has no device for is reported then.',
  });
});

test('verify reports a rejected key as an unauthorized error before checking the app', async () => {
  const fixture = await backend({
    respond: { 'GET /api/v1/entity/users/get_user_uuid': { status: 401, body: { error: 'nope' } } },
  });
  await assert.rejects(
    verifyRevylProfile({ apiKey: 'bad', apiUrl: fixture.backendUrl }, '0.0.0-test', 'ios', {
      appUrl: 'local/App.app',
    }),
    (error: unknown) => error instanceof AppError && error.code === 'UNAUTHORIZED',
  );
  // The app is only looked at once the key is good, so a bad key never reaches that check.
  assert.deepEqual(fixture.paths(), ['GET /api/v1/entity/users/get_user_uuid']);
});

test('verify refuses an app source Revyl cannot fetch', async () => {
  const fixture = await backend();
  for (const appUrl of ['./build/MyApp.ipa', 'http://apps.test/app.zip', 'lt://APP1']) {
    await assert.rejects(
      verifyRevylProfile({ apiKey: 'k', apiUrl: fixture.backendUrl }, '0.0.0-test', 'ios', {
        appUrl,
      }),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'invalid_provider_app',
      appUrl,
    );
  }
});

test('verify refuses an app URL only the caller own network can serve', async () => {
  const fixture = await backend();
  // Revyl fetches the build from its own network, so these can never be read there.
  for (const appUrl of [
    'https://localhost:8443/app.zip',
    'https://127.0.0.1/app.zip',
    'https://10.1.2.3/app.zip',
    'https://192.168.0.7/app.zip',
    'https://172.16.0.7/app.zip',
    'https://169.254.1.1/app.zip',
    'https://[::1]/app.zip',
    'https://builder.local/app.zip',
    'https://vpn.internal/app.zip',
    'https://user:pass@apps.test/app.zip',
    // The same loopback and link-local hosts written another way. `URL` reduces the first three to
    // 127.0.0.1, and the rest are IPv6 addresses that stand for an IPv4 one, which the old textual
    // compare read as an unfamiliar address and let through.
    'https://2130706433/app.zip',
    'https://0x7f.0.0.1/app.zip',
    'https://0177.0.0.1/app.zip',
    'https://[::ffff:127.0.0.1]/app.zip',
    'https://[::ffff:a9fe:101]/app.zip',
    'https://[::ffff:10.1.2.3]/app.zip',
    'https://[::ffff:c0a8:1]/app.zip',
    // The obsolete IPv4-compatible form, which stands for its v4 host the same way.
    'https://[::7f00:1]/app.zip',
  ]) {
    await assert.rejects(
      verifyRevylProfile({ apiKey: 'k', apiUrl: fixture.backendUrl }, '0.0.0-test', 'ios', {
        appUrl,
      }),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'invalid_provider_app',
      appUrl,
    );
  }
  // A publicly reachable host is accepted, including one in a range that only looks private.
  for (const appUrl of [
    'https://100.128.0.1/app.zip',
    'https://172.32.0.1/app.zip',
    'https://169.1.2.3/app.zip',
    // The closest negatives to the mapped forms above: a public address in the same spelling.
    'https://[::ffff:8.8.8.8]/app.zip',
    'https://8.8.8.8/app.zip',
  ]) {
    await verifyRevylProfile({ apiKey: 'k', apiUrl: fixture.backendUrl }, '0.0.0-test', 'ios', {
      appUrl,
    });
  }
});

test('verify refuses a profile flag Revyl has no field for before it rents anything', async () => {
  const fixture = await backend();
  const host = {
    env: { REVYL_API_KEY: 'test-key', REVYL_API_URL: fixture.backendUrl },
    clientVersion: '0.0.0-test',
    createError: (code: string, message: string) => new AppError(code as 'INVALID_ARGS', message),
  } as never;
  const connection = createRevylConnection(host);

  await assert.rejects(
    async () =>
      await connection.verify({
        flags: {
          platform: 'ios',
          providerApp: 'https://apps.test/app.zip',
          providerTimezone: 'UTC',
        } as CliFlags,
      }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
  // The refusal is cheap: no request reaches the backend for a profile that cannot be honored.
  assert.deepEqual(fixture.paths(), []);
});

test('verify canonicalizes the device and OS version it reports', async () => {
  const fixture = await backend();
  const host = {
    env: { REVYL_API_KEY: 'test-key', REVYL_API_URL: fixture.backendUrl },
    clientVersion: '0.0.0-test',
    createError: (code: string, message: string) => new AppError(code as 'INVALID_ARGS', message),
  } as never;
  const result = await createRevylConnection(host).verify({
    flags: {
      platform: 'ios',
      providerApp: 'https://apps.test/app.zip',
      device: '  iPhone 16  ',
      providerOsVersion: '  ',
    } as CliFlags,
  });
  assert.equal(result.device.name, 'iPhone 16');
  assert.equal('osVersion' in result.device, false, 'a blank OS version is no OS version');
});

test('resolve keeps the device, OS version and app URL and refuses a non-mobile platform', () => {
  const connection = createRevylConnection(HOST);
  const resolved = connection.resolve({
    flags: {
      platform: 'android',
      device: 'Pixel 8',
      providerOsVersion: '14.0',
      providerApp: 'https://apps.test/app.apk',
    } as CliFlags,
    cwd: '/tmp',
  } as never);

  assert.deepEqual(resolved.profile, {
    leaseProvider: 'revyl',
    platform: 'android',
    device: 'Pixel 8',
    providerApp: 'https://apps.test/app.apk',
    providerOsVersion: '14.0',
  });
  assert.deepEqual(resolved.extraFlags, { providerApp: 'https://apps.test/app.apk' });

  assert.throws(
    () =>
      connection.resolve({
        flags: { platform: 'tv', providerApp: 'https://apps.test/app.apk' },
        cwd: '/tmp',
      } as never),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'unsupported_platform',
  );
});

test('resolve refuses an app that is not a public https URL', () => {
  const connection = createRevylConnection(HOST);
  for (const providerApp of [
    undefined,
    './build/app.ipa',
    'https://user@apps.test/app.zip',
    'https://localhost:8443/app.zip',
    'https://192.168.0.7/app.zip',
    'http://apps.test/app.zip',
  ]) {
    assert.throws(
      () =>
        connection.resolve({
          flags: { platform: 'ios', providerApp } as CliFlags,
          cwd: '/tmp',
        } as never),
      AppError,
      String(providerApp),
    );
  }
});

test('allocation refuses the profile flags Revyl has no field for', () => {
  assert.doesNotThrow(() =>
    rejectRefusedRevylProfileFields({
      flags: { providerApp: 'https://apps.test/a.zip', providerOsVersion: '18.0' },
    }),
  );
  assert.throws(
    () => rejectRefusedRevylProfileFields({ flags: { providerProject: 'team' } }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
  assert.throws(
    () => rejectRefusedRevylProfileFields({ flags: { providerDeviceType: 'real' } }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('a repeat allocation of a live lease still refuses a flag Revyl cannot carry', async () => {
  const fixture = await backend();
  const runtime = fixture.createRuntime();
  await runtime.leaseLifecycle?.allocate?.(revylLease('ios'));
  await assert.rejects(
    async () =>
      await runtime.leaseLifecycle?.allocate?.(revylLease('ios'), {
        flags: { providerTimezone: 'UTC' },
      }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});
