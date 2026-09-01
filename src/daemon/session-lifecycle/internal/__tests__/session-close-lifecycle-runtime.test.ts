import { beforeEach, expect, test, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../../types.ts';
import { readSessionRuntimeRevision } from '../../../ref-frame.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

const runtimeHintsModule = vi.hoisted(() => ({
  evaluated: false,
  clearRuntimeHintValues: vi.fn(async () => {}),
}));

vi.mock('../../../../platform-runtime-runtime-hints.ts', () => {
  runtimeHintsModule.evaluated = true;
  return { clearRuntimeHintValues: runtimeHintsModule.clearRuntimeHintValues };
});

import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
} from '../../../handlers/__tests__/session-command-harness.ts';
import { lifecycleRuntimeFacts } from '../../../__tests__/application-lifecycle-runtime-harness.ts';
import { dispatchApplicationLifecycleEffect } from '../../../__tests__/application-lifecycle-runtime-fixture.ts';

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({ ok: true, data: {} });

function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-session-close-lifecycle-runtime-');
  return new SessionStore(path.join(root, 'sessions'));
}

function makeSession(name: string, device: SessionState['device']): SessionState {
  return { name, device, createdAt: Date.now(), actions: [] };
}

function closeRequest(
  session: string,
  positionals: string[],
  internal?: DaemonRequest['internal'],
) {
  return {
    token: 't',
    session,
    command: 'close' as const,
    positionals,
    flags: {},
    ...(internal === undefined ? {} : { internal }),
  };
}

async function close(params: {
  sessionName: string;
  sessionStore: SessionStore;
  positionals?: string[];
  internal?: DaemonRequest['internal'];
}) {
  return await handleSessionCommands({
    req: closeRequest(params.sessionName, params.positionals ?? [], params.internal),
    sessionName: params.sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore: params.sessionStore,
    invoke: noopInvoke,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeHintsModule.evaluated = false;
});

test('an app-only close without a target fails before admission or ref-frame expiry', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-app-only-close-without-target';
  const device = {
    platform: 'android' as const,
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator' as const,
    target: 'mobile' as const,
    booted: true,
  };
  const session = makeSession(sessionName, device);
  session.refFrameState = 'active';
  sessionStore.set(sessionName, session);
  const revisionBeforeClose = readSessionRuntimeRevision(session);

  const response = await close({
    sessionName,
    sessionStore,
    internal: { closeAppOnly: true },
  });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', message: 'App-only close requires an app target' },
  });
  expect(mockInspectDeviceRuntimeFacts).not.toHaveBeenCalled();
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(readSessionRuntimeRevision(session)).toBe(revisionBeforeClose);
  expect(session.refFrameState).toBe('active');
  expect(sessionStore.get(sessionName)).toBe(session);
});

test('close rejects a false close-target fact before its one implementation bind', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'close-false-fact';
  const device = {
    platform: 'android' as const,
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator' as const,
    booted: true,
  };
  sessionStore.set(sessionName, makeSession(sessionName, device));
  mockInspectDeviceRuntimeFacts.mockImplementationOnce(async (candidate) => {
    const facts = lifecycleRuntimeFacts(candidate);
    const unavailable = {
      available: false as const,
      reason: 'unsupported-provider-mode' as const,
      hint: 'Close is unavailable for this exact provider-owned cell.',
    };
    return {
      ...facts,
      operations: {
        ...facts.operations,
        closeApplication: unavailable,
        finalizeApplicationClose: unavailable,
      },
    };
  });

  const response = await close({ sessionName, sessionStore, positionals: ['com.example.demo'] });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'UNSUPPORTED_OPERATION', message: 'close is not supported on this device' },
  });
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)).toMatchObject({ name: sessionName });
});

test('a close-capable runtime with false runtime-hints facts never loads the runtime-hints operation', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'harmony-close-without-runtime-hints';
  const device = {
    platform: 'harmonyos' as const,
    id: 'harmony-device-1',
    name: 'Harmony device',
    kind: 'device' as const,
    target: 'mobile' as const,
    booted: true,
  };
  const session = makeSession(sessionName, device);
  session.appBundleId = 'com.example.harmony';
  sessionStore.set(sessionName, session);
  mockInspectDeviceRuntimeFacts.mockImplementationOnce(async (candidate) => {
    const facts = lifecycleRuntimeFacts(candidate);
    return {
      ...facts,
      operations: {
        ...facts.operations,
        clearRuntimeHints: {
          available: false as const,
          reason: 'unsupported-platform-leaf' as const,
        },
      },
    };
  });

  const response = await close({
    sessionName,
    sessionStore,
    positionals: ['com.example.harmony'],
  });

  expect(response?.ok).toBe(true);
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).toHaveBeenCalledTimes(1);
  expect(mockDispatch).toHaveBeenCalledOnce();
  expect(runtimeHintsModule.evaluated).toBe(false);
  expect(runtimeHintsModule.clearRuntimeHintValues).not.toHaveBeenCalled();
});

test('an app-only close with stored hints selects no runtime-hint cleanup sibling', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-app-only-close-stored-runtime-hints';
  const device = {
    platform: 'android' as const,
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator' as const,
    target: 'mobile' as const,
    booted: true,
  };
  const session = makeSession(sessionName, device);
  session.appBundleId = 'com.example.app';
  sessionStore.set(sessionName, session);
  sessionStore.setRuntimeHints(sessionName, { platform: 'android', metroHost: '10.0.2.2' });
  mockInspectDeviceRuntimeFacts.mockImplementationOnce(async (candidate) => {
    const facts = lifecycleRuntimeFacts(candidate);
    return {
      ...facts,
      operations: {
        ...facts.operations,
        clearRuntimeHints: {
          available: false as const,
          reason: 'unsupported-provider-mode' as const,
        },
      },
    };
  });

  const response = await close({
    sessionName,
    sessionStore,
    positionals: ['com.example.app'],
    internal: { closeAppOnly: true },
  });

  expect(response?.ok).toBe(true);
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).toHaveBeenCalledTimes(1);
  expect(mockDispatch).toHaveBeenCalledOnce();
  expect(runtimeHintsModule.evaluated).toBe(false);
  expect(runtimeHintsModule.clearRuntimeHintValues).not.toHaveBeenCalled();
  expect(sessionStore.getRuntimeHints(sessionName)).toEqual({
    platform: 'android',
    metroHost: '10.0.2.2',
  });
});

test('a close with persisted native hints fails closed when the distinct cleanup fact is false', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-close-stale-runtime-hints';
  const device = {
    platform: 'apple' as const,
    appleOs: 'ios' as const,
    id: 'ios-device-1',
    name: 'iPhone',
    kind: 'device' as const,
    target: 'mobile' as const,
    booted: true,
  };
  const session = makeSession(sessionName, device);
  session.appBundleId = 'com.example.app';
  sessionStore.set(sessionName, session);
  sessionStore.setRuntimeHints(sessionName, { platform: 'ios', metroHost: '10.0.2.2' });
  mockInspectDeviceRuntimeFacts.mockImplementationOnce(async (candidate) => {
    const facts = lifecycleRuntimeFacts(candidate);
    return {
      ...facts,
      operations: {
        ...facts.operations,
        clearRuntimeHints: {
          available: false as const,
          reason: 'unsupported-device-kind' as const,
        },
      },
    };
  });

  const response = await close({ sessionName, sessionStore });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'UNSUPPORTED_OPERATION', message: 'close is not supported on this device' },
  });
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
  expect(runtimeHintsModule.evaluated).toBe(false);
  expect(sessionStore.get(sessionName)).toMatchObject({ name: sessionName });
});

test('a supported Android close clears admitted runtime hints exactly once', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-close-runtime-hints';
  const device = {
    platform: 'android' as const,
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator' as const,
    target: 'mobile' as const,
    booted: true,
  };
  const session = makeSession(sessionName, device);
  session.appBundleId = 'com.example.app';
  sessionStore.set(sessionName, session);
  sessionStore.setRuntimeHints(sessionName, {
    platform: 'android',
    metroHost: '10.0.2.2',
    metroPort: 8081,
  });

  const response = await close({ sessionName, sessionStore });

  expect(response?.ok).toBe(true);
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).toHaveBeenCalledTimes(1);
  expect(runtimeHintsModule.evaluated).toBe(true);
  expect(runtimeHintsModule.clearRuntimeHintValues).toHaveBeenCalledOnce();
  expect(runtimeHintsModule.clearRuntimeHintValues).toHaveBeenCalledWith(
    expect.objectContaining({
      device,
      appId: 'com.example.app',
      values: expect.objectContaining({ metroHost: '10.0.2.2', metroPort: '8081' }),
    }),
  );
});

test('close expires the ref frame immediately before its admitted platform mutation', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'close-ref-frame-seam';
  const device = {
    platform: 'android' as const,
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator' as const,
    target: 'mobile' as const,
    booted: true,
  };
  const session = makeSession(sessionName, device);
  session.appBundleId = 'com.example.app';
  sessionStore.set(sessionName, session);
  mockDispatch.mockImplementationOnce(async () => {
    expect(session.refFrameState).toBe('expired');
  });

  const response = await close({
    sessionName,
    sessionStore,
    positionals: ['com.example.app'],
    internal: { closeAppOnly: true },
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledOnce();
});
