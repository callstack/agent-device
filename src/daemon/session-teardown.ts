import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { cleanupRetainedMaterializedPathsForSession } from './materialized-path-registry.ts';
import type { SessionState } from './types.ts';
import type { SessionStore } from './session-store.ts';
import { forceCleanupSessionAppLog } from './app-log-session-resource.ts';
import { appLogResourceStore } from './app-log-resource-store.ts';
import { finishLiveScreenRecording } from './screen-recording-session-resource.ts';
import { finishLiveAudioProbe } from './audio-probe-session-resource.ts';
import { finishLivePerfCapture } from './perf-capture-session-resource.ts';
import { openWebSessionNames } from './web-session-names.ts';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';

export async function stopSessionAppLog(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<void> {
  const { session, sessionName, sessionStore } = params;
  if (!session.appLog) return;
  await forceCleanupSessionAppLog({
    session,
    sessionName,
    sessionStore,
    resourcePath: appLogResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName)),
  });
}

export async function stopSessionPerfCapture(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<void> {
  const currentSession = params.sessionStore.get(params.sessionName) ?? params.session;
  if (!currentSession.perfCapture) return;
  await finishLivePerfCapture({ ...params, session: currentSession });
}

export async function stopSessionSnapshotHelper(
  session: SessionState,
  platformCleanup: PlatformResourceCleanup,
): Promise<void> {
  await platformCleanup.stopSnapshotHelper(session.device);
}

// Best-effort mirror of the platform close `session close` dispatches for a web session
// (`shouldDispatchPlatformClose` in daemon/handlers/session-close.ts) so a daemon shutdown or
// expired-session reap tells agent-browser to close its fleet immediately instead of leaving it
// for agent-browser's own idle timer (`DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS`). Unlike its
// siblings above, this has no second caller in the ordinary-close path (that path already
// reaches the browser through `dispatchTargetedPlatformClose`), so it stays module-private.
async function stopSessionWebBrowser(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  platformCleanup: PlatformResourceCleanup;
}): Promise<void> {
  const { session, sessionName, sessionStore, platformCleanup } = params;
  await platformCleanup.closeManagedBrowser({
    device: session.device,
    sessionName,
    stateDir: sessionStore.resolveDaemonStateDir(),
    openSessionNames: () => openWebSessionNames(sessionStore),
  });
}

type SessionCleanupStep = { step: string; run: () => Promise<void> };
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
      hint: 'Some session resources failed to release; inspect the session log for per-resource diagnostics. The session was still deleted, so retrying is safe.',
    },
  );
}

type SessionResourceTeardownRequest = {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  stateDir?: string;
  appLog: 'run' | 'already-settled';
  platformCleanup?: PlatformResourceCleanup;
};

export async function teardownSessionResources(
  request: SessionResourceTeardownRequest,
): Promise<void> {
  const { session, sessionName, sessionStore } = request;
  if (!request.platformCleanup) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Platform resource cleanup was not supplied by root runtime composition',
    );
  }
  const platformCleanup = request.platformCleanup;
  const appLogSteps: SessionCleanupStep[] =
    request.appLog === 'run'
      ? [
          {
            step: 'app_log',
            run: () => stopSessionAppLog({ session, sessionName, sessionStore }),
          },
        ]
      : [];
  const steps: SessionCleanupStep[] = [
    // Finalize any still-active recording BEFORE the Apple runner is stopped
    // below: the runner supplies gesture-telemetry for overlay finalization, and
    // signalling the recorder first prevents a leaked `simctl recordVideo` child
    // (and its 0-byte, slot-holding mp4) when a session is torn down — including
    // on daemon shutdown — without an explicit `record stop`.
    {
      step: 'recording',
      run: () =>
        finishSessionScreenRecording({
          session,
          sessionName,
          sessionStore,
        }),
    },
    ...appLogSteps,
    {
      step: 'audio_probe',
      run: () => finishSessionAudioProbe({ session, sessionName, sessionStore }),
    },
    {
      step: 'perf_capture',
      run: () => stopSessionPerfCapture({ session, sessionName, sessionStore }),
    },
    {
      step: 'platform_snapshot_helper',
      run: () => stopSessionSnapshotHelper(session, platformCleanup),
    },
    // Runs after the resource steps above (recording, app-log, audio, perf) so nothing is still
    // reading through the browser when it closes, mirroring the ordering `runSessionCloseTeardown`
    // uses for an ordinary `session close`: best-effort resources first, platform close after.
    {
      step: 'web_browser',
      run: () =>
        stopSessionWebBrowser({
          session,
          sessionName,
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

export async function finishSessionScreenRecording(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<void> {
  const currentSession = params.sessionStore.get(params.sessionName) ?? params.session;
  if (!currentSession.screenRecording) return;
  await finishLiveScreenRecording({
    session: currentSession,
    sessionName: params.sessionName,
    sessionStore: params.sessionStore,
  });
}

export async function finishSessionAudioProbe(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<void> {
  const currentSession = params.sessionStore.get(params.sessionName) ?? params.session;
  if (!currentSession.audioProbe) return;
  await finishLiveAudioProbe({
    session: currentSession,
    sessionName: params.sessionName,
    sessionStore: params.sessionStore,
  });
}
