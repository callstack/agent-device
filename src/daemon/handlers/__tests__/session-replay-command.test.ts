import path from 'node:path';
import { expect, test } from 'vitest';
import { LeaseRegistry } from '../../lease-registry.ts';
import {
  unavailableBindDevice,
  unavailableBindExactDevice,
} from '../../__tests__/test-device-runtime-gateway.ts';
import { createScreenRecordingAdmissionLedger } from '../../screen-recording-admission-ledger.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import type { SessionCommandParams } from '../session-command-input.ts';
import { handleReplayTestCommand } from '../session-replay-command.ts';
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
