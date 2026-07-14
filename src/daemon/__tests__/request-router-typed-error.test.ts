import { test, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})) };
});

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, stopIosRunnerSession: vi.fn(async () => {}) };
});

vi.mock('../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import { dispatchCommand } from '../../core/dispatch.ts';
import { createRequestHandler } from '../request-router.ts';
import type { DaemonRequest, SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { AppError, retriableForErrorCode } from '../../kernel/errors.ts';
import { supportedPlatformsForCommand } from '../../core/capabilities.ts';

const mockDispatch = vi.mocked(dispatchCommand);

function makeIosSession(name: string): SessionState {
  return {
    name,
    createdAt: 1_700_000_000_000,
    actions: [],
    device: {
      platform: 'apple',
      target: 'mobile',
      id: 'SIM-001',
      name: 'iPhone 16',
      kind: 'simulator',
      booted: true,
      simulatorSetPath: '/tmp/tenant-a/set',
    },
  };
}

function makeHandler(sessionStore = makeSessionStore('agent-device-router-typed-error-')) {
  return {
    sessionStore,
    handler: createRequestHandler({
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      trackDownloadableArtifact: () => 'artifact-id',
    }),
  };
}

function request(command: string, overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'test-token',
    session: 'typed-error',
    command,
    positionals: [],
    flags: {},
    ...overrides,
  };
}

beforeEach(() => {
  mockDispatch.mockReset();
});

test('retriableForErrorCode is a conservative policy: transient => true, others => undefined', () => {
  expect(retriableForErrorCode('DEVICE_IN_USE')).toBe(true);
  expect(retriableForErrorCode('INVALID_ARGS')).toBeUndefined();
  expect(retriableForErrorCode('UNSUPPORTED_OPERATION')).toBeUndefined();
  expect(retriableForErrorCode('COMMAND_FAILED')).toBeUndefined();
});

test('UNSUPPORTED_OPERATION errors carry supportedOn derived from the capability matrix', async () => {
  const { sessionStore, handler } = makeHandler();
  sessionStore.set('typed-error', makeIosSession('typed-error'));
  mockDispatch.mockRejectedValue(new AppError('UNSUPPORTED_OPERATION', 'nope on this platform'));

  // `home` routes through the (mocked) generic dispatch and is platform-restricted.
  const response = await handler(request('home'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  const expected = supportedPlatformsForCommand('home');
  expect(expected.length).toBeGreaterThan(0); // home is a platform-restricted command
  expect(response.error.supportedOn).toBe(expected.join(', '));
});

test('DEVICE_IN_USE errors are flagged retriable; supportedOn stays absent', async () => {
  const { sessionStore, handler } = makeHandler();
  sessionStore.set('typed-error', makeIosSession('typed-error'));
  mockDispatch.mockRejectedValue(new AppError('DEVICE_IN_USE', 'device busy'));

  const response = await handler(request('home'));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.retriable).toBe(true);
  expect('supportedOn' in response.error).toBe(false);
});

test('deterministic errors (INVALID_ARGS) are returned with the default shape — no typed-error fields', async () => {
  const { sessionStore, handler } = makeHandler();
  sessionStore.set('typed-error', makeIosSession('typed-error'));

  // Conflicting explicit selector under a reject lock policy fails with INVALID_ARGS
  // before dispatch — a deterministic error.
  const response = await handler(
    request('home', { flags: { udid: 'SIM-999' }, meta: { lockPolicy: 'reject' } }),
  );

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect('retriable' in response.error).toBe(false);
  expect('supportedOn' in response.error).toBe(false);
  expect(mockDispatch).not.toHaveBeenCalled();
});

// ADR 0012 decision 6, BLOCKER 2 (second follow-up): a repair-armed `close`
// whose targeted platform close fails must surface `retriable: true` at the
// TOP level of the wire error — the location `enrichDaemonError` below and
// the client actually read (`DaemonError.retriable` in kernel/contracts.ts) —
// and must preserve the underlying platform error's own diagnosticId/logPath/
// details rather than discarding them. Exercised through the REAL router
// boundary (`createRequestHandler`), not just the raw response builder, so a
// regression in either the handler OR `enrichDaemonError`'s own
// `error.retriable ?? retriableForErrorCode(error.code)` fallback is caught.
test('BLOCKER 2 (second follow-up): a repair-close platform-close failure surfaces retriable:true and diagnosticId/logPath/details at the TOP level through the router', async () => {
  const { sessionStore, handler } = makeHandler();
  const session = makeIosSession('typed-error');
  session.recordSession = true;
  session.saveScriptBoundary = 0;
  session.saveScriptComplete = true;
  session.actions = [{ ts: 1, command: 'open', positionals: ['Demo'], flags: {} }];
  sessionStore.set('typed-error', session);

  // DEVICE_NOT_FOUND is not in `retriableForErrorCode`'s conservative allow
  // list — if the handler ever regressed to relying on that code-level
  // fallback instead of forcing `retriable: true` itself, this would catch it.
  mockDispatch.mockRejectedValueOnce(
    new AppError('DEVICE_NOT_FOUND', 'device vanished', {
      diagnosticId: 'diag-router-close-1',
      logPath: '/tmp/router-close-1.log',
      someExtra: 'x',
    }),
  );

  // A targeted close (an explicit positional app target) is what makes the
  // repair-armed platform close actually dispatch instead of no-op.
  const response = await handler(request('close', { positionals: ['com.example.app'] }));

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.retriable).toBe(true);
  expect('retriable' in (response.error.details ?? {})).toBe(false);
  expect(response.error.diagnosticId).toBe('diag-router-close-1');
  expect(response.error.logPath).toBe('/tmp/router-close-1.log');
  expect(response.error.details?.someExtra).toBe('x');
  expect(response.error.code).toBe('DEVICE_NOT_FOUND');
  // The session is retained (not torn down), addressable for the retry.
  expect(sessionStore.get('typed-error')).toBeDefined();
});
