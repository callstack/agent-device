import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  localRuntimeOwner,
  type CleanupOutcome,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
  type ReattachOutcome,
} from '@agent-device/contracts/platform';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { createTestAppLogLiveHandle } from '../../__tests__/test-utils/app-log-live-handle.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { recoverAppLogResourcesAfterDaemonLock } from '../app-log-resource-recovery.ts';
import { appLogResourceStore } from '../app-log-resource-store.ts';

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

test('startup recovery retains invalid/schema-mismatched evidence without binding', async () => {
  const sessionsDir = mkdtempForTestSync('app-log-recovery-invalid-');
  const resourcePath = appLogResourceStore.resolvePath(path.join(sessionsDir, 'session'));
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(resourcePath, '{');
  const runtime = makeGateway();

  expect(
    await recoverAppLogResourcesAfterDaemonLock({ sessionsDir, gateway: runtime.gateway, scope }),
  ).toEqual({ scanned: 1, recovered: 0, retained: 1 });
  expect(runtime.bind).not.toHaveBeenCalled();
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe('{');
});

test('startup recovery binds the exact owner/fence and cleans an active handle', async () => {
  const { sessionsDir, resourcePath } = makeRecord();
  const runtime = makeGateway();
  const result = await recoverAppLogResourcesAfterDaemonLock({
    sessionsDir,
    gateway: runtime.gateway,
    scope,
  });

  expect(result).toEqual({ scanned: 1, recovered: 1, retained: 0 });
  expect(runtime.bind).toHaveBeenCalledWith(
    expect.objectContaining({
      intent: {
        kind: 'exact-owner',
        owner: localRuntimeOwner('android'),
        fence: { token: 'fence', generation: 1 },
      },
    }),
  );
  expect(runtime.forceCleanup).toHaveBeenCalledOnce();
  expect(runtime.bindingDispose).toHaveBeenCalledOnce();
  expect(appLogResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
});

test('facet schema mismatch remains unmodified and never starts a replacement cleanup', async () => {
  const { sessionsDir, resourcePath } = makeRecord();
  const runtime = makeGateway({
    reattach: {
      status: 'unreattachable',
      reason: 'descriptor-version-unsupported',
      message: 'future descriptor',
    },
  });
  const before = fs.readFileSync(resourcePath, 'utf8');

  expect(
    await recoverAppLogResourcesAfterDaemonLock({ sessionsDir, gateway: runtime.gateway, scope }),
  ).toEqual({ scanned: 1, recovered: 0, retained: 1 });
  expect(runtime.cleanup).not.toHaveBeenCalled();
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe(before);
});

test('a manifest claiming a different session is retained before any runtime authority binds', async () => {
  const { sessionsDir, resourcePath } = makeRecord({
    physicalSessionId: 'session-a',
    envelopeSessionId: 'session-b',
  });
  const runtime = makeGateway();
  const before = fs.readFileSync(resourcePath, 'utf8');

  expect(
    await recoverAppLogResourcesAfterDaemonLock({ sessionsDir, gateway: runtime.gateway, scope }),
  ).toEqual({ scanned: 1, recovered: 0, retained: 1 });
  expect(runtime.bind).not.toHaveBeenCalled();
  expect(runtime.forceCleanup).not.toHaveBeenCalled();
  expect(runtime.cleanup).not.toHaveBeenCalled();
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe(before);
});

test('uncertain active cleanup persists cleanup-pending for the next exact-owner recovery', async () => {
  const { sessionsDir, resourcePath } = makeRecord();
  const runtime = makeGateway({
    forceCleanup: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' },
  });
  expect(
    await recoverAppLogResourcesAfterDaemonLock({ sessionsDir, gateway: runtime.gateway, scope }),
  ).toEqual({ scanned: 1, recovered: 0, retained: 1 });
  expect(appLogResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { phase: 'cleanup-pending' } },
  });
});

test('startup recovery bounds a never-settling owner and retains its durable evidence', async () => {
  vi.useFakeTimers();
  try {
    const { sessionsDir, resourcePath } = makeRecord();
    const runtime = makeGateway({
      reattachImplementation: () => new Promise(() => {}),
    });
    const diagnostics: Array<{ phase: string }> = [];

    const recovery = recoverAppLogResourcesAfterDaemonLock({
      sessionsDir,
      gateway: runtime.gateway,
      scope,
      perRecordDeadlineMs: 25,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(recovery).resolves.toEqual({ scanned: 1, recovered: 0, retained: 1 });
    expect(runtime.boundSignals[0]?.aborted).toBe(true);
    expect(runtime.forceCleanup).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual({
      phase: 'app_log_recovery_timed_out',
      resourcePath,
      data: {
        deadlineMs: 25,
        error: 'App-log recovery exceeded its 25ms deadline',
      },
    });
    expect(appLogResourceStore.read(resourcePath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'open' },
    });
  } finally {
    vi.useRealTimers();
  }
});

test('a late active reattach is disposed exactly once without escaping recovery authority', async () => {
  vi.useFakeTimers();
  try {
    const { sessionsDir } = makeRecord();
    let resolveReattach!: (
      outcome: ReattachOutcome<ReturnType<typeof createHandle>, never>,
    ) => void;
    const reattach = new Promise<ReattachOutcome<ReturnType<typeof createHandle>, never>>(
      (resolve) => {
        resolveReattach = resolve;
      },
    );
    const runtime = makeGateway({ reattachImplementation: () => reattach });

    const recovery = recoverAppLogResourcesAfterDaemonLock({
      sessionsDir,
      gateway: runtime.gateway,
      scope,
      perRecordDeadlineMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(recovery).resolves.toEqual({ scanned: 1, recovered: 0, retained: 1 });

    resolveReattach({ status: 'active', handle: createHandle(runtime.forceCleanup) });
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.forceCleanup).toHaveBeenCalledOnce();
    expect(runtime.bindingDispose).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test('late handle cleanup failure is secondary evidence and preserves the deadline outcome', async () => {
  vi.useFakeTimers();
  try {
    const { sessionsDir, resourcePath } = makeRecord();
    let resolveReattach!: (
      outcome: ReattachOutcome<ReturnType<typeof createHandle>, never>,
    ) => void;
    const reattach = new Promise<ReattachOutcome<ReturnType<typeof createHandle>, never>>(
      (resolve) => {
        resolveReattach = resolve;
      },
    );
    const runtime = makeGateway({
      reattachImplementation: () => reattach,
      forceCleanupImplementation: async () => {
        throw new Error('late cleanup failed');
      },
    });
    const diagnostics: Array<{ phase: string; data: Readonly<Record<string, unknown>> }> = [];

    const recovery = recoverAppLogResourcesAfterDaemonLock({
      sessionsDir,
      gateway: runtime.gateway,
      scope,
      perRecordDeadlineMs: 25,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(recovery).resolves.toEqual({ scanned: 1, recovered: 0, retained: 1 });

    resolveReattach({ status: 'active', handle: createHandle(runtime.forceCleanup) });
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.forceCleanup).toHaveBeenCalledOnce();
    expect(runtime.bindingDispose).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'app_log_recovery_timed_out' }),
        {
          phase: 'app_log_recovery_late_handle_cleanup_failed',
          resourcePath,
          data: {
            error: 'late cleanup failed',
            primaryError: 'App-log recovery exceeded its 25ms deadline',
          },
        },
      ]),
    );
  } finally {
    vi.useRealTimers();
  }
});

test('once exact-owner cleanup starts, recovery holds the daemon lock path until it settles', async () => {
  vi.useFakeTimers();
  try {
    const { sessionsDir } = makeRecord();
    let resolveCleanup!: (outcome: CleanupOutcome) => void;
    const cleanup = new Promise<CleanupOutcome>((resolve) => {
      resolveCleanup = resolve;
    });
    const runtime = makeGateway({ forceCleanupImplementation: () => cleanup });
    let settled = false;

    const recovery = recoverAppLogResourcesAfterDaemonLock({
      sessionsDir,
      gateway: runtime.gateway,
      scope,
      perRecordDeadlineMs: 25,
    }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.forceCleanup).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(25);
    expect(settled).toBe(false);

    resolveCleanup({ status: 'cleaned' });
    await expect(recovery).resolves.toEqual({ scanned: 1, recovered: 1, retained: 0 });
  } finally {
    vi.useRealTimers();
  }
});

function makeRecord(options: { physicalSessionId?: string; envelopeSessionId?: string } = {}) {
  const sessionsDir = mkdtempForTestSync('app-log-recovery-');
  const physicalSessionId = options.physicalSessionId ?? 'session';
  const envelopeSessionId = options.envelopeSessionId ?? physicalSessionId;
  const resourcePath = appLogResourceStore.resolvePath(path.join(sessionsDir, physicalSessionId));
  appLogResourceStore.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: envelopeSessionId,
      device: { id: 'emulator-5554', family: 'android', kind: 'emulator' },
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
  );
  return { sessionsDir, resourcePath };
}

function makeGateway(
  options: {
    reattach?: ReattachOutcome<ReturnType<typeof createHandle>, never>;
    reattachImplementation?: () => Promise<ReattachOutcome<ReturnType<typeof createHandle>, never>>;
    forceCleanup?: CleanupOutcome;
    forceCleanupImplementation?: () => Promise<CleanupOutcome>;
  } = {},
) {
  const forceCleanup = vi.fn(
    options.forceCleanupImplementation ??
      (async (): Promise<CleanupOutcome> => options.forceCleanup ?? { status: 'cleaned' }),
  );
  const handle = createHandle(forceCleanup);
  const bindingDispose = vi.fn(async () => {});
  const cleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const operations: DeviceBinding<PlatformRuntimeOperations>['operations'] = {
    appLogInspect: async () => ({ backend: 'android' }),
    appLogDoctor: async () => ({ backend: 'android', checks: {}, notes: [] }),
    appLogStart: async () => {
      throw new Error('recovery must not start a replacement');
    },
    appLogReattach:
      options.reattachImplementation ??
      (async () => options.reattach ?? { status: 'active', handle }),
    appLogCleanup: cleanup,
    networkDump: async (input) => ({
      source: 'app-log',
      backend: 'android',
      dump: {
        path: '/tmp/app.log',
        exists: false,
        scannedLines: 0,
        matchedLines: 0,
        entries: [],
        include: input.include,
        limits: {
          maxEntries: input.maxEntries,
          maxPayloadChars: input.maxPayloadChars,
          maxScanLines: input.maxScanLines,
        },
      },
      notes: [],
    }),
  };
  const boundSignals: AbortSignal[] = [];
  const bind = vi.fn(async ({ device, scope: bindingScope }) => {
    boundSignals.push(bindingScope.signal);
    return {
      device,
      owner: localRuntimeOwner('android'),
      facts: {
        device: { family: 'android' as const, kind: device.kind, providerMode: 'local' as const },
        operations: {
          appLogInspect: { available: true as const },
          appLogDoctor: { available: true as const },
          appLogStart: { available: true as const },
          appLogReattach: { available: true as const },
          appLogCleanup: { available: true as const },
          networkDump: { available: true as const },
          screenRecordingStart: unavailableRecording,
          screenRecordingReattach: unavailableRecording,
          screenRecordingCleanup: unavailableRecording,
        },
      },
      operations,
      [Symbol.asyncDispose]: bindingDispose,
    };
  });
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    bind,
    shutdown: async () => {},
  };
  return { gateway, bind, forceCleanup, cleanup, bindingDispose, boundSignals };
}

const unavailableRecording = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});

function createHandle(
  forceCleanup: () => Promise<CleanupOutcome> = vi.fn(
    async (): Promise<CleanupOutcome> => ({ status: 'cleaned' }),
  ),
) {
  return createTestAppLogLiveHandle({
    inspect: () => ({ backend: 'android', state: 'recovering', startedAt: 1 }),
    finish: async () => ({
      status: 'completed',
      result: { backend: 'android', outputPath: '/tmp/app.log', completedAt: 2 },
    }),
    forceCleanup,
  });
}
