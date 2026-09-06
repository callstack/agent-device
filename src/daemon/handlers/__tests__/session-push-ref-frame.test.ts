import { expect, test, vi } from 'vitest';
import type { InspectDeviceRuntimeFacts } from '../../request-runtime-binding.ts';
import type { DaemonRequest } from '../../daemon-request.ts';
import type { SessionState } from '../../session-state.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
  mockPushNotificationRuntime,
} from './session-command-harness.ts';
import { activateCompleteRefFrame, refFrameState } from '../../ref-frame.ts';

const invoke = async (): Promise<never> => {
  throw new Error('push ref-frame tests must stay on the runtime route');
};

test('push admission failure preserves an active ref frame', async () => {
  const sessionStore = makeSessionStore('agent-device-session-push-ref-admission-');
  const session = activeSession();
  sessionStore.set('default', session);
  const inspectFacts = vi.fn(async (device) => {
    const facts = await mockInspectDeviceRuntimeFacts(device);
    return {
      ...facts,
      operations: {
        ...facts.operations,
        sendPushNotification: {
          available: false as const,
          reason: 'owner-capability-missing' as const,
        },
      },
    };
  }) satisfies InspectDeviceRuntimeFacts;

  const response = await dispatchPush({ sessionStore, inspectFacts });

  expect(response).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_OPERATION' } });
  expect(inspectFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
  expect(refFrameState(session)).toBe('active');
  expect(session.snapshotScopeSource).toBe(session.snapshot);
});

test('push dispatch attempt expires an active ref frame when the bound operation fails', async () => {
  const sessionStore = makeSessionStore('agent-device-session-push-ref-dispatch-');
  const session = activeSession();
  sessionStore.set('default', session);
  mockPushNotificationRuntime.mockRejectedValueOnce(new Error('provider dispatch failed'));

  await expect(dispatchPush({ sessionStore })).rejects.toThrow('provider dispatch failed');

  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).toHaveBeenCalledOnce();
  expect(mockPushNotificationRuntime).toHaveBeenCalledOnce();
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

async function dispatchPush(params: {
  sessionStore: ReturnType<typeof makeSessionStore>;
  inspectFacts?: InspectDeviceRuntimeFacts;
}) {
  const req: DaemonRequest = {
    token: 't',
    session: 'default',
    command: 'push',
    positionals: ['com.example.app', '{}'],
    flags: {},
  };
  return await handleSessionCommands({
    req,
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore: params.sessionStore,
    invoke,
    ...(params.inspectFacts ? { inspectFacts: params.inspectFacts } : {}),
  });
}
