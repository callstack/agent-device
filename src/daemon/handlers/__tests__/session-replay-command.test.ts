import path from 'node:path';
import { expect, test } from 'vitest';
import { LeaseRegistry } from '../../lease-registry.ts';
import {
  unavailableBindDevice,
  unavailableBindExactDevice,
} from '../../__tests__/test-device-runtime-gateway.ts';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import type { SessionCommandParams } from '../session-command-input.ts';
import { handleReplayTestCommand, replayInvoke } from '../session-replay-command.ts';
import type { DaemonRequest } from '../../daemon-request.ts';
import { makeSessionStore } from './session-test-harness.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

test('replay test handler threads the complete video owner into the application command', async () => {
  const root = mkdtempForTestSync('agent-device-replay-handler-video-');
  const params: SessionCommandParams = {
    req: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: [path.join(root, 'suite.ad')],
      flags: { recordVideo: true },
      meta: { cwd: root, requestId: 'replay-handler-video' },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore: makeSessionStore(),
    leaseRegistry: new LeaseRegistry(),
    invoke: async () => ({ ok: true, data: {} }),
    bindDevice: unavailableBindDevice,
    bindExactDevice: unavailableBindExactDevice,
    screenRecordingAdmissionLedger: createScreenRecordingAdmissionLedger(),
    requestScope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    retainDeviceExecutionLock: async () => {},
    throwIfCanceled: () => {},
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained' as const,
      reason: 'handler-test' as const,
    }),
    platformResourceCleanup,
  };

  const response = await handleReplayTestCommand(params);

  if (!response || response.ok) throw new Error('Expected a missing-source error response');
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).not.toContain('Screen-recording runtime is not configured');
});

test('replayInvoke re-attaches the originating private half, then folds the dispatch bag over it', async () => {
  const base: DaemonRequest = {
    token: 'token',
    session: 'default',
    command: 'replay',
    positionals: [],
    internal: {
      publicNetworkOnly: true,
      replayTargetGuard: {
        identity: { role: 'button', label: 'Old' },
        structural: { documentOrder: 0, sibling: 0 },
      },
    },
  };
  const invoked: DaemonRequest[] = [];
  const invoke = replayInvoke(async (request) => {
    invoked.push(request);
    return { ok: true, data: {} };
  }, base);

  await invoke({
    token: 'token',
    session: 'default',
    command: 'tap',
    positionals: ['@e1'],
    dispatch: {
      replayPlanStep: true,
      replayTargetGuard: {
        identity: { role: 'button', label: 'New' },
        structural: { documentOrder: 1, sibling: 0 },
      },
    },
  });
  await invoke({ token: 'token', session: 'default', command: 'snapshot', positionals: [] });

  expect(invoked[0]?.internal).toEqual({
    publicNetworkOnly: true,
    replayPlanStep: true,
    replayTargetGuard: {
      identity: { role: 'button', label: 'New' },
      structural: { documentOrder: 1, sibling: 0 },
    },
  });
  expect(invoked[0]).not.toHaveProperty('dispatch');
  expect(invoked[1]?.internal).toEqual(base.internal);
});

test('replayInvoke sends no private half when neither side carries one', async () => {
  const invoked: DaemonRequest[] = [];
  const invoke = replayInvoke(
    async (request) => {
      invoked.push(request);
      return { ok: true, data: {} };
    },
    { token: 'token', session: 'default', command: 'replay', positionals: [] },
  );
  await invoke({ token: 'token', session: 'default', command: 'snapshot', positionals: [] });
  expect(invoked[0]).not.toHaveProperty('internal');
});
