import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { createTestAppLogLiveHandle } from '../../__tests__/test-utils/app-log-live-handle.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  recoverAppLogResourcesAfterDaemonLock,
  type AppLogRecoveryDiagnostic,
} from '../app-log-resource-recovery.ts';
import { appLogResourceStore } from '../app-log-resource-store.ts';
import {
  flushDaemonStartupDiagnostics,
  teardownDaemonSessionForShutdown,
} from '../server/daemon-runtime.ts';
import type { SessionState } from '../session-state.ts';
import { unavailableDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';

test('daemon startup awaits app-log recovery after acquiring the lock and before opening servers', () => {
  const source = fs.readFileSync(new URL('../server/daemon-runtime.ts', import.meta.url), 'utf8');
  const acquiredLock = source.indexOf('if (!acquireDaemonLock(');
  const legacyRecovery = source.indexOf(
    'await platformDaemonLifecycleOwners.recoverLegacyAppLogMarkers(',
  );
  const recovery = source.indexOf('await recoverAppLogResourcesAfterDaemonLock(');
  const openedServers = source.indexOf('const opened = await openDaemonServers()');

  expect(acquiredLock).toBeGreaterThanOrEqual(0);
  expect(legacyRecovery).toBeGreaterThan(acquiredLock);
  expect(recovery).toBeGreaterThan(legacyRecovery);
  expect(openedServers).toBeGreaterThan(recovery);
});

test('daemon startup configures the Apple runner owner after acquiring the lock, not before', () => {
  // #2333/#2415 review: the daemon-owned lease-owner state dir and claim-authority probe must
  // publish only once this process actually holds the daemon lock, so a losing process never
  // configures a global platform owner it does not own.
  const source = fs.readFileSync(new URL('../server/daemon-runtime.ts', import.meta.url), 'utf8');
  const acquiredLock = source.indexOf('if (!acquireDaemonLock(');
  const runnerOwnerConfigured = source.indexOf(
    'await platformDaemonLifecycleOwners.configureForDaemonLock(',
  );
  const lockFailureExit = source.indexOf("stderr.write('Daemon lock is held by another process");

  expect(acquiredLock).toBeGreaterThanOrEqual(0);
  expect(lockFailureExit).toBeGreaterThan(acquiredLock);
  expect(runnerOwnerConfigured).toBeGreaterThan(acquiredLock);
  // The configure call sits inside the post-lock try block, after the failure branch that exits
  // for a lock held by another process.
  expect(runnerOwnerConfigured).toBeGreaterThan(lockFailureExit);
});

test('retained startup recovery evidence is flushed after daemon.log publication', async () => {
  const root = mkdtempForTestSync('daemon-runtime-app-log-recovery-diagnostics-');
  const sessionsDir = path.join(root, 'sessions');
  const resourcePath = path.join(sessionsDir, 'session', 'app-log.resource.json');
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(resourcePath, '{');
  const diagnostics: AppLogRecoveryDiagnostic[] = [];

  await recoverAppLogResourcesAfterDaemonLock({
    sessionsDir,
    gateway: unavailableDeviceRuntimeGateway,
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const logPath = path.join(root, 'daemon.log');
  fs.writeFileSync(logPath, 'pre-publication bytes are truncated');
  fs.writeFileSync(logPath, '');
  await flushDaemonStartupDiagnostics(logPath, diagnostics);

  const events = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { phase: string; data?: Record<string, unknown> });
  expect(events).toEqual([
    expect.objectContaining({
      phase: 'app_log_recovery_record_unreattachable',
      data: expect.objectContaining({ resourcePath }),
    }),
  ]);
});

test('daemon shutdown settles fenced app-log cleanup before finalization can release ownership', async () => {
  const sessionStore = makeSessionStore('daemon-runtime-app-log-shutdown-');
  const session: SessionState = {
    name: 'session',
    device: { platform: 'web', id: 'browser', name: 'Browser', kind: 'device' },
    createdAt: Date.now(),
    actions: [],
  };
  const fence = { token: 'fence', generation: 1 };
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'app-log',
    sessionId: session.name,
    device: { id: session.device.id, family: 'web', kind: 'device' },
    owner: localRuntimeOwner('web'),
    fence,
    lifecycle: 'open',
    descriptor: { version: 1, body: {} },
  });
  let releaseCleanup!: () => void;
  let markCleanupStarted!: () => void;
  const cleanupReleased = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve;
  });
  const forceCleanup = vi.fn(async () => {
    markCleanupStarted();
    await cleanupReleased;
    return { status: 'cleaned' as const };
  });
  const handle = createTestAppLogLiveHandle({
    inspect: () => ({ backend: 'android', state: 'active', startedAt: 1 }),
    finish: async () => ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }),
    forceCleanup,
  });
  session.appLog = { handle, envelope };
  sessionStore.set(session.name, session);
  const resourcePath = appLogResourceStore.resolvePath(
    sessionStore.resolveSessionDir(session.name),
  );
  fs.mkdirSync(sessionStore.resolveSessionDir(session.name), { recursive: true });
  fs.writeFileSync(resourcePath, `${JSON.stringify(envelope)}\n`);
  const beforeDelete = vi.fn(async () => {});

  const teardown = teardownDaemonSessionForShutdown({
    session,
    sessionStore,
    stderr: { write: () => {} },
    beforeDelete,
  });
  await cleanupStarted;

  expect(beforeDelete).not.toHaveBeenCalled();
  expect(sessionStore.get(session.name)).toBeDefined();
  releaseCleanup();
  await teardown;

  expect(forceCleanup).toHaveBeenCalledOnce();
  expect(beforeDelete).toHaveBeenCalledOnce();
  expect(sessionStore.get(session.name)).toBeUndefined();
  expect(appLogResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
});
