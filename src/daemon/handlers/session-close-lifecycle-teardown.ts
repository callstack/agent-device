import type { CloseApplicationFinalizationResult } from '@agent-device/contracts/platform';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import type { DaemonRequest, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { cleanupRetainedMaterializedPathsForSession } from '../materialized-path-registry.ts';
import {
  reportSessionCleanupFailures,
  finishSessionAudioProbe,
  finishSessionScreenRecording,
  stopSessionAndroidNativePerfCapture,
  stopSessionAndroidSnapshotHelper,
  stopSessionAppLog,
  stopSessionApplePerfCapture,
  type SessionCleanupFailure,
} from '../session-teardown.ts';
import { hasRuntimeTransportHints, runtimeHintValues } from './session-runtime.ts';
import { isIosSimulator } from './session-device-utils.ts';
import type {
  CloseRuntime,
  CloseRuntimeWithRuntimeHintClear,
  RuntimeHintClearOperation,
} from './session-close-runtime-admission.ts';

export type PlatformCloseDispatcher = (params: {
  req: DaemonRequest;
  session: SessionState;
  logPath: string;
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
}) => Promise<unknown>;

export type SessionCloseTeardownResult = Readonly<{
  platformCloseError: unknown;
  saveScriptError?: Error;
  shutdownResult?: TargetShutdownResult;
}>;

/** Runs owned resources, native close, native hint cleanup, and final lifecycle disposal. */
export async function runSessionCloseTeardown(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
  clearRuntimeHints?: RuntimeHintClearOperation;
  cleanupFailures: SessionCleanupFailure[];
  repairArmed: boolean;
  dispatchTargetedPlatformClose: PlatformCloseDispatcher;
  finalizeOrdinaryCloseScript(input: {
    req: DaemonRequest;
    session: SessionState;
    sessionStore: SessionStore;
    platformCloseError: unknown;
  }): Error | undefined;
}): Promise<SessionCloseTeardownResult> {
  const {
    req,
    session,
    sessionName,
    logPath,
    sessionStore,
    lifecycle,
    clearRuntimeHints,
    cleanupFailures,
    repairArmed,
    dispatchTargetedPlatformClose,
    finalizeOrdinaryCloseScript,
  } = params;
  const attemptCleanup = async <Result>(
    step: string,
    run: () => Promise<Result>,
  ): Promise<Result | undefined> => {
    try {
      return await run();
    } catch (error) {
      cleanupFailures.push({ step, error });
      return undefined;
    }
  };
  const retainAppleRunner = shouldRetainAppleRunnerAfterClose(req, session);
  const configuredRuntimeHints = sessionStore.getRuntimeHints(sessionName);
  await stopBestEffortSessionResources(session, sessionStore, attemptCleanup);
  const platformCloseError = repairArmed
    ? undefined
    : await dispatchTargetedPlatformClose({ req, session, logPath, lifecycle });
  if (
    clearRuntimeHints &&
    session.appBundleId &&
    hasRuntimeTransportHints(configuredRuntimeHints)
  ) {
    await attemptCleanup('runtime_hints', async () => {
      await clearRuntimeHints({
        appId: session.appBundleId,
        values: runtimeHintValues(configuredRuntimeHints),
      });
    });
  }
  const finalization = await attemptCleanup(
    'application_lifecycle',
    async (): Promise<CloseApplicationFinalizationResult> =>
      (await lifecycle.operations.finalizeApplicationClose({
        appBundleId: session.appBundleId,
        surface: session.surface ?? 'app',
        retainRunner: retainAppleRunner,
        stateDir: sessionStore.resolveDaemonStateDir(),
        shutdownTarget: req.flags?.shutdown === true,
      })) ?? {},
  );
  const saveScriptError = repairArmed
    ? undefined
    : finalizeOrdinaryCloseScript({ req, session, sessionStore, platformCloseError });
  await attemptCleanup('materialized_paths', () =>
    cleanupRetainedMaterializedPathsForSession(sessionName),
  );
  return { platformCloseError, saveScriptError, shutdownResult: finalization?.shutdown };
}

function shouldRetainAppleRunnerAfterClose(req: DaemonRequest, session: SessionState): boolean {
  return (
    isIosSimulator(session.device) &&
    !req.flags?.shutdown &&
    !session.screenRecording &&
    !session.lease &&
    !session.device.simulatorSetPath
  );
}

type CleanupRunner = (step: string, run: () => Promise<void>) => Promise<void>;

async function stopBestEffortSessionResources(
  session: SessionState,
  sessionStore: SessionStore,
  attemptCleanup: CleanupRunner,
): Promise<void> {
  // Recording overlay finalization needs the Apple runner.
  const currentSession = sessionStore.get(session.name) ?? session;
  if (currentSession.screenRecording) {
    await attemptCleanup('recording', () =>
      finishSessionScreenRecording({
        session: currentSession,
        sessionName: session.name,
        sessionStore,
      }),
    );
  }
  await attemptCleanup('app_log', () =>
    stopSessionAppLog({ session, sessionName: session.name, sessionStore }),
  );
  await attemptCleanup('audio_probe', () =>
    finishSessionAudioProbe({ session, sessionName: session.name, sessionStore }),
  );
  await attemptCleanup('apple_perf', () => stopSessionApplePerfCapture(session));
  await attemptCleanup('android_native_perf', () => stopSessionAndroidNativePerfCapture(session));
  await attemptCleanup('android_snapshot_helper', () => stopSessionAndroidSnapshotHelper(session));
}

export function closeCleanupError(
  sessionName: string,
  failures: readonly SessionCleanupFailure[],
): Error | undefined {
  return reportSessionCleanupFailures({
    sessionName,
    phase: 'session_close_cleanup_failed',
    failures,
  });
}
