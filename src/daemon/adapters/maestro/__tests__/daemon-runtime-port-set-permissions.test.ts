import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import type { DaemonRequest } from '../../../daemon-request.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

function makePort(requests: DaemonRequest[], platform: 'ios' | 'android') {
  return createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform, replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      return { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
    platform,
  });
}

test('setPermissions sends all as one backend call with specifics after it', async () => {
  const requests: DaemonRequest[] = [];
  const port = makePort(requests, 'android');

  await port.execute({
    command: {
      kind: 'setPermissions',
      source: { line: 3 },
      permissions: { all: 'deny', notifications: 'unset' },
    },
    appId: 'com.example.app',
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual(['settings', 'settings']);
  expect(requests.map(({ positionals }) => positionals)).toEqual([
    ['permission', 'deny', 'all'],
    ['permission', 'reset', 'notifications'],
  ]);
  expect(
    requests.every(({ internal }) => internal?.settingsAppBundleId === 'com.example.app'),
  ).toBe(true);
});

test('a mid-sequence backend rejection names what already landed', async () => {
  const requests: DaemonRequest[] = [];
  let calls = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      calls += 1;
      if (calls === 2) {
        return {
          ok: false,
          error: { code: 'UNSUPPORTED_OPERATION', message: 'No such service on this runtime.' },
        };
      }
      return { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
    platform: 'android',
  });

  const failure = await port
    .execute({
      command: {
        kind: 'setPermissions',
        source: { line: 3 },
        permissions: { all: 'deny', notifications: 'unset' },
      },
      appId: 'com.example.app',
      generation: 0,
      env: {},
      invalidateObservation() {},
    })
    .then(
      () => {
        throw new Error('expected setPermissions to fail');
      },
      (error: unknown) => error,
    );
  expect(requests.map(({ positionals }) => positionals)).toEqual([
    ['permission', 'deny', 'all'],
    ['permission', 'reset', 'notifications'],
  ]);
  assert.match(String((failure as Error).message), /No such service on this runtime/);
  assert.deepEqual(
    (failure as { details?: Record<string, unknown> }).details?.appliedPermissionMutations,
    ['deny all'],
  );
  assert.equal(
    (failure as { details?: Record<string, unknown> }).details?.failedPermissionMutation,
    'reset notifications',
  );
});

test('launchApp applies permissions after clearing but before launch', async () => {
  const requests: DaemonRequest[] = [];
  const port = makePort(requests, 'android');

  await port.execute({
    command: {
      kind: 'launchApp',
      source: { line: 3 },
      appId: 'com.example.app',
      clearState: true,
      permissions: { camera: 'allow' },
    },
    appId: 'com.example.app',
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual(['settings', 'settings', 'open']);
  expect(requests[0]?.positionals).toEqual(['clear-app-state', 'com.example.app']);
  expect(requests[1]?.positionals).toEqual(['permission', 'grant', 'camera']);
  expect(requests[1]?.internal?.settingsAppBundleId).toBe('com.example.app');
  expect(requests[2]?.command).toBe('open');
  expect(requests[2]?.flags).not.toMatchObject({ clearAppState: true });
});

test('launchApp without clearState applies permissions before launch', async () => {
  const requests: DaemonRequest[] = [];
  const port = makePort(requests, 'android');

  await port.execute({
    command: {
      kind: 'launchApp',
      source: { line: 3 },
      appId: 'com.example.app',
      permissions: { camera: 'allow' },
    },
    appId: 'com.example.app',
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual(['settings', 'open']);
  expect(requests[0]?.positionals).toEqual(['permission', 'grant', 'camera']);
  expect(requests[1]?.command).toBe('open');
});

test('launchApp with rejected permissions launches nothing', async () => {
  const requests: DaemonRequest[] = [];
  const port = makePort(requests, 'android');

  await expect(
    port.execute({
      command: {
        kind: 'launchApp',
        source: { line: 3 },
        appId: 'com.example.app',
        clearState: true,
        permissions: { health: 'allow' },
      },
      appId: 'com.example.app',
      generation: 0,
      env: {},
      invalidateObservation() {},
    }),
  ).rejects.toThrow(/health.*not supported on android/i);
  expect(requests).toEqual([]);
});

test('setPermissions without an appId leaves targeting to the session app', async () => {
  const requests: DaemonRequest[] = [];
  const port = makePort(requests, 'ios');

  await port.execute({
    command: {
      kind: 'setPermissions',
      source: { line: 2 },
      permissions: { location: 'always' },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ positionals }) => positionals)).toEqual([
    ['permission', 'grant', 'location-always'],
  ]);
  expect(requests[0]).not.toHaveProperty('internal');
});
