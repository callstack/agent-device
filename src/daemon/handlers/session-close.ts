import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { scheduleIosRunnerIdleStop } from '../../platforms/apple/core/runner/runner-client.ts';
import { isApplePlatform, type DeviceInfo } from '../../kernel/device.ts';
import { dispatchCommand } from '../../core/dispatch.ts';
import { contextFromFlags } from '../context.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { clearRuntimeHintsFromApp, hasRuntimeTransportHints } from '../runtime-hints.ts';
import { cleanupRetainedMaterializedPathsForSession } from '../materialized-path-registry.ts';
import {
  canShutdownDeviceTarget,
  shutdownDeviceTarget,
  type DeviceTargetShutdownResult,
} from '../target-shutdown.ts';
import { successText, withSuccessText } from '../../utils/success-text.ts';
import {
  IOS_SIMULATOR_POST_CLOSE_SETTLE_MS,
  isIosSimulator,
  resolveCommandDevice,
  settleIosSimulator,
} from './session-device-utils.ts';
import { errorResponse } from './response.ts';
import { recordSessionAction } from './handler-utils.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import { releaseSessionLease } from '../lease-lifecycle.ts';
import type { LeaseLifecycleProvider } from './lease.ts';
import {
  reportSessionCleanupFailures,
  restoreSessionAndroidIme,
  stopAppleRunnerForClose,
  stopSessionAndroidNativePerfCapture,
  stopSessionAndroidSnapshotHelper,
  stopSessionAppLog,
  stopSessionApplePerfCapture,
  stopSessionAudioProbe,
  type SessionCleanupFailure,
} from '../session-teardown.ts';

async function maybeShutdownSessionTarget(params: {
  device: DeviceInfo;
  shutdownRequested: boolean | undefined;
}): Promise<DeviceTargetShutdownResult | undefined> {
  const { device, shutdownRequested } = params;
  if (!shutdownRequested) return undefined;
  if (!canShutdownDeviceTarget(device)) return undefined;
  return await shutdownDeviceTarget(device);
}

function shouldRetainAppleRunnerAfterClose(req: DaemonRequest, session: SessionState): boolean {
  return (
    isIosSimulator(session.device) &&
    !req.flags?.shutdown &&
    !session.recording &&
    !session.lease &&
    !session.device.simulatorSetPath
  );
}

function shouldStopAppleRunnerBeforeTargetedClose(session: SessionState): boolean {
  return isApplePlatform(session.device.platform) && !isIosSimulator(session.device);
}

// Runs the failure-isolated resource teardown and the targeted platform close.
// Returns the preserved platform-close error (if any); best-effort cleanup
// failures are pushed into `cleanupFailures`. Never throws for a cleanup step so
// the caller's lease release and session deletion always run.
async function runSessionCloseTeardown(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  cleanupFailures: SessionCleanupFailure[];
}): Promise<unknown> {
  const { req, session, sessionName, logPath, sessionStore, cleanupFailures } = params;
  const attemptCleanup = async (step: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      cleanupFailures.push({ step, error });
    }
  };
  await stopBestEffortSessionResources(session, sessionStore, attemptCleanup);
  // The targeted platform close is the primary operation, not best-effort cleanup:
  // its AppError (code/details/hint) is preserved and returned for the caller to
  // rethrow, and a failed close must not be recorded as `Closed`. Subsequent
  // resource cleanup still runs regardless.
  const platformCloseError = await dispatchTargetedPlatformClose({
    req,
    session,
    logPath,
  });
  await stopOrRetainAppleRunnerAfterClose(req, session, attemptCleanup);
  await clearSessionRuntimeHints(session, sessionStore, sessionName);
  if (!platformCloseError) {
    recordSessionAction(sessionStore, session, req, 'close', {
      session: session.name,
      ...successText(`Closed: ${session.name}`),
    });
  }
  if (req.flags?.saveScript) {
    session.recordSession = true;
  }
  sessionStore.writeSessionLog(session);
  await attemptCleanup('materialized_paths', () =>
    cleanupRetainedMaterializedPathsForSession(sessionName),
  );
  return platformCloseError;
}

type CleanupRunner = (step: string, run: () => Promise<void>) => Promise<void>;

async function stopBestEffortSessionResources(
  session: SessionState,
  sessionStore: SessionStore,
  attemptCleanup: CleanupRunner,
): Promise<void> {
  await attemptCleanup('app_log', () => stopSessionAppLog(session));
  await attemptCleanup('audio_probe', async () => {
    await stopSessionAudioProbe(session, 'session-close');
  });
  await attemptCleanup('apple_perf', () => stopSessionApplePerfCapture(session));
  await attemptCleanup('android_native_perf', () => stopSessionAndroidNativePerfCapture(session));
  await attemptCleanup('android_snapshot_helper', () => stopSessionAndroidSnapshotHelper(session));
  await attemptCleanup('android_ime', () =>
    restoreSessionAndroidIme(session, sessionStore.resolveDaemonStateDir()),
  );
}

async function dispatchTargetedPlatformClose(params: {
  req: DaemonRequest;
  session: SessionState;
  logPath: string;
}): Promise<unknown> {
  const { req, session, logPath } = params;
  if (!shouldDispatchPlatformClose(req, session)) return undefined;
  if (shouldStopAppleRunnerBeforeTargetedClose(session)) {
    // Non-simulator Apple targets must stop the runner before the platform close
    // is dispatched (the runner owns the device connection). This is a required
    // dependency, not best-effort cleanup: if it fails, skip the close dispatch
    // and preserve the original failure. Later independent cleanup still runs.
    try {
      await stopAppleRunnerForClose(session);
    } catch (error) {
      return error;
    }
  }
  try {
    await dispatchCommand(session.device, 'close', req.positionals ?? [], req.flags?.out, {
      ...contextFromFlags(logPath, req.flags, session.appBundleId, session.trace?.outPath),
    });
    await settleIosSimulator(session.device, IOS_SIMULATOR_POST_CLOSE_SETTLE_MS);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function clearSessionRuntimeHints(
  session: SessionState,
  sessionStore: SessionStore,
  sessionName: string,
): Promise<void> {
  const runtime = sessionStore.getRuntimeHints(sessionName);
  if (!hasRuntimeTransportHints(runtime) || !session.appBundleId) return;
  await clearRuntimeHintsFromApp({
    device: session.device,
    appId: session.appBundleId,
  }).catch(() => {});
}

async function stopOrRetainAppleRunnerAfterClose(
  req: DaemonRequest,
  session: SessionState,
  attemptCleanup: CleanupRunner,
): Promise<void> {
  if (!isApplePlatform(session.device.platform)) return;
  if (!shouldRetainAppleRunnerAfterClose(req, session)) {
    // The targeted close path stops before dispatch to avoid runner/app races.
    // Stop again here for idempotent cleanup, and keep cleanup-sensitive closes explicit.
    await attemptCleanup('apple_runner', () => stopAppleRunnerForClose(session));
    return;
  }
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_retained_after_close',
    data: {
      session: session.name,
      deviceId: session.device.id,
    },
  });
  // A retained runner holds the device's runner lease against every other
  // daemon; bound that with an idle stop unless something reuses it first.
  scheduleIosRunnerIdleStop(session.device.id);
}

export async function handleCloseCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, leaseRegistry, leaseLifecycleProvider } = params;
  const session = sessionStore.get(sessionName);
  if (!session) {
    return await closeWithoutSession(req, logPath);
  }
  let providerData: Record<string, unknown> | undefined;
  // Resource teardown is failure-isolated: a rejected step is collected instead of
  // short-circuiting the rest, so every subsequent resource (and the runner stop)
  // is still attempted. Lease release and session deletion below run regardless,
  // and any collected failures are surfaced as an aggregate after cleanup.
  const cleanupFailures: SessionCleanupFailure[] = [];
  let platformCloseError: unknown;
  try {
    platformCloseError = await runSessionCloseTeardown({
      req,
      session,
      sessionName,
      logPath,
      sessionStore,
      cleanupFailures,
    });
  } finally {
    // Always drop the local session, even if provider-side release fails:
    // a failed close must not strand device ownership until inactivity expiry.
    try {
      providerData = await releaseSessionLease({ session, leaseRegistry, leaseLifecycleProvider });
    } finally {
      sessionStore.delete(sessionName);
    }
  }
  const cleanupAggregate = reportSessionCleanupFailures({
    sessionName,
    phase: 'session_close_cleanup_failed',
    failures: cleanupFailures,
  });
  // The platform-close failure is the primary error: rethrow it with its original
  // code/details/hint intact. The cleanup aggregate has already been emitted as a
  // diagnostic above so per-resource failures stay visible.
  if (platformCloseError) throw platformCloseError;
  if (cleanupAggregate) throw cleanupAggregate;
  const shutdownResult = await maybeShutdownSessionTarget({
    device: session.device,
    shutdownRequested: req.flags?.shutdown,
  });
  if (shutdownResult) {
    return {
      ok: true,
      data: withSuccessText(
        {
          session: session.name,
          shutdown: shutdownResult,
          ...(providerData ? { provider: providerData } : {}),
        },
        `Closed: ${session.name}`,
      ),
    };
  }
  return {
    ok: true,
    data: {
      session: session.name,
      ...successText(`Closed: ${session.name}`),
      ...(providerData ? { provider: providerData } : {}),
    },
  };
}

function shouldDispatchPlatformClose(req: DaemonRequest, session: SessionState): boolean {
  return hasCloseTarget(req) || session.device.platform === 'web';
}

function hasCloseTarget(req: DaemonRequest): boolean {
  return (req.positionals?.length ?? 0) > 0;
}

async function closeWithoutSession(req: DaemonRequest, logPath: string): Promise<DaemonResponse> {
  if (!req.positionals || req.positionals.length === 0) {
    return errorResponse('SESSION_NOT_FOUND', 'No active session');
  }
  const device = await resolveCommandDevice({
    session: undefined,
    flags: req.flags,
    ensureReady: true,
  });
  await dispatchCommand(device, 'close', req.positionals, req.flags?.out, {
    ...contextFromFlags(logPath, req.flags),
  });
  await settleIosSimulator(device, IOS_SIMULATOR_POST_CLOSE_SETTLE_MS);
  return {
    ok: true,
    data: {
      app: req.positionals[0],
      ...successText(`Closed: ${req.positionals[0]}`),
    },
  };
}
