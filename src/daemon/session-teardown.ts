import { AppError } from '../kernel/errors.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { isMacOs, isApplePlatform } from '../kernel/device.ts';
import { runMacOsAlertAction } from '../platforms/apple/os/macos/helper.ts';
import { stopAppLog } from './app-log.ts';
import { stopIosRunnerSession } from '../platforms/apple/core/runner/runner-client.ts';
import { cleanupAppleXctracePerfCapture } from '../platforms/apple/core/perf-xctrace.ts';
import { cleanupAndroidNativePerfSession } from '../platforms/android/perf.ts';
import { stopAndroidSnapshotHelperSessionForDevice } from '../platforms/android/snapshot-helper.ts';
import { restoreAndroidTestIme } from '../platforms/android/ime-lifecycle.ts';
import { cleanupRetainedMaterializedPathsForSession } from './materialized-path-registry.ts';
import { stopSessionAudioProbe } from './audio-probe.ts';
import type { SessionState } from './types.ts';

export { stopSessionAudioProbe } from './audio-probe.ts';

export async function stopAppleRunnerForClose(session: SessionState): Promise<void> {
  await stopIosRunnerSession(session.device.id);
  if (!isMacOs(session.device)) {
    return;
  }

  const dismissOptions =
    session.surface === 'frontmost-app'
      ? { surface: 'frontmost-app' as const }
      : session.appBundleId
        ? { bundleId: session.appBundleId }
        : {};
  await runMacOsAlertAction('dismiss', dismissOptions).catch((error) => {
    emitDiagnostic({
      level: 'debug',
      phase: 'macos_close_alert_dismiss_failed',
      data: {
        session: session.name,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  });
}

export async function stopSessionAppLog(session: SessionState): Promise<void> {
  if (!session.appLog) return;
  await stopAppLog(session.appLog);
}

export async function stopSessionApplePerfCapture(session: SessionState): Promise<void> {
  if (!session.applePerf?.active) return;
  await cleanupAppleXctracePerfCapture(session.applePerf.active);
  session.applePerf = { ...(session.applePerf ?? {}), active: undefined };
}

export async function stopSessionAndroidNativePerfCapture(session: SessionState): Promise<void> {
  const active = session.nativePerf?.android;
  if (!active) return;
  await cleanupAndroidNativePerfSession(session.device, active);
  session.nativePerf = { ...(session.nativePerf ?? {}), android: undefined };
}

export async function stopSessionAndroidSnapshotHelper(session: SessionState): Promise<void> {
  if (session.device.platform !== 'android') return;
  await stopAndroidSnapshotHelperSessionForDevice(session.device);
}

export async function restoreSessionAndroidIme(
  session: SessionState,
  stateDir?: string,
): Promise<void> {
  if (session.device.platform !== 'android') return;
  await restoreAndroidTestIme(session.device, { stateDir }).catch((error) => {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_restore_failed',
      data: {
        session: session.name,
        error: error instanceof Error ? error.message : String(error),
      },
    });
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

export async function teardownSessionResources(
  session: SessionState,
  sessionName: string,
  stateDir?: string,
): Promise<void> {
  const steps: SessionCleanupStep[] = [
    { step: 'app_log', run: () => stopSessionAppLog(session) },
    {
      step: 'audio_probe',
      run: async () => {
        await stopSessionAudioProbe(session, 'session-teardown');
      },
    },
    { step: 'apple_perf', run: () => stopSessionApplePerfCapture(session) },
    { step: 'android_native_perf', run: () => stopSessionAndroidNativePerfCapture(session) },
    { step: 'android_snapshot_helper', run: () => stopSessionAndroidSnapshotHelper(session) },
    { step: 'android_ime', run: () => restoreSessionAndroidIme(session, stateDir) },
  ];
  if (isApplePlatform(session.device.platform)) {
    steps.push({ step: 'apple_runner', run: () => stopAppleRunnerForClose(session) });
  }
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
