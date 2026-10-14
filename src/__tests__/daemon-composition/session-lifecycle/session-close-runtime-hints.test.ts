import { beforeEach, expect, test, vi } from 'vitest';
import path from 'node:path';
import { SessionStore } from '@agent-device/daemon/testing/session-store';
import type { DaemonRequest, DaemonResponse } from '@agent-device/daemon/daemon-request';
import type { SessionState } from '@agent-device/daemon/testing/session-state';
import { fakeCreateCommandSurface } from '@agent-device/daemon/testing/__tests__/support/command-surface-fake';

// These close cases pin when the REAL composed lifecycle reaches the root runtime-hints module
// (lazy evaluation: only an admitted hint mutation loads it), so they run in the composition lane
// against the real composed lifecycle.
const runtimeHintsModule = vi.hoisted(() => ({
  evaluated: false,
  clearRuntimeHintValues: vi.fn(async () => {}),
}));

vi.mock('../../../platform-runtime-runtime-hints.ts', () => {
  runtimeHintsModule.evaluated = true;
  return { clearRuntimeHintValues: runtimeHintsModule.clearRuntimeHintValues };
});

import { composedPlatformServicesFixture } from '../platform-services-fixture.ts';
import {
  handleSessionCommands as handleHarnessSessionCommands,
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
} from '@agent-device/daemon/testing/handlers/__tests__/session-command-harness';
import { lifecycleRuntimeFacts } from '@agent-device/daemon/testing/__tests__/application-lifecycle-runtime-harness';
import {
  composedLifecycleRuntimeFixture,
  dispatchApplicationLifecycleEffect,
} from '../application-lifecycle-runtime-fixture.ts';

// The harness takes the lifecycle-operations loader per call, exactly like the gateway factories:
// these composition cases pass the REAL composed fixture instead of the daemon's canned default.
const handleSessionCommands = (params: Parameters<typeof handleHarnessSessionCommands>[0]) =>
  handleHarnessSessionCommands({
    ...params,
    lifecycleOperationsLoader: composedLifecycleRuntimeFixture,
  });
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
    platformServices: composedPlatformServicesFixture(),
    req: closeRequest(params.sessionName, params.positionals ?? [], params.internal),
    sessionName: params.sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore: params.sessionStore,
    invoke: noopInvoke,
  });
}

// The load-policy evidence must survive module loading: the mocked factory sets the
// flag when the SUT first imports it, so the FIRST entry into a test may still see a
// false flag only because the SUT imports the runtime-hints operation lazily. If a
// regression made that import eager, the factory would already have run during test
// module loading and this first assertion fails. After that proof, each case resets
// the flag so its own negative assertion measures only its own close.
let eagerEvaluationProofed = false;

beforeEach(() => {
  vi.clearAllMocks();
  if (!eagerEvaluationProofed) {
    expect(runtimeHintsModule.evaluated).toBe(false);
    eagerEvaluationProofed = true;
  }
  runtimeHintsModule.evaluated = false;
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
  sessionStore.publish(sessionName, session);
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
  sessionStore.publish(sessionName, session);
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
  sessionStore.publish(sessionName, session);
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
  sessionStore.publish(sessionName, session);
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
