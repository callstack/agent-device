import { expect, test } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { DaemonRequest } from '../../types.ts';
import {
  makeSession,
  makeSessionStore,
  mockClearRuntimeHints,
  noopInvoke,
} from './session-test-harness.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
} from './session-command-harness.ts';
import { lifecycleRuntimeFacts } from '../../__tests__/application-lifecycle-runtime-harness.ts';
import {
  gestureBindDevice,
  gestureInspectFacts,
  gestureRuntimeSpies,
} from '../../__tests__/test-device-runtime-gateway.ts';

test('runtime set/show/clear manages session-scoped runtime hints before open', async () => {
  const sessionStore = makeSessionStore();
  const baseRequest = {
    token: 't',
    session: 'remote-runtime',
  } satisfies Pick<DaemonRequest, 'token' | 'session'>;

  const setResponse = await handleSessionCommands({
    req: {
      ...baseRequest,
      command: 'runtime',
      positionals: ['set'],
      flags: {
        platform: 'android',
        metroHost: '10.0.0.10',
        metroPort: 8081,
        launchUrl: 'myapp://dev-client',
      },
    },
    sessionName: 'remote-runtime',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(setResponse?.ok).toBe(true);

  const showResponse = await handleSessionCommands({
    req: {
      ...baseRequest,
      command: 'runtime',
      positionals: ['show'],
      flags: {},
    },
    sessionName: 'remote-runtime',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(showResponse?.ok).toBe(true);
  if (showResponse && showResponse.ok) {
    expect(showResponse.data?.configured).toBe(true);
    expect(showResponse.data?.runtime).toEqual({
      platform: 'android',
      metroHost: '10.0.0.10',
      metroPort: 8081,
      bundleUrl: undefined,
      launchUrl: 'myapp://dev-client',
    });
  }

  const clearResponse = await handleSessionCommands({
    req: {
      ...baseRequest,
      command: 'runtime',
      positionals: ['clear'],
      flags: {},
    },
    sessionName: 'remote-runtime',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(clearResponse?.ok).toBe(true);
  expect(sessionStore.getRuntimeHints('remote-runtime')).toBe(undefined);
});

test('runtime clear removes applied transport hints for the active app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-clear-active';
  sessionStore.setRuntimeHints(sessionName, {
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
  });
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.demo',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'runtime',
      positionals: ['clear'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).toHaveBeenCalledTimes(1);
  expect(mockClearRuntimeHints).toHaveBeenCalledWith(
    expect.objectContaining({
      device: expect.objectContaining({ id: 'emulator-5554' }),
      appId: 'com.example.demo',
    }),
  );
  expect(sessionStore.getRuntimeHints(sessionName)).toBe(undefined);
});

test('runtime clear expires the ref frame at the admitted hint mutation boundary', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-clear-ref-frame-seam';
  const session = {
    ...makeSession(sessionName, {
      platform: 'android' as const,
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator' as const,
      booted: true,
    }),
    appBundleId: 'com.example.demo',
  };
  sessionStore.set(sessionName, session);
  sessionStore.setRuntimeHints(sessionName, {
    platform: 'android',
    metroHost: '10.0.2.2',
  });
  mockClearRuntimeHints.mockImplementationOnce(async () => {
    // Planted route witness: deleting the handler's pre-mutation expiry leaves this frame active.
    expect(session.refFrameState).toBe('expired');
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'runtime',
      positionals: ['clear'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(mockClearRuntimeHints).toHaveBeenCalledOnce();
  expect(session.refFrameState).toBe('expired');
});

test('runtime clear rejects a false runtime-hints fact before its one implementation bind', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-clear-false-fact';
  const device = {
    platform: 'android' as const,
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator' as const,
    booted: true,
  };
  sessionStore.setRuntimeHints(sessionName, {
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
  });
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, device),
    appBundleId: 'com.example.demo',
  });
  mockInspectDeviceRuntimeFacts.mockImplementationOnce(async (candidate) => {
    const facts = lifecycleRuntimeFacts(candidate);
    return {
      ...facts,
      operations: {
        ...facts.operations,
        clearRuntimeHints: {
          available: false as const,
          reason: 'unsupported-provider-mode' as const,
          hint: 'Runtime hints are unavailable for this exact provider-owned cell.',
        },
      },
    };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'runtime',
      positionals: ['clear'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'runtime clear is not supported on this device',
    },
  });
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(mockClearRuntimeHints).not.toHaveBeenCalled();
  expect(sessionStore.getRuntimeHints(sessionName)).toEqual({
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
  });
});

test('runtime gesture-viewport admits and binds the exact viewport operation once', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'runtime-gesture-viewport';
  const logPath = path.join(os.tmpdir(), 'runtime-gesture-viewport.log');
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
  );
  gestureRuntimeSpies.gestureViewport.mockClear();

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'runtime',
      positionals: ['gesture-viewport'],
      flags: {},
      meta: { requestId: 'viewport-request' },
    },
    sessionName,
    logPath,
    sessionStore,
    invoke: noopInvoke,
    inspectFacts: gestureInspectFacts,
    bindDevice: gestureBindDevice,
  });

  expect(response).toEqual({
    ok: true,
    data: { viewport: { x: 0, y: 0, width: 390, height: 844 } },
  });
  expect(gestureRuntimeSpies.gestureViewport).toHaveBeenCalledOnce();
  expect(gestureRuntimeSpies.gestureViewport).toHaveBeenCalledWith(
    expect.objectContaining({
      execution: expect.objectContaining({
        requestId: 'viewport-request',
        logPath,
      }),
    }),
  );
});
