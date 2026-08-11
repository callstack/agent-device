import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  createDurableResourceEnvelope,
  createScreenRecordingLiveHandle,
} from '@agent-device/capture-kit';
import {
  localRuntimeOwner,
  PendingTransferGuard,
  type CleanupOutcome,
  type ReattachOutcome,
  type ScreenRecordingCompletion,
  type ScreenRecordingLiveHandle,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { countDiagnosticEventsByPhase, withDiagnosticsScope } from '../../utils/diagnostics.ts';
import { createDurableCaptureAdmissionLedger } from '../durable-capture-admission-ledger.ts';
import { createDurableCaptureResource } from '../durable-capture-resource.ts';
import type { DurableCaptureResourceStore } from '../durable-capture-resource-store.ts';
import { screenRecordingResourceStore } from '../screen-recording-resource-store.ts';
import type { SessionState } from '../types.ts';

type ScreenRecordingStore = DurableCaptureResourceStore<'screen-recording'>;

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
};

test('cancellation after native acquisition cleans the pending handle and permits replacement', async () => {
  const resource = createScreenRecordingTestResource();
  const context = makeContext(resource);
  const start = makeStart(context, { status: 'cleaned' });
  const cancellation = new AppError('CANCELED', 'recording request canceled');

  await expect(
    resource.adoptStarted({
      ...context,
      ...start,
      throwIfCanceled: () => {
        throw cancellation;
      },
    }),
  ).rejects.toBe(cancellation);

  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(resource.store.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
  expect(context.sessionStore.get(context.sessionName)?.screenRecording).toBeUndefined();
  expect(() => resource.createNextFence(replacementFenceParams(context, resource))).not.toThrow();
});

test('durable manifest persistence failure preserves the primary error and blocks uncertain replacement', async () => {
  const persistenceError = new Error('durable recording manifest write failed');
  const resource = createScreenRecordingTestResource(failFirstWrite(persistenceError));
  const context = makeContext(resource);
  const start = makeStart(context, {
    status: 'cleanup-pending',
    reason: 'transport-failed',
    message: 'native cleanup could not confirm recorder presence',
  });

  await withDiagnosticsScope({ command: 'record' }, async () => {
    await expect(
      resource.adoptStarted({ ...context, ...start, throwIfCanceled: () => {} }),
    ).rejects.toBe(persistenceError);
    expect(countDiagnosticEventsByPhase(['screen_recording_pending_adoption_cleanup_failed'])).toBe(
      1,
    );
  });

  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(resource.store.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'open',
      metadata: { phase: 'cleanup-pending', cleanupStatus: 'cleanup-pending' },
    },
  });
  expect(() => resource.createNextFence(replacementFenceParams(context, resource))).toThrow(
    /terminal state/,
  );
});

test('durable manifest persistence failure permits replacement after confirmed cleanup', async () => {
  const persistenceError = new Error('durable recording manifest write failed');
  const resource = createScreenRecordingTestResource(failFirstWrite(persistenceError));
  const context = makeContext(resource);
  const start = makeStart(context, { status: 'cleaned' });

  await expect(
    resource.adoptStarted({ ...context, ...start, throwIfCanceled: () => {} }),
  ).rejects.toBe(persistenceError);

  expect(start.forceCleanup).toHaveBeenCalledOnce();
  expect(resource.store.read(context.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { phase: 'completed' } },
  });
  expect(() => resource.createNextFence(replacementFenceParams(context, resource))).not.toThrow();
});

test('retains recording evidence when exact-owner recovery resolves after its deadline', async () => {
  vi.useFakeTimers();
  try {
    const resource = createScreenRecordingTestResource();
    const context = makeContext(resource);
    const start = makeStart(context, {
      status: 'cleanup-pending',
      reason: 'transport-failed',
      message: 'late recorder cleanup could not confirm presence',
    });
    resource.store.write(context.resourcePath, start.envelope);

    type Reattach = ReattachOutcome<ScreenRecordingLiveHandle, ScreenRecordingCompletion>;
    let resolveReattach!: (outcome: Reattach) => void;
    const reattach = new Promise<Reattach>((resolve) => {
      resolveReattach = resolve;
    });
    const disposeControl = vi.fn(async () => {});
    const diagnostics: Array<{
      phase: string;
      data: Readonly<Record<string, unknown>>;
    }> = [];
    const scope = {
      signal: new AbortController().signal,
      diagnostics: { emit: vi.fn() },
      progress: { report: vi.fn() },
    };

    const recovery = resource.recoverAll({
      sessionsDir: path.dirname(context.sessionStore.resolveSessionDir(context.sessionName)),
      scope,
      perRecordDeadlineMs: 25,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      acquireControl: async (_envelope, recoveryScope) => {
        expect(recoveryScope.signal.aborted).toBe(false);
        return {
          reattach: async () => await reattach,
          cleanup: async () => ({ status: 'already-missing' as const }),
          [Symbol.asyncDispose]: disposeControl,
        };
      },
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(recovery).resolves.toEqual({ scanned: 1, recovered: 0, retained: 1 });

    resolveReattach({ status: 'active', handle: start.handle });
    await vi.advanceTimersByTimeAsync(0);

    expect(start.forceCleanup).toHaveBeenCalledOnce();
    expect(disposeControl).toHaveBeenCalledOnce();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'screen_recording_recovery_timed_out' }),
        expect.objectContaining({
          phase: 'screen_recording_recovery_late_handle_cleanup_failed',
          data: expect.objectContaining({
            error: 'late recorder cleanup could not confirm presence',
            primaryError: 'Screen recording recovery exceeded its 25ms deadline',
          }),
        }),
      ]),
    );
    expect(resource.store.read(context.resourcePath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'open' },
    });
    expect(() => resource.createNextFence(replacementFenceParams(context, resource))).toThrow(
      /terminal state/,
    );
  } finally {
    vi.useRealTimers();
  }
});

function createScreenRecordingTestResource(
  store: ScreenRecordingStore = screenRecordingResourceStore,
) {
  return createDurableCaptureResource<
    'screen-recording',
    ScreenRecordingLiveHandle,
    ScreenRecordingCompletion
  >({
    resourceKind: 'screen-recording',
    displayName: 'screen recording',
    store,
    sessionSlot: {
      read: (session) => session.screenRecording,
      replace: (session, screenRecording) => ({ ...session, screenRecording }),
    },
    completionMetadata: (completion) => ({
      backend: completion.backend,
      outputPath: completion.outPath,
      completedAt: completion.completedAt,
    }),
    messages: {
      noActive: 'no active recording',
      cleanupPendingHint: 'Keep the screen-recording recovery record for exact-owner cleanup.',
    },
  });
}

function makeContext(resource: ReturnType<typeof createScreenRecordingTestResource>) {
  const sessionStore = makeSessionStore('screen-recording-boundary-fault-');
  const sessionName = 'recording';
  const session: SessionState = {
    name: sessionName,
    device,
    createdAt: 1,
    actions: [],
  };
  sessionStore.set(sessionName, session);
  return {
    admissionLedger: createDurableCaptureAdmissionLedger({ displayName: 'screen recording' }),
    session,
    sessionName,
    sessionStore,
    device,
    owner: localRuntimeOwner('android'),
    fence: { token: 'recording-fence', generation: 1 } as const,
    resourcePath: resource.store.resolvePath(sessionStore.resolveSessionDir(sessionName)),
  };
}

function makeStart(context: ReturnType<typeof makeContext>, cleanup: CleanupOutcome) {
  const forceCleanup = vi.fn(async () => cleanup);
  const completion: ScreenRecordingCompletion = {
    backend: 'android',
    outPath: '/tmp/capture.mp4',
    startedAt: 1,
    completedAt: 2,
    scope: 'device',
    showTouches: false,
    recordOnlySession: false,
  };
  const handle = createScreenRecordingLiveHandle(
    {
      backend: 'android',
      outPath: completion.outPath,
      startedAt: completion.startedAt,
      scope: completion.scope,
      showTouches: completion.showTouches,
      recordOnlySession: completion.recordOnlySession,
      gestureEvents: [],
    },
    {
      finish: async () => ({ status: 'completed' as const, result: completion }),
      forceCleanup,
    },
  );
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: context.sessionName,
    device: {
      id: context.device.id,
      family: context.device.platform,
      kind: context.device.kind,
    },
    owner: context.owner,
    fence: context.fence,
    lifecycle: 'open',
    descriptor: { version: 1, body: { nativeRecordingId: 'recording-1' } },
  });
  return { handle, forceCleanup, pendingHandle: new PendingTransferGuard(handle), envelope };
}

function failFirstWrite(error: Error): ScreenRecordingStore {
  let failed = false;
  return {
    ...screenRecordingResourceStore,
    write(resourcePath, envelope) {
      if (!failed) {
        failed = true;
        throw error;
      }
      screenRecordingResourceStore.write(resourcePath, envelope);
    },
  };
}

function replacementFenceParams(
  context: ReturnType<typeof makeContext>,
  resource: ReturnType<typeof createScreenRecordingTestResource>,
) {
  return {
    admissionLedger: context.admissionLedger,
    resourcePath: resource.store.resolvePath(context.sessionStore.resolveSessionDir('replacement')),
    device: context.device,
  };
}
