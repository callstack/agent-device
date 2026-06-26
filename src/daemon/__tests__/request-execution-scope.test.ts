import { afterAll, test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushDiagnosticsToSessionFile, withDiagnosticsScope } from '../../utils/diagnostics.ts';
import {
  makeAndroidSession,
  makeIosSession,
  makeSession,
} from '../../__tests__/test-utils/session-factories.ts';
import { LINUX_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { clearRequestCanceled, markRequestCanceled } from '../request-cancel.ts';
import {
  createRequestExecutionScope,
  prepareLockedRequestScope,
} from '../request-execution-scope.ts';
import { resolveSessionRequestLogPath } from '../session-store.ts';
import type { DaemonRequest } from '../types.ts';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-request-execution-scope-'));
const LOG_PATH = path.join(TEST_ROOT, 'diagnostics.log');

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

test('createRequestExecutionScope applies tenant scoping and lease admission', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    deviceKey: 'ios:sim-1',
  });

  const scope = await createRequestExecutionScope({
    req: makeRequest({
      session: 'default',
      command: 'snapshot',
      meta: {
        tenantId: 'tenant-a',
        runId: 'run-1',
        leaseId: lease.leaseId,
        sessionIsolation: 'tenant',
      },
    }),
    sessionStore,
    leaseRegistry,
  });

  expect(scope.req.session).toBe('tenant-a:default');
  expect(scope.req.meta?.tenantId).toBe('tenant-a');
  expect(scope.sessionName).toBe('tenant-a:default');
});

test('createRequestExecutionScope resolves session-scoped request and runner log paths', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const cwd = fs.mkdtempSync(path.join(TEST_ROOT, 'cwd-scope-'));
  fs.mkdirSync(path.join(cwd, '.git'));

  const scope = await withDiagnosticsScope(
    { command: 'snapshot', requestId: 'request-logs-1', logPath: LOG_PATH },
    async () =>
      await createRequestExecutionScope({
        req: makeRequest({ meta: { cwd, requestId: 'request-logs-1' } }),
        sessionStore,
        leaseRegistry: new LeaseRegistry(),
      }),
  );

  expect(scope.sessionName).toMatch(/^cwd:[a-f0-9]{16}:default$/);
  expect(scope.requestLogPath).toMatch(
    /cwd_[a-f0-9]{16}_default\/requests\/request-logs-1\.ndjson$/,
  );
  expect(scope.runnerLogPath).toMatch(/cwd_[a-f0-9]{16}_default\/runner\.log$/);
});

test('request diagnostics flush into the effective session request log', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const cwd = fs.mkdtempSync(path.join(TEST_ROOT, 'diag-scope-'));
  fs.mkdirSync(path.join(cwd, '.git'));

  const result = await withDiagnosticsScope(
    { command: 'snapshot', requestId: 'request-diag-1', logPath: LOG_PATH },
    async () => {
      const scope = await createRequestExecutionScope({
        req: makeRequest({ meta: { cwd, requestId: 'request-diag-1' } }),
        sessionStore,
        leaseRegistry: new LeaseRegistry(),
      });
      return {
        expectedPath: scope.requestLogPath,
        flushedPath: flushDiagnosticsToSessionFile({ force: true }),
      };
    },
  );

  expect(result.flushedPath).toBe(result.expectedPath);
  expect(fs.readFileSync(result.expectedPath, 'utf8')).toContain('"phase":"request_start"');
});

test('createRequestExecutionScope rejects tenant requests without an active lease', async () => {
  await expect(
    createRequestExecutionScope({
      req: makeRequest({
        session: 'default',
        command: 'snapshot',
        meta: {
          tenantId: 'tenant-a',
          runId: 'run-1',
          leaseId: '0'.repeat(32),
          sessionIsolation: 'tenant',
        },
      }),
      sessionStore: makeSessionStore('agent-device-request-scope-'),
      leaseRegistry: new LeaseRegistry(),
    }),
  ).rejects.toThrow(/Lease is not active/);
});

test('leased session admission uses stored lease metadata and heartbeats', async () => {
  let now = 1_000;
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const leaseRegistry = new LeaseRegistry({ now: () => now });
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    deviceKey: 'ios:sim-1',
  });
  sessionStore.set(
    'default',
    makeIosSession('default', {
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
        leaseProvider: 'proxy',
        clientId: 'client-a',
        deviceKey: 'ios:sim-1',
        expiresAt: lease.expiresAt,
      },
    }),
  );
  now = 2_000;

  const scope = await createRequestExecutionScope({
    req: makeRequest({ command: 'snapshot' }),
    sessionStore,
    leaseRegistry,
  });

  expect(scope.sessionName).toBe('default');
  const activeLease = leaseRegistry.listActiveLeases()[0];
  expect(activeLease?.heartbeatAt).toBe(2_000);
  expect(activeLease?.expiresAt).toBe(302_000);
  expect(sessionStore.get('default')?.lease?.expiresAt).toBe(302_000);
});

test('leased session rejects mismatched lease id before dispatch', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  sessionStore.set(
    'default',
    makeIosSession('default', {
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
      },
    }),
  );

  await expect(
    createRequestExecutionScope({
      req: makeRequest({ command: 'snapshot', meta: { leaseId: '1'.repeat(32) } }),
      sessionStore,
      leaseRegistry,
    }),
  ).rejects.toThrow(/Lease does not match session owner \(leaseId\)/);
});

test.each([
  ['leaseProvider', { leaseProvider: 'cloud' }],
  ['clientId', { clientId: 'client-b' }],
  ['deviceKey', { deviceKey: 'ios:SIM-002' }],
] as const)('leased session rejects mismatched %s before dispatch', async (_field, meta) => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  sessionStore.set(
    'default',
    makeIosSession('default', {
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
        leaseProvider: 'proxy',
        clientId: 'client-a',
        deviceKey: 'ios:SIM-001',
      },
    }),
  );

  await expect(
    createRequestExecutionScope({
      req: makeRequest({ command: 'snapshot', meta }),
      sessionStore,
      leaseRegistry,
    }),
  ).rejects.toThrow(/Lease does not match session owner/);
});

test('local unleased session admission still succeeds', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  sessionStore.set('default', makeIosSession('default'));

  const scope = await createRequestExecutionScope({
    req: makeRequest({ command: 'snapshot' }),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
  });

  expect(scope.sessionName).toBe('default');
});

test('provider lease admission succeeds without a device key', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const leaseRegistry = new LeaseRegistry();
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    backend: 'android-instance',
    leaseProvider: 'limrun',
  });
  sessionStore.set(
    'default',
    makeAndroidSession('default', {
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
        leaseProvider: 'limrun',
      },
    }),
  );

  const scope = await createRequestExecutionScope({
    req: makeRequest({ command: 'snapshot' }),
    sessionStore,
    leaseRegistry,
  });

  expect(scope.sessionName).toBe('default');
});

test('expired leases remove owned sessions before the next command and free capacity', async () => {
  let now = 1_000;
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const leaseRegistry = new LeaseRegistry({
    maxActiveSimulatorLeases: 1,
    defaultLeaseTtlMs: 10,
    minLeaseTtlMs: 1,
    now: () => now,
  });
  const lease = leaseRegistry.allocateLease({ tenantId: 'tenant-a', runId: 'run-1' });
  sessionStore.set(
    'default',
    makeSession('default', {
      device: LINUX_DEVICE,
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
        leaseProvider: 'proxy',
        deviceKey: 'ios:SIM-001',
        expiresAt: lease.expiresAt,
      },
    }),
  );
  now = 1_011;

  await createRequestExecutionScope({
    req: makeRequest({ command: 'snapshot' }),
    sessionStore,
    leaseRegistry,
  });

  expect(sessionStore.get('default')).toBeUndefined();
  const nextLease = leaseRegistry.allocateLease({ tenantId: 'tenant-b', runId: 'run-2' });
  expect(nextLease.tenantId).toBe('tenant-b');
});

test('tenant lease rejection flushes diagnostics into the effective session request log', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  const requestId = 'tenant-lease-rejection';
  let flushedPath: string | null = null;

  await withDiagnosticsScope({ command: 'snapshot', requestId, logPath: LOG_PATH }, async () => {
    await expect(
      createRequestExecutionScope({
        req: makeRequest({
          session: 'default',
          command: 'snapshot',
          meta: {
            tenantId: 'tenant-a',
            runId: 'run-1',
            leaseId: '0'.repeat(32),
            sessionIsolation: 'tenant',
            requestId,
          },
        }),
        sessionStore,
        leaseRegistry: new LeaseRegistry(),
      }),
    ).rejects.toThrow(/Lease is not active/);
    flushedPath = flushDiagnosticsToSessionFile({ force: true });
  });

  const expectedPath = resolveSessionRequestLogPath(
    sessionStore.resolveSessionDir('tenant-a:default'),
    requestId,
  );
  expect(flushedPath).toBe(expectedPath);
  expect(fs.readFileSync(expectedPath, 'utf8')).toContain('"phase":"request_start"');
});

test('prepareLockedRequestScope preserves existing-session selector validation', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  sessionStore.set('default', makeAndroidSession('default'));
  const scope = await createRequestExecutionScope({
    req: makeRequest({
      command: 'snapshot',
      flags: {
        platform: 'ios',
      },
    }),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
  });

  expect(() =>
    prepareLockedRequestScope({
      scope,
      sessionStore,
      trackDownloadableArtifact: () => 'artifact-id',
    }),
  ).toThrow(/already bound to android device "Pixel" \(emulator-5554\).*--platform=ios/i);
});

test('prepareLockedRequestScope blocks commands for invalidated recordings before handlers run', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  sessionStore.set(
    'default',
    makeIosSession('default', {
      recording: {
        platform: 'ios-device-runner',
        outPath: '/tmp/recording.mp4',
        remotePath: '/tmp/remote.mp4',
        startedAt: Date.now(),
        showTouches: true,
        gestureEvents: [],
        invalidatedReason: 'iOS runner session restarted during recording',
      },
    }),
  );
  const scope = await createRequestExecutionScope({
    req: makeRequest({ command: 'snapshot' }),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
  });

  const result = await withDiagnosticsScope({ command: 'snapshot', logPath: LOG_PATH }, async () =>
    prepareLockedRequestScope({
      scope,
      sessionStore,
      trackDownloadableArtifact: () => 'artifact-id',
    }),
  );

  expect(result.type).toBe('response');
  if (result.type === 'response') {
    expect(result.response.ok).toBe(false);
    if (!result.response.ok) {
      expect(result.response.error.message).toBe('iOS runner session restarted during recording');
    }
  }
});

test('prepareLockedRequestScope passes the session runner log path into handler context', async () => {
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  sessionStore.set('default', makeIosSession('default'));
  const scope = await createRequestExecutionScope({
    req: makeRequest({ command: 'snapshot' }),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
  });

  const result = prepareLockedRequestScope({
    scope,
    sessionStore,
    trackDownloadableArtifact: () => 'artifact-id',
  });

  expect(result.type).toBe('scope');
  if (result.type === 'scope') {
    expect(result.scope.logPath).toBe(scope.runnerLogPath);
    expect(result.scope.contextFromFlags(undefined).logPath).toBe(scope.runnerLogPath);
  }
});

test('runLocked rejects a canceled request before executing work', async () => {
  const requestId = 'request-scope-canceled-before-lock';
  const scope = await createRequestExecutionScope({
    req: makeRequest({ meta: { requestId } }),
    sessionStore: makeSessionStore('agent-device-request-scope-'),
    leaseRegistry: new LeaseRegistry(),
  });

  markRequestCanceled(requestId);
  try {
    await expect(scope.runLocked(async () => 'ran')).rejects.toThrow(/request canceled/);
  } finally {
    clearRequestCanceled(requestId);
  }
});

test('runLocked rejects a request canceled while waiting for its execution lock', async () => {
  const requestId = 'request-scope-canceled-after-lock';
  const sessionStore = makeSessionStore('agent-device-request-scope-');
  sessionStore.set('default', makeIosSession('default'));
  const leaseRegistry = new LeaseRegistry();
  const first = await createRequestExecutionScope({
    req: makeRequest({ command: 'click' }),
    sessionStore,
    leaseRegistry,
  });
  const second = await createRequestExecutionScope({
    req: makeRequest({ command: 'click', meta: { requestId } }),
    sessionStore,
    leaseRegistry,
  });
  let releaseLock: () => void = () => {};
  const lockReleased = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const firstRun = first.runLocked(async () => await lockReleased);
  const secondRun = second.runLocked(async () => 'ran');
  const secondExpectation = expect(secondRun).rejects.toThrow(/request canceled/);

  markRequestCanceled(requestId);
  releaseLock();
  try {
    await firstRun;
    await secondExpectation;
  } finally {
    clearRequestCanceled(requestId);
  }
});

function makeRequest(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command: 'snapshot',
    positionals: [],
    ...overrides,
  };
}
