import { AppError } from '@agent-device/kernel/errors';
import { isCompletedDurableCaptureError } from '@agent-device/capture-kit/durable-capture';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { cleanupRetainedMaterializedPathsForSession } from './materialized-path-registry.ts';
import type { SessionRef, SessionState } from '../core/session-state.ts';
import {
  bindSessionAudioProbe,
  bindSessionPerfCapture,
  bindSessionScreenRecording,
} from '../core/session-capture-binding.ts';
import type { SessionStore } from '../core/session-store.ts';
import { finishLiveAudioProbe } from '@agent-device/capture-kit/audio-probe-session-resource';
import { finishLivePerfCapture } from '@agent-device/capture-kit/perf-capture-session-resource';
import { finishLiveScreenRecording } from '@agent-device/capture-kit/screen-recording-session-resource';
import { openWebSessionNames } from './web-session-names.ts';
import type { PlatformResourceCleanup } from '../core/platform-resource-cleanup.ts';

export async function stopSessionAppLog(params: {
  ref: SessionRef;
  sessionStore: SessionStore;
}): Promise<void> {
  const ref = params.sessionStore.refresh(params.ref);
  if (!ref.session.appLog) return;
  const { forceCleanupSessionAppLog } = await import('../resources/app-log-session-resource.ts');
  await forceCleanupSessionAppLog({ ...params, ref });
}

async function stopSessionPerfCapture(params: {
  ref: SessionRef;
  sessionStore: SessionStore;
}): Promise<void> {
  const binding = bindSessionPerfCapture(params.sessionStore, params.ref);
  if (binding.read()) await finishLivePerfCapture({ binding, intent: 'disposal' });
}

async function stopSessionSnapshotHelper(
  session: SessionState,
  platformCleanup: PlatformResourceCleanup,
): Promise<void> {
  await platformCleanup.stopSnapshotHelper(session.device);
}

// Shutdown and expiry close the browser here instead of waiting for its idle timer.
// Ordinary close reaches it through dispatchTargetedPlatformClose.
async function stopSessionWebBrowser(params: {
  ref: SessionRef;
  sessionStore: SessionStore;
  platformCleanup: PlatformResourceCleanup;
}): Promise<void> {
  const { ref, sessionStore, platformCleanup } = params;
  const session = sessionStore.resolveCurrent(ref) ?? ref.session;
  if (sessionStore.hasClosedBrowserSession(ref.address)) return;
  const closed = await platformCleanup.closeManagedBrowser({
    device: session.device,
    stateDir: sessionStore.resolveDaemonStateDir(),
    openSessionNames: () => openWebSessionNames(sessionStore),
  });
  if (closed) sessionStore.markClosedBrowserSession(ref.address);
}

export type SessionCleanupStep = { step: string; run: () => Promise<void> };
export type SessionCleanupFailure = { step: string; error: unknown };

// Run every cleanup step, isolating failures so one rejected resource never
// skips the resources scheduled after it. Callers own lease/session deletion and
// decide how to surface the returned failures.
async function runIsolatedSessionCleanup(
  steps: readonly SessionCleanupStep[],
): Promise<SessionCleanupFailure[]> {
  const failures: SessionCleanupFailure[] = [];
  for (const { step, run } of steps) {
    try {
      await run();
    } catch (error) {
      failures.push({ step, error });
    }
  }
  return failures;
}

// Emit an aggregate diagnostic for failed cleanup steps and build a single
// actionable error. Returns undefined when nothing failed so the happy path is
// untouched.
export function reportSessionCleanupFailures(params: {
  sessionName: string;
  phase: string;
  failures: readonly SessionCleanupFailure[];
  hint?: string;
}): AppError | undefined {
  if (params.failures.length === 0) return undefined;
  const failedSteps = params.failures.map(({ step }) => step);
  const stepMessages = params.failures.map(
    ({ step, error }) => `${step}: ${error instanceof Error ? error.message : String(error)}`,
  );
  emitDiagnostic({
    level: 'error',
    phase: params.phase,
    data: {
      session: params.sessionName,
      failedSteps,
      errors: stepMessages,
    },
  });
  return new AppError(
    'COMMAND_FAILED',
    `Session cleanup left ${params.failures.length} resource(s) unreleased: ${stepMessages.join('; ')}`,
    {
      reason: 'session_cleanup_incomplete',
      session: params.sessionName,
      failedSteps,
      hint:
        params.hint ??
        'Some session resources failed to release. The session was retired; inspect the session log, device state, and retained claims before recovery. Do not retry close on the retired session.',
    },
  );
}

// Ordered stops for the session resources every teardown path releases. Ordinary close and daemon
// shutdown/expiry both consume this list; each caller owns how the steps run and what follows.
// `appLog: 'already-settled'` omits the app-log step for a caller that stopped it under its own fence.
export function sessionResourceStopSteps(params: {
  ref: SessionRef;
  sessionStore: SessionStore;
  platformCleanup: PlatformResourceCleanup;
  appLog: 'run' | 'already-settled';
}): SessionCleanupStep[] {
  const { ref, sessionStore, platformCleanup } = params;
  const session = sessionStore.resolveCurrent(ref) ?? ref.session;
  // The session's durable-capture stops. Each one can be refused by a record that committed while the
  // step was queued, and that refusal settles: the stopping belongs to the commit, not to this step.
  const durableCaptureStops: SessionCleanupStep[] = [
    // Finalize any still-active recording BEFORE the Apple runner is stopped: the runner supplies
    // gesture-telemetry for overlay finalization, and signalling the recorder first prevents a
    // leaked `simctl recordVideo` child (and its 0-byte, slot-holding mp4) when a session is torn
    // down — including on daemon shutdown — without an explicit `record stop`.
    { step: 'recording', run: () => finishSessionScreenRecording({ ref, sessionStore }) },
    ...(params.appLog === 'run'
      ? [{ step: 'app_log', run: () => stopSessionAppLog({ ref, sessionStore }) }]
      : []),
    { step: 'audio_probe', run: () => finishSessionAudioProbe({ ref, sessionStore }) },
    { step: 'perf_capture', run: () => stopSessionPerfCapture({ ref, sessionStore }) },
  ];
  return [
    ...durableCaptureStops.map(settleCommittedRecordStop),
    // The snapshot helper owns no durable record, so its failures stay its own.
    {
      step: 'platform_snapshot_helper',
      run: () => stopSessionSnapshotHelper(session, platformCleanup),
    },
  ];
}

/**
 * Makes one cleanup step settle when the durable record it stopped against answers that the record is
 * already completed. That refusal means the resource was released by the stop that committed the
 * record; reporting it as unreleased would send an operator after a resource that is already gone.
 */
function settleCommittedRecordStop(step: SessionCleanupStep): SessionCleanupStep {
  return {
    ...step,
    run: async () => {
      try {
        await step.run();
      } catch (error) {
        if (!isCompletedDurableCaptureError(error)) throw error;
      }
    },
  };
}

type SessionResourceTeardownRequest = {
  ref: SessionRef;
  sessionStore: SessionStore;
  appLog: 'run' | 'already-settled';
  platformCleanup?: PlatformResourceCleanup;
};

export async function teardownSessionResources(
  request: SessionResourceTeardownRequest,
): Promise<void> {
  const { ref, sessionStore } = request;
  const sessionName = ref.address;
  if (!request.platformCleanup) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Platform resource cleanup was not supplied by root runtime composition',
    );
  }
  const platformCleanup = request.platformCleanup;
  const steps: SessionCleanupStep[] = [
    ...sessionResourceStopSteps({ ...request, platformCleanup }),
    {
      step: 'web_browser',
      run: () =>
        stopSessionWebBrowser({
          ref,
          sessionStore,
          platformCleanup,
        }),
    },
  ];
  steps.push({
    step: 'materialized_paths',
    run: () => cleanupRetainedMaterializedPathsForSession(sessionName),
  });
  const failures = await runIsolatedSessionCleanup(steps);
  const aggregate = reportSessionCleanupFailures({
    sessionName,
    phase: 'session_teardown_cleanup_failed',
    failures,
  });
  if (aggregate) throw aggregate;
}

async function finishSessionScreenRecording(params: {
  ref: SessionRef;
  sessionStore: SessionStore;
}): Promise<void> {
  const binding = bindSessionScreenRecording(params.sessionStore, params.ref);
  const recording = binding.read();
  if (!recording) return;
  const remoteCaptureOutput = recording.envelope.metadata?.remoteCaptureOutput === true;
  const completion = await finishLiveScreenRecording({ binding, intent: 'disposal' });
  if (!params.ref.session.lease) return;
  const { retainLeasedSessionRecording } = await import('./leased-recording-retention.ts');
  retainLeasedSessionRecording(params.ref, completion, remoteCaptureOutput);
}

async function finishSessionAudioProbe(params: {
  ref: SessionRef;
  sessionStore: SessionStore;
}): Promise<void> {
  const binding = bindSessionAudioProbe(params.sessionStore, params.ref);
  if (binding.read()) await finishLiveAudioProbe({ binding, intent: 'disposal' });
}
