import { createTestHostEnvironment } from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { expect, test, vi } from 'vitest';
import type { InspectDeviceRuntimeFacts } from '../../../core/request-runtime-binding.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockDeployMaterializedAppRuntime,
  mockInspectDeviceRuntimeFacts,
  mockMaterializeAppSourceRuntime,
} from '../../../__tests__/support/handlers/session-command-harness.ts';
import { activateCompleteRefFrame, refFrameState } from '../../../core/ref-frame.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';

const invoke = async (): Promise<never> => {
  throw new Error('install_source ref-frame tests must stay on the runtime route');
};

test('install_source admission failure preserves an active ref frame', async () => {
  const sessionStore = makeSessionStore('agent-device-session-install-source-ref-admission-');
  const session = activeSession();
  sessionStore.publish('default', session);
  const inspectFacts = vi.fn(async (device) => {
    const facts = await mockInspectDeviceRuntimeFacts(device);
    return {
      ...facts,
      operations: {
        ...facts.operations,
        deployMaterializedApp: {
          available: false as const,
          reason: 'owner-capability-missing' as const,
        },
      },
    };
  }) satisfies InspectDeviceRuntimeFacts;

  const response = await dispatchInstallSource({ sessionStore, inspectFacts });

  expect(response).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } });
  expect(inspectFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(refFrameState(session)).toBe('active');
  expect(session.snapshotScopeSource).toBe(session.snapshot);
});

test('install_source materialization failure preserves an active ref frame', async () => {
  const sessionStore = makeSessionStore('agent-device-session-install-source-ref-materialization-');
  const session = activeSession();
  sessionStore.publish('default', session);
  mockMaterializeAppSourceRuntime.mockRejectedValueOnce(new Error('artifact download failed'));

  const response = await dispatchInstallSource({ sessionStore });

  expect(response).toMatchObject({ ok: false });
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).toHaveBeenCalledOnce();
  expect(mockMaterializeAppSourceRuntime).toHaveBeenCalledOnce();
  expect(mockDeployMaterializedAppRuntime).not.toHaveBeenCalled();
  expect(refFrameState(session)).toBe('active');
  expect(session.snapshotScopeSource).toBe(session.snapshot);
});

test('install_source deploy attempt expires an active ref frame when the bound operation fails', async () => {
  const sessionStore = makeSessionStore('agent-device-session-install-source-ref-deploy-');
  const session = activeSession();
  sessionStore.publish('default', session);
  mockDeployMaterializedAppRuntime.mockImplementationOnce(async () => {
    expect(refFrameState(session)).toBe('expired');
    expect(session.snapshotScopeSource).toBeUndefined();
    throw new Error('provider deployment failed');
  });

  const response = await dispatchInstallSource({ sessionStore });

  expect(response).toMatchObject({ ok: false });
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).toHaveBeenCalledOnce();
  expect(mockMaterializeAppSourceRuntime).toHaveBeenCalledOnce();
  expect(mockDeployMaterializedAppRuntime).toHaveBeenCalledOnce();
  expect(refFrameState(session)).toBe('expired');
  expect(session.snapshotScopeSource).toBeUndefined();
});

function activeSession(): SessionState {
  const snapshot = { createdAt: Date.now(), nodes: [] };
  const session: SessionState = {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    },
    snapshot,
    snapshotScopeSource: snapshot,
  };
  activateCompleteRefFrame(session);
  return session;
}

async function dispatchInstallSource(params: {
  sessionStore: ReturnType<typeof makeSessionStore>;
  inspectFacts?: InspectDeviceRuntimeFacts;
}) {
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'install_source',
    positionals: [],
    flags: {},
    meta: { installSource: { kind: 'path', path: '/tmp/App.apk' } },
  };
  return await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req,
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: params.sessionStore,
    invoke,
    ...(params.inspectFacts ? { inspectFacts: params.inspectFacts } : {}),
  });
}
