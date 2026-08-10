import path from 'node:path';
import { expect, test } from 'vitest';
import { providerRuntimeOwner } from '@agent-device/contracts/platform';
import type { BindDeviceRuntime } from '../../request-runtime-binding.ts';
import { handleSessionCommands } from '../session.ts';
import {
  makeSession,
  makeSessionStore,
  makeTestAppLogResource,
  noopInvoke,
} from './session-test-harness.ts';
import { NETWORK_RUNTIME_PROJECTION_PARITY } from './session-network-runtime-parity-fixtures.ts';
import { createNetworkRuntime, emptyAppLogResult } from './network-runtime-harness.ts';

test.each(NETWORK_RUNTIME_PROJECTION_PARITY)(
  'network $action preserves the $include projection through the request runtime',
  async ({ action, include }) => {
    const sessionName = `network-${action}-${include}`;
    const sessionStore = makeSessionStore();
    const session = makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    });
    sessionStore.set(sessionName, {
      ...session,
      appBundleId: 'com.example.app',
      appLog: makeTestAppLogResource(session, {
        backend: 'android',
        state: 'active',
        startedAt: 123,
        outputPath: sessionStore.resolveAppLogPath(sessionName),
      }),
    });

    const result = {
      source: 'app-log' as const,
      backend: 'android' as const,
      dump: {
        path: sessionStore.resolveAppLogPath(sessionName),
        exists: true,
        scannedLines: 1,
        matchedLines: 1,
        entries: [
          {
            method: 'GET',
            url: `https://example.test/${action}/${include}`,
            raw: 'GET https://example.test',
            line: 1,
          },
        ],
        include,
        limits: { maxEntries: 7, maxPayloadChars: 2048, maxScanLines: 4000 },
      },
      notes: ['runtime-owned capture'],
    };
    const runtime = createNetworkRuntime(session.device, async () => result);

    const response = await handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'network',
        positionals: [action, '7', include],
        flags: {},
      },
      sessionName,
      logPath: path.join(sessionStore.resolveSessionDir(sessionName), 'daemon.log'),
      sessionStore,
      bindDevice: runtime.bindDevice,
      invoke: noopInvoke,
    });

    expect(response?.ok).toBe(true);
    if (!response?.ok) return;
    expect(response.data?.entries).toEqual([
      expect.objectContaining({ url: `https://example.test/${action}/${include}` }),
    ]);
    expect(response.data?.include).toBe(include);
    expect(response.data?.notes).toContain('runtime-owned capture');
    expect(runtime.uses).toEqual([
      { required: [], preferred: ['networkDump'] },
      { required: ['networkDump'], preferred: [] },
    ]);
    expect(runtime.networkDump).toHaveBeenCalledWith({
      sessionId: sessionName,
      appBundleId: 'com.example.app',
      appLogSnapshot: { state: 'active', startedAt: 123 },
      maxEntries: 7,
      include,
      maxPayloadChars: 2048,
      maxScanLines: 4000,
    });
  },
);

test('network admission remains fail-closed before parsing invalid input', async () => {
  const sessionStore = makeSessionStore();
  const session = makeSession('unsupported', {
    platform: 'harmonyos',
    id: 'harmony-device',
    name: 'Harmony device',
    kind: 'device',
  });
  sessionStore.set(session.name, session);
  const runtime = createNetworkRuntime(session.device, async () => emptyAppLogResult('harmonyos'), {
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: 'Network capture is unavailable for this platform leaf.',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: session.name,
      command: 'network',
      positionals: ['not-an-action'],
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
      code: 'UNSUPPORTED_OPERATION',
      message: 'network is not supported on this device',
      hint: 'Network capture is unavailable for this platform leaf.',
    },
  });
  expect(runtime.uses).toEqual([{ required: [], preferred: ['networkDump'] }]);
  expect(runtime.networkDump).not.toHaveBeenCalled();
});

test('an explicit web provider preserves empty-success projection', async () => {
  const sessionStore = makeSessionStore();
  const session = makeSession('web-provider', {
    platform: 'web',
    id: 'browser',
    name: 'Browser',
    kind: 'device',
    target: 'desktop',
  });
  sessionStore.set(session.name, session);
  const runtime = createNetworkRuntime(
    session.device,
    async () => ({ source: 'provider', backend: 'agent-browser', entries: [], notes: [] }),
    { available: true },
    providerRuntimeOwner('web', 'default'),
  );

  const response = await runNetwork(session.name, sessionStore, runtime.bindDevice);

  expect(response).toMatchObject({
    ok: true,
    data: {
      active: true,
      state: 'active',
      backend: 'agent-browser',
      entries: [],
      include: 'summary',
      matchedLines: 0,
      scannedLines: 0,
    },
  });
});

test.each(['browserstack', 'aws-device-farm', 'limrun'] as const)(
  '%s exact provider preserves canonical app-log empty success',
  async (provider) => {
    const sessionStore = makeSessionStore();
    const session = makeSession(provider, {
      platform: 'android',
      id: `${provider}-device`,
      name: `${provider} device`,
      kind: 'device',
    });
    sessionStore.set(session.name, session);
    const runtime = createNetworkRuntime(
      session.device,
      async () => emptyAppLogResult('android'),
      { available: true },
      providerRuntimeOwner(provider, 'default'),
    );

    const response = await runNetwork(session.name, sessionStore, runtime.bindDevice);

    expect(response).toMatchObject({
      ok: true,
      data: {
        active: false,
        state: 'inactive',
        backend: 'android',
        entries: [],
      },
    });
  },
);

async function runNetwork(
  sessionName: string,
  sessionStore: ReturnType<typeof makeSessionStore>,
  bindDevice: BindDeviceRuntime,
) {
  return await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump'],
      flags: {},
    },
    sessionName,
    logPath: path.join(sessionStore.resolveSessionDir(sessionName), 'daemon.log'),
    sessionStore,
    bindDevice,
    invoke: noopInvoke,
  });
}
