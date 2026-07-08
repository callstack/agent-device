import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  AgentDeviceBackend,
  BackendAppEvent,
  BackendOpenTarget,
  BackendPushInput,
} from '../../../backend.ts';
import type { JsonObject } from '../../../contracts/json.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  localCommandPolicy,
  restrictedCommandPolicy,
} from '../../../runtime.ts';

test('runtime app commands call typed backend lifecycle primitives', async () => {
  const calls: unknown[] = [];
  const device = createAgentDevice({
    backend: createAppsBackend(calls),
    artifacts: createLocalArtifactAdapter(),
    policy: localCommandPolicy(),
  });

  const opened = await device.apps.open({
    session: 'default',
    app: ' com.example.app ',
    launchArgs: ['-FeatureFlag', 'YES'],
    relaunch: true,
  });
  assert.deepEqual(opened, {
    kind: 'appOpened',
    target: { app: 'com.example.app' },
    relaunch: true,
    backendResult: { opened: true },
    message: 'Opened: com.example.app',
  });

  const closed = await device.apps.close({ app: 'com.example.app' });
  assert.equal(closed.kind, 'appClosed');

  const listed = await device.apps.list();
  assert.deepEqual(listed.apps, [
    {
      id: 'com.example.app',
      name: 'Example',
      bundleId: 'com.example.app',
    },
  ]);

  const state = await device.apps.state({ app: 'com.example.app' });
  assert.deepEqual(state.state, { bundleId: 'com.example.app', state: 'foreground' });

  const pushed = await device.apps.push({
    app: 'com.example.app',
    input: { kind: 'json', payload: { aps: { alert: 'hello' } } },
  });
  assert.equal(pushed.inputKind, 'json');

  const triggered = await device.apps.triggerEvent({
    name: 'example.ready',
    payload: { source: 'test' },
  });
  assert.equal(triggered.name, 'example.ready');

  assert.deepEqual(calls, [
    {
      command: 'openApp',
      target: { app: 'com.example.app' },
      options: { launchArgs: ['-FeatureFlag', 'YES'], relaunch: true },
      session: 'default',
    },
    { command: 'closeApp', app: 'com.example.app' },
    { command: 'listApps', filter: 'user-installed' },
    { command: 'getAppState', app: 'com.example.app' },
    {
      command: 'pushFile',
      target: 'com.example.app',
      input: { kind: 'json', payload: { aps: { alert: 'hello' } } },
    },
    {
      command: 'triggerAppEvent',
      event: { name: 'example.ready', payload: { source: 'test' } },
    },
  ]);
});

test('runtime app push rejects local payload paths under restricted policy', async () => {
  let pushCalled = false;
  const device = createAgentDevice({
    backend: {
      ...createAppsBackend([]),
      pushFile: async () => {
        pushCalled = true;
      },
    },
    artifacts: createLocalArtifactAdapter(),
    policy: restrictedCommandPolicy(),
  });

  await assert.rejects(
    () =>
      device.apps.push({
        app: 'com.example.app',
        input: { kind: 'path', path: '/tmp/payload.json' },
      }),
    /Local input paths are not allowed/,
  );
  assert.equal(pushCalled, false);
});

test('runtime app commands reject invalid event names', async () => {
  const device = createAgentDevice({
    backend: createAppsBackend([]),
    artifacts: createLocalArtifactAdapter(),
    policy: localCommandPolicy(),
  });

  await assert.rejects(
    () => device.apps.triggerEvent({ name: 'bad event' }),
    /Invalid apps\.triggerEvent name/,
  );
});

test('runtime app push validates JSON payloads', async () => {
  const device = createAppsRuntimeDevice();

  await assert.rejects(
    () =>
      device.apps.push({
        app: 'com.example.app',
        input: { kind: 'json', payload: [] as unknown as JsonObject },
      }),
    /JSON payload must be a JSON object/,
  );
  await assert.rejects(
    () =>
      device.apps.push({
        app: 'com.example.app',
        input: {
          kind: 'json',
          payload: { count: 1n } as unknown as JsonObject,
        },
      }),
    /JSON payload must be JSON-serializable/,
  );
  await assert.rejects(
    () =>
      device.apps.push({
        app: 'com.example.app',
        input: {
          kind: 'json',
          payload: { toJSON: () => undefined } as unknown as JsonObject,
        },
      }),
    /JSON payload must be JSON-serializable/,
  );
  await assert.rejects(
    () =>
      device.apps.push({
        app: 'com.example.app',
        input: {
          kind: 'json',
          payload: { data: 'x'.repeat(8 * 1024) },
        },
      }),
    /JSON payload exceeds 8192 bytes/,
  );
  await assert.rejects(
    () =>
      device.apps.push({
        app: 'com.example.app',
        input: undefined as unknown as Parameters<typeof device.apps.push>[0]['input'],
      }),
    /apps\.push requires an input/,
  );
});

test('runtime app events validate JSON payloads', async () => {
  const device = createAppsRuntimeDevice();

  await assert.rejects(
    () =>
      device.apps.triggerEvent({
        name: 'example.ready',
        payload: { count: 1n } as unknown as JsonObject,
      }),
    /payload for "example.ready" must be JSON-serializable/,
  );
  await assert.rejects(
    () =>
      device.apps.triggerEvent({
        name: 'example.ready',
        payload: { toJSON: () => undefined } as unknown as JsonObject,
      }),
    /payload for "example.ready" must be JSON-serializable/,
  );
  await assert.rejects(
    () =>
      device.apps.triggerEvent({
        name: 'example.ready',
        payload: { data: 'x'.repeat(8 * 1024) },
      }),
    /payload for "example.ready" exceeds 8192 bytes/,
  );
});

function createAppsRuntimeDevice() {
  return createAgentDevice({
    backend: createAppsBackend([]),
    artifacts: createLocalArtifactAdapter(),
    policy: localCommandPolicy(),
  });
}

function createAppsBackend(calls: unknown[]): AgentDeviceBackend {
  return {
    platform: 'ios',
    openApp: async (context, target: BackendOpenTarget, options) => {
      calls.push({
        command: 'openApp',
        target,
        options,
        session: context.session,
      });
      return { opened: true };
    },
    closeApp: async (_context, app) => {
      calls.push({ command: 'closeApp', app });
    },
    listApps: async (_context, filter) => {
      calls.push({ command: 'listApps', filter });
      return [{ id: 'com.example.app', name: 'Example', bundleId: 'com.example.app' }];
    },
    getAppState: async (_context, app) => {
      calls.push({ command: 'getAppState', app });
      return { bundleId: app, state: 'foreground' };
    },
    pushFile: async (_context, input: BackendPushInput, target) => {
      calls.push({ command: 'pushFile', target, input });
    },
    triggerAppEvent: async (_context, event: BackendAppEvent) => {
      calls.push({ command: 'triggerAppEvent', event });
    },
  };
}
