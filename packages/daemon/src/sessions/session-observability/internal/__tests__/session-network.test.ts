import { createTestHostEnvironment } from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import path from 'node:path';
import { expect, test } from 'vitest';
import { handleSessionCommands } from '../../../../__tests__/support/handlers/session-command-harness.ts';
import {
  createNetworkRuntime,
  emptyAppLogResult,
} from '../../../../__tests__/support/session-observability/internal/network-runtime-harness.ts';
import {
  makeSession,
  makeSessionStore,
  noopInvoke,
} from '../../../../__tests__/support/handlers/session-test-harness.ts';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';

test('network requires an active session before requesting a runtime binding', async () => {
  const sessionStore = makeSessionStore();

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'missing',
      command: 'network',
      positionals: ['dump'],
      flags: {},
    },
    sessionName: 'missing',
    logPath: path.join(sessionStore.resolveSessionDir('missing'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toEqual({
    ok: false,
    error: { code: 'SESSION_NOT_FOUND', message: 'network requires an active session' },
  });
});

test('network validates the legacy limit after runtime-fact admission', async () => {
  const sessionStore = makeSessionStore();
  const session = makeSession('android-network', {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
  });
  sessionStore.publish(session.name, session);
  const runtime = createNetworkRuntime(session.device, async (input) =>
    emptyAppLogResult('android', input),
  );

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: session.name,
      command: 'network',
      positionals: ['dump', '0'],
      flags: {},
    },
    sessionName: session.name,
    logPath: path.join(sessionStore.resolveSessionDir(session.name), 'daemon.log'),
    sessionStore,
    bindDevice: runtime.bindDevice,
    invoke: noopInvoke,
  });

  expect(response).toEqual({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      message: 'network dump limit must be an integer in range 1..200',
    },
  });
  expect(runtime.uses).toEqual([{ required: [], preferred: ['networkDump'] }]);
  expect(runtime.networkDump).not.toHaveBeenCalled();
});

async function runNetwork(
  command: 'start' | 'stop',
  runtime: ReturnType<typeof createNetworkRuntime>,
  flags: Record<string, unknown> = {},
) {
  const sessionStore = makeSessionStore();
  const session = makeSession('limrun-network', {
    platform: 'apple',
    appleOs: 'ios',
    id: 'limrun:ios:lease-a',
    name: 'Limrun iOS',
    kind: 'simulator',
  });
  session.appBundleId = 'com.example.app';
  sessionStore.publish(session.name, session);
  return await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: session.name,
      command: 'network',
      positionals: [command],
      flags,
    },
    sessionName: session.name,
    logPath: path.join(sessionStore.resolveSessionDir(session.name), 'daemon.log'),
    sessionStore,
    bindDevice: runtime.bindDevice,
    invoke: noopInvoke,
  });
}

const available = { available: true } as const;

test('network start arms the session capture and reports its source and hosts', async () => {
  const runtime = createNetworkRuntime(
    { platform: 'apple', appleOs: 'ios', id: 'limrun:ios:l', name: 'n', kind: 'simulator' },
    async (input) => emptyAppLogResult('android', input),
    available,
    undefined,
    available,
    async () => ({
      started: true as const,
      source: 'limrun-tunnel',
      hosts: ['api.example.com'],
      requiresRelaunch: true,
      capturingBodies: true,
    }),
  );

  const response = await runNetwork('start', runtime, { networkHosts: ['api.example.com'] });

  expect(response).toEqual({
    ok: true,
    data: {
      started: true,
      source: 'limrun-tunnel',
      hosts: ['api.example.com'],
      requiresRelaunch: true,
      capturingBodies: true,
    },
  });
  expect(runtime.networkCaptureStart).toHaveBeenCalledWith({
    sessionId: 'limrun-network',
    appBundleId: 'com.example.app',
    hosts: ['api.example.com'],
  });
  expect(runtime.networkDump).not.toHaveBeenCalled();
});

test('network start refuses with a typed reason on an owner without a capture source', async () => {
  const runtime = createNetworkRuntime(
    { platform: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    async (input) => emptyAppLogResult('android', input),
  );

  const response = await runNetwork('start', runtime);

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      details: { reason: 'owner-capability-missing' },
    },
  });
  expect(runtime.networkCaptureStart).not.toHaveBeenCalled();
});

test('network stop reports the buffer release and refuses without an owner source', async () => {
  const runtime = createNetworkRuntime(
    { platform: 'apple', appleOs: 'ios', id: 'limrun:ios:l', name: 'n', kind: 'simulator' },
    async (input) => emptyAppLogResult('android', input),
    available,
    undefined,
    available,
    undefined,
    async () => ({ stopped: true }),
  );

  expect(await runNetwork('stop', runtime)).toEqual({ ok: true, data: { stopped: true } });

  const withoutSource = createNetworkRuntime(
    { platform: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    async (input) => emptyAppLogResult('android', input),
  );
  expect(await runNetwork('stop', withoutSource)).toMatchObject({
    ok: false,
    error: { code: 'UNSUPPORTED_OPERATION' },
  });
});

test('network start keeps a refused start out of the successful reply shape', async () => {
  const runtime = createNetworkRuntime(
    { platform: 'apple', appleOs: 'ios', id: 'limrun:ios:l', name: 'n', kind: 'simulator' },
    async (input) => emptyAppLogResult('android', input),
    available,
    undefined,
    available,
    async () => ({
      started: false as const,
      reason: 'tunnel-in-use' as const,
      message: 'Limrun tunnel inspection could not start: already_active',
    }),
  );

  const response = await runNetwork('start', runtime);

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'tunnel-in-use' } },
  });
});

test('a capture dump reports the source payload cap, not the app-log constant', async () => {
  const sessionStore = makeSessionStore();
  const session = makeSession('limrun-network-dump', {
    platform: 'apple',
    appleOs: 'ios',
    id: 'limrun:ios:lease-d',
    name: 'Limrun iOS',
    kind: 'simulator',
  });
  sessionStore.publish(session.name, session);
  const runtime = createNetworkRuntime(session.device, async () => ({
    source: 'provider' as const,
    backend: 'limrun-tunnel',
    entries: [],
    notes: [],
    limits: { maxPayloadChars: 400 },
  }));

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: session.name,
      command: 'network',
      positionals: ['dump', '5'],
      flags: {},
    },
    sessionName: session.name,
    logPath: path.join(sessionStore.resolveSessionDir(session.name), 'daemon.log'),
    sessionStore,
    bindDevice: runtime.bindDevice,
    invoke: noopInvoke,
  });

  expect(response).toMatchObject({
    ok: true,
    data: {
      source: 'provider',
      backend: 'limrun-tunnel',
      limits: { maxPayloadChars: 400 },
    },
  });
});

test('network rejects a blank capture host before binding a runtime', async () => {
  const runtime = createNetworkRuntime(
    { platform: 'apple', appleOs: 'ios', id: 'limrun:ios:l', name: 'n', kind: 'simulator' },
    async (input) => emptyAppLogResult('android', input),
    available,
    undefined,
    available,
  );

  const response = await runNetwork('start', runtime, { networkHosts: ['  '] });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', message: expect.stringContaining('--hosts') },
  });
  expect(runtime.networkCaptureStart).not.toHaveBeenCalled();
});
