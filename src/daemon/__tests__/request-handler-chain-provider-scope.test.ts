// Proves the exact androidAdbExecutor reference reaches the session handler
// through the neutral providerScope, and that an empty scope forwards none.
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const handleSessionCommandsMock = vi.fn(async (_params: unknown) => ({ ok: true, data: {} }));
vi.mock('../handlers/session.ts', () => ({
  handleSessionCommands: handleSessionCommandsMock,
}));

import { INTERNAL_COMMANDS } from '../../command-catalog.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { runRequestHandlerChain } from '../request-handler-chain.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import {
  unavailableBindDevice,
  unavailableBindExactDevice,
  unavailableInspectFacts,
} from './test-device-runtime-gateway.ts';
import { createScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';
import type { DaemonRequest } from '../types.ts';
import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';

function makeRequest(command: string, sessionName: string): DaemonRequest {
  return {
    command,
    token: 'test-token',
    session: sessionName,
    positionals: [],
    flags: {},
    meta: { requestId: `req-${command}` },
  };
}

function baseChainParams(sessionName: string) {
  const sessionStore = makeSessionStore('agent-device-provider-scope-');
  sessionStore.set(sessionName, makeIosSession(sessionName));
  return {
    req: makeRequest(INTERNAL_COMMANDS.runtime, sessionName),
    sessionName,
    logPath: '/tmp/agent-device-provider-scope.log',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    invoke: async () => ({ ok: true, data: {} }) as const,
    bindDevice: unavailableBindDevice,
    inspectFacts: unavailableInspectFacts,
    bindExactDevice: unavailableBindExactDevice,
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained' as const,
      reason: 'test-no-recovery',
    }),
    screenRecordingAdmissionLedger: createScreenRecordingAdmissionLedger(),
    requestScope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    retainDeviceExecutionLock: async () => {},
    throwIfCanceled: () => {},
    contextFromFlags: () => ({ logPath: '/tmp/agent-device-provider-scope.log' }),
  };
}

test('the android adb executor from the generic provider scope reaches the session handler by the exact same reference', async () => {
  handleSessionCommandsMock.mockClear();
  const androidAdbExecutor: AndroidAdbExecutor = async () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
  });

  await runRequestHandlerChain({
    ...baseChainParams('provider-scope-test'),
    providerScope: { androidAdbExecutor },
  });

  assert.equal(handleSessionCommandsMock.mock.calls.length, 1);
  const forwardedParams = handleSessionCommandsMock.mock.calls[0]?.[0] as {
    androidAdbExecutor?: AndroidAdbExecutor;
  };
  assert.equal(forwardedParams.androidAdbExecutor, androidAdbExecutor);
});

test('an empty provider scope forwards no android adb executor to the session handler', async () => {
  handleSessionCommandsMock.mockClear();

  await runRequestHandlerChain({
    ...baseChainParams('provider-scope-empty'),
    providerScope: {},
  });

  assert.equal(handleSessionCommandsMock.mock.calls.length, 1);
  const forwardedParams = handleSessionCommandsMock.mock.calls[0]?.[0] as {
    androidAdbExecutor?: AndroidAdbExecutor;
  };
  assert.equal(forwardedParams.androidAdbExecutor, undefined);
});
