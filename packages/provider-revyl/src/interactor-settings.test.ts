import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import {
  revylLease,
  startRevylFixtureBackend,
  type RevylFixtureBackend,
} from './revyl-backend.fixtures.ts';

const openBackends: RevylFixtureBackend[] = [];

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((fixture) => fixture.close()));
});

/** The interactor of one live session against a fake Revyl backend, with that backend. */
async function liveInteractor(
  platform: 'ios' | 'android',
  options?: Parameters<typeof startRevylFixtureBackend>[0],
): Promise<Readonly<{ fixture: RevylFixtureBackend; interactor: Interactor }>> {
  const fixture = await startRevylFixtureBackend(options);
  openBackends.push(fixture);
  const runtime = fixture.createRuntime();
  await runtime.leaseLifecycle?.allocate?.(revylLease(platform));
  const device = (
    await runtime.deviceInventoryProvider?.({
      leaseProvider: 'revyl',
      leaseId: 'lease-1',
      platform,
    })
  )?.[0];
  if (!device) throw new Error('Expected the live session to be listed.');
  const interactor = runtime.getInteractor(device);
  if (!interactor) throw new Error('Expected a live session interactor.');
  return { fixture, interactor };
}

const refusedForMode = (error: unknown) =>
  error instanceof AppError && error.details?.reason === 'unsupported-provider-mode';

test('orientation sends the worker name of each rotation on a worker that rotates precisely', async () => {
  const { fixture, interactor } = await liveInteractor('android', { preciseOrientation: true });
  assert.deepEqual(await interactor.setOrientation('landscape-left'), {
    orientation: 'landscape-left',
  });
  await interactor.setOrientation('portrait-upside-down');

  assert.deepEqual(
    fixture.requests
      .filter((request) => request.path.endsWith('/set_orientation'))
      .map((request) => request.body),
    [{ orientation: 'landscape_left' }, { orientation: 'upside_down' }],
  );
});

test('a worker without precise orientation rotates to portrait and landscape-left only', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  await interactor.setOrientation('portrait');
  await interactor.setOrientation('landscape-left');
  for (const orientation of ['landscape-right', 'portrait-upside-down'] as const) {
    await assert.rejects(interactor.setOrientation(orientation), refusedForMode);
  }
  assert.deepEqual(
    fixture.requests
      .filter((request) => request.path.endsWith('/set_orientation'))
      .map((request) => request.body),
    [{ orientation: 'portrait' }, { orientation: 'landscape' }],
  );
});

test('appearance sets the named mode, and toggle flips the mode the worker reports', async () => {
  const { fixture, interactor } = await liveInteractor('ios', {
    respond: {
      'GET /api/v1/execution/device-proxy/run-1/appearance': { body: { appearance: 'dark' } },
    },
  });
  assert.deepEqual(await interactor.setSetting('appearance', 'dark'), { appearance: 'dark' });
  assert.deepEqual(await interactor.setSetting('appearance', 'toggle'), { appearance: 'light' });

  assert.deepEqual(
    fixture.requests
      .filter((request) => request.path.endsWith('/set_appearance'))
      .map((request) => request.body),
    [{ appearance: 'dark' }, { appearance: 'light' }],
  );
});

test('location sets the coordinates, answers on as already on, and refuses switching it off', async () => {
  const { fixture, interactor } = await liveInteractor('android');
  assert.deepEqual(await interactor.setSetting('location', 'on'), { enabled: true });
  await interactor.setSetting('location', 'set', undefined, { latitude: 43.65, longitude: -79.38 });
  await assert.rejects(interactor.setSetting('location', 'off'), refusedForMode);

  assert.deepEqual(fixture.bodyFor('set_location'), { latitude: 43.65, longitude: -79.38 });
  assert.equal(fixture.paths().filter((request) => request.endsWith('/set_location')).length, 1);
});

test('a permission change names the app and the Maestro permission the worker takes', async () => {
  const { fixture, interactor } = await liveInteractor('android');
  await interactor.setSetting('permission', 'grant', 'com.example.app', {
    permissionTarget: 'media-library',
  });
  await interactor.setSetting('permission', 'reset', 'com.example.app', {
    permissionTarget: 'camera',
  });

  assert.deepEqual(
    fixture.requests
      .filter((request) => request.path.endsWith('/set_permissions'))
      .map((request) => request.body),
    [
      { bundle_id: 'com.example.app', permissions: { medialibrary: 'allow' } },
      { bundle_id: 'com.example.app', permissions: { camera: 'unset' } },
    ],
  );
});

test('a permission without a Maestro name, or with a mode, is refused before the worker', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  for (const options of [
    { permissionTarget: 'location-always' },
    { permissionTarget: 'photos', permissionMode: 'limited' },
  ]) {
    await assert.rejects(
      interactor.setSetting('permission', 'grant', 'com.example.app', options),
      refusedForMode,
    );
  }
  assert.equal(
    fixture.paths().some((request) => request.endsWith('/set_permissions')),
    false,
  );
});

test('an app setting falls back to the launched app and refuses when none is known', async () => {
  const { fixture, interactor } = await liveInteractor('ios');
  await assert.rejects(
    interactor.setSetting('clear-app-state', 'clear'),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
  await interactor.open('com.example.app');
  await interactor.setSetting('clear-app-state', 'clear');
  await interactor.setSetting('reset-keychain', 'clear');

  assert.deepEqual(fixture.bodyFor('clear_app_state'), { bundle_id: 'com.example.app' });
  assert.equal(fixture.paths().at(-1), 'POST /api/v1/execution/device-proxy/run-1/clear_keychain');
});

test('a setting the worker has no action for is refused rather than sent', async () => {
  const { fixture, interactor } = await liveInteractor('android');
  await assert.rejects(interactor.setSetting('airplane', 'on'), refusedForMode);
  assert.equal(
    fixture.paths().some((request) => request.includes('airplane')),
    false,
  );
});
