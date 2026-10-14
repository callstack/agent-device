import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { beforeEach, expect, test, vi } from 'vitest';

import path from 'node:path';
import { SessionStore } from '../../../../core/session-store.ts';
import type { DaemonRequest, DaemonResponse } from '../../../../core/daemon-request.ts';
import type { SessionState } from '../../../../core/session-state.ts';
import {
  activateCompleteRefFrame,
  readSessionRuntimeRevision,
  refFrameState,
} from '../../../../core/ref-frame.ts';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';

import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
} from '../../../../__tests__/support/handlers/session-command-harness.ts';
import { lifecycleRuntimeFacts } from '../../../../__tests__/support/application-lifecycle-runtime-harness.ts';
import { dispatchApplicationLifecycleEffect } from '../../../../__tests__/support/application-lifecycle-runtime-fixture.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';

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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: closeRequest(params.sessionName, params.positionals ?? [], params.internal),
    sessionName: params.sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore: params.sessionStore,
    invoke: noopInvoke,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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
  activateCompleteRefFrame(session);
  sessionStore.publish(sessionName, session);
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
  expect(refFrameState(session)).toBe('active');
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
  sessionStore.publish(sessionName, makeSession(sessionName, device));
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
  sessionStore.publish(sessionName, session);
  mockDispatch.mockImplementationOnce(async () => {
    expect(refFrameState(session)).toBe('expired');
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

test('app-only close expires the rebuilt record after admission, preserving the captured snapshot', async () => {
  const sessionStore = makeSessionStore();
  const address = 'cwd:close:default';
  const session = makeSession('default', {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  session.appBundleId = 'com.example.app';
  activateCompleteRefFrame(session);
  const ref = sessionStore.publish(address, session);
  mockInspectDeviceRuntimeFacts.mockImplementationOnce(async (candidate) => {
    sessionStore.update(ref, { appName: 'Updated during admission' });
    return lifecycleRuntimeFacts(candidate);
  });

  const response = await close({
    sessionName: address,
    sessionStore,
    positionals: ['com.example.app'],
    internal: { closeAppOnly: true },
  });

  expect(response?.ok).toBe(true);
  expect(refFrameState(sessionStore.requireCurrent(ref))).toBe('expired');
  expect(sessionStore.requireCurrent(ref).appName).toBe('Updated during admission');
  expect(refFrameState(ref.session)).toBe('active');
  expect(mockDispatch).toHaveBeenCalledOnce();
});
