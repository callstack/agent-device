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
  assert.deepEqual(result.device, {
    status: 'configured',
    name: 'iPhone 16',
    platform: 'ios',
    osVersion: '18.0',
    message: result.device.message,
  });
  assert.equal(result.app?.status, 'configured');
  assert.equal(result.app?.reference, 'https://apps.test/app.zip');
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
  for (const providerApp of [undefined, './build/app.ipa', 'https://user@apps.test/app.zip']) {
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
