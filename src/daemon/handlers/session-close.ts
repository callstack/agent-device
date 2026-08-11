import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { scheduleIosRunnerIdleStop } from '../../platforms/apple/core/runner/runner-client.ts';
import { isApplePlatform, type DeviceInfo } from '@agent-device/kernel/device';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
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
import { expireRefFrame } from '../ref-frame.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import { releaseSessionLease } from '../lease-lifecycle.ts';
import type { LeaseLifecycleProvider } from '@agent-device/contracts/device';
import {
  hasRepairPlatformCloseReceipt,
  isRepairArmedSession,
  recordRepairPlatformClose,
} from '../session-replay-transaction.ts';
import { isAuthoringArmedSession } from '../session-script-publication-capability.ts';
import {
  reportSessionCleanupFailures,
  finishSessionScreenRecording,
  restoreSessionAndroidIme,
  stopAppleRunnerForClose,
  stopSessionAndroidNativePerfCapture,
  stopSessionAndroidSnapshotHelper,
  stopSessionAppLog,
  stopSessionApplePerfCapture,
  stopSessionAudioProbe,
  type SessionCleanupFailure,
} from '../session-teardown.ts';
import { clearDeviceClaim } from '../device-claims.ts';
import {
  buildRetriableRepairCloseFailureResponse,
  commitRepairScriptBeforeClose,
  finalizeOrdinaryCloseScript,
} from './session-close-script.ts';

async function maybeShutdownSessionTarget(params: {
  device: DeviceInfo;
  shutdownRequested: boolean | undefined;
}): Promise<DeviceTargetShutdownResult | undefined> {
  const { device, shutdownRequested } = params;
  if (!shutdownRequested) return undefined;
  if (isActiveProviderDevice(device)) return undefined;
  if (!canShutdownDeviceTarget(device)) return undefined;
  return await shutdownDeviceTarget(device);
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

function shouldStopAppleRunnerBeforeTargetedClose(session: SessionState): boolean {
  return isApplePlatform(session.device.platform) && !isIosSimulator(session.device);
}

function toRepairPlatformCloseFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new AppError('COMMAND_FAILED', `The platform close failed: ${detail}`, {
    hint: 'The repair transaction was not committed because the platform close failed; fix the underlying issue and retry close --save-script.',
  });
}

type SessionCloseTeardownResult = {
  platformCloseError: unknown;
  saveScriptError?: AppError;
};

async function runSessionCloseTeardown(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  cleanupFailures: SessionCleanupFailure[];
  repairArmed: boolean;
}): Promise<SessionCloseTeardownResult> {
  const { req, session, sessionName, logPath, sessionStore, cleanupFailures, repairArmed } = params;
  const attemptCleanup = async (step: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      cleanupFailures.push({ step, error });
    }
  };
  const retainAppleRunner = shouldRetainAppleRunnerAfterClose(req, session);
  await stopBestEffortSessionResources(session, sessionStore, attemptCleanup);
  const platformCloseError = repairArmed
    ? undefined
    : await dispatchTargetedPlatformClose({ req, session, logPath });
  await stopOrRetainAppleRunnerAfterClose(retainAppleRunner, session, attemptCleanup);
  await clearSessionRuntimeHints(session, sessionStore, sessionName);
  const saveScriptError = repairArmed
    ? undefined
    : finalizeOrdinaryCloseScript({ req, session, sessionStore, platformCloseError });
  await attemptCleanup('materialized_paths', () =>
    cleanupRetainedMaterializedPathsForSession(sessionName),
  );
  return { platformCloseError, saveScriptError };
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
  await attemptCleanup('app_log', () => stopSessionAppLog({ session, sessionStore }));
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

function buildRepairPlatformCloseReceipt(req: DaemonRequest): string {
  return JSON.stringify(req.positionals ?? []);
}

type RepairClosePreparation =
  | { repairArmed: boolean; healedScriptPath?: string; aborted?: boolean }
  | { response: DaemonResponse };

async function prepareRepairClose(params: {
  req: DaemonRequest;
  session: SessionState;
  logPath: string;
  sessionStore: SessionStore;
}): Promise<RepairClosePreparation> {
  const { req, session, logPath, sessionStore } = params;
  const repairArmed = isRepairArmedSession(session);
  const closeReceipt = buildRepairPlatformCloseReceipt(req);
  if (repairArmed && !hasRepairPlatformCloseReceipt(session, closeReceipt)) {
    const platformCloseError = await dispatchTargetedPlatformClose({ req, session, logPath });
    if (platformCloseError) {
      // Platform-close failure leaves the transaction state unchanged: no receipt is recorded,
      // so the retry dispatches afresh.
      return {
        response: buildRetriableRepairCloseFailureResponse(
          session,
          toRepairPlatformCloseFailure(platformCloseError),
        ),
      };
    }
    recordRepairPlatformClose(session, closeReceipt);
  }
  const repairCommit = commitRepairScriptBeforeClose(sessionStore, session, req);
  if (repairCommit.kind === 'failed') {
    // Publication failure retains target, force, and the close receipt; the same-identity retry
    // skips close dispatch above.
    return {
      response: buildRetriableRepairCloseFailureResponse(session, repairCommit.error),
    };
  }
  return {
    repairArmed,
    ...(repairCommit.kind === 'committed' && repairCommit.path
      ? { healedScriptPath: repairCommit.path }
      : {}),
    ...(repairCommit.kind === 'aborted' ? { aborted: true } : {}),
  };
}

async function releaseProviderLeaseForClose(params: {
  session: SessionState;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider: LeaseLifecycleProvider | undefined;
}): Promise<{ providerData?: Record<string, unknown>; response?: DaemonResponse }> {
  try {
    return { providerData: await releaseSessionLease(params) };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      response: {
        ok: false,
        error: {
          ...normalized,
          hint: 'The provider device could not be released. Retry close after the provider is reachable.',
          details: { ...normalized.details, session: params.session.name },
          retriable: true,
        },
      },
    };
  }
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
    // ADR 0014 side-effect seam: close mutates the device. The frame expires
    // here for uniformity, though a successful close deletes the whole session
    // (and its frame) in handleCloseCommand's finally, so nothing is restored.
    expireRefFrame(session);
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
  retainAppleRunner: boolean,
  session: SessionState,
  attemptCleanup: CleanupRunner,
): Promise<void> {
  if (!isApplePlatform(session.device.platform)) return;
  if (!retainAppleRunner) {
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

// Live evidence (2026-08-02): a plain `open` followed by `close --save-script` used to fold into
// the authoring lifecycle at close time (`applyRecordedSaveScriptFlags`'s `none -> authoring`
// branch) and publish anyway. That silently produces a script whose actions carry selector
// fallback chains but no `target-v1` recording-time evidence — degraded replay verification with
// no signal to the caller. Recording-time evidence can only be captured from action zero
// (`armAuthoringOnOpen`), so an unarmed session has nothing to retroactively arm; the only
// correct response is refusal, before any teardown or publication work runs.
//
// #1533 (aborted-mid-recording) is the adjacent already-armed case: this refusal promises "plain
// close tears down without writing", and an ABORTED authoring lifecycle keeps that promise —
// recording is derived from the lifecycle (`isSessionRecording`), so no surface can re-arm it
// behind the terminal status, and the writer refuses to publish it from every path that reaches it.
function assertTerminalRecordingCloseAllowed(req: DaemonRequest, session: SessionState): void {
  if (!req.flags?.saveScript) return;
  if (isAuthoringArmedSession(session)) return;
  const state = session.scriptPublication;
  if (state?.kind === 'repair') return;
  if (state === undefined || state.kind === 'none') {
    throw new AppError(
      'INVALID_ARGS',
      'close --save-script cannot publish this session: recording was not armed before this journey began, so there is no recording-time target evidence to publish.',
      {
        hint: 'Retry with plain close (it tears down without writing). To capture a publishable recording, start a fresh session with open <app> --save-script[=<path>].',
      },
    );
  }
  throw new AppError(
    'INVALID_ARGS',
    `close --save-script cannot ${state.status === 'published' ? 're-publish' : 'publish'} this terminal recording. Retry with plain close; it will tear down the session without writing.`,
  );
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
  assertTerminalRecordingCloseAllowed(req, session);
  if (req.internal?.closeAppOnly === true) {
    return await closeAppWithoutEndingSession({ req, session, logPath });
  }
  const repair = await prepareRepairClose({ req, session, logPath, sessionStore });
  if ('response' in repair) return repair.response;
  const closed = await runCloseTeardownAndRelease({
    req,
    session,
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider,
    repairArmed: repair.repairArmed,
  });
  if (closed.kind === 'response') return closed.response;
  const shutdownResult = await maybeShutdownSessionTarget({
    device: session.device,
    shutdownRequested: req.flags?.shutdown,
  });
  return buildCloseSuccessResponse({
    session,
    repair,
    requestedSaveScript: Boolean(req.flags?.saveScript),
    shutdownResult,
    providerData: closed.providerData,
  });
}

type SessionCloseFinalization =
  | { kind: 'response'; response: DaemonResponse }
  | { kind: 'closed'; providerData?: Record<string, unknown> };

// Everything between a settled repair decision and a success response:
// failure-isolated resource teardown, provider lease release, then (only
// once both are known) the device-claim clear and session delete. A failed
// lease release keeps the session retryable instead (`{kind:'response'}`).
async function runCloseTeardownAndRelease(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider: LeaseLifecycleProvider | undefined;
  repairArmed: boolean;
}): Promise<SessionCloseFinalization> {
  const {
    req,
    session,
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider,
  } = params;
  const cleanupFailures: SessionCleanupFailure[] = [];
  const { platformCloseError, saveScriptError } = await runSessionCloseTeardown({
    req,
    session,
    sessionName,
    logPath,
    sessionStore,
    cleanupFailures,
    repairArmed: params.repairArmed,
  });
  const leaseRelease = await releaseProviderLeaseForClose({
    session,
    leaseRegistry,
    leaseLifecycleProvider,
  });
  if (leaseRelease.response) return { kind: 'response', response: leaseRelease.response };
  const cleanupAggregate = reportSessionCleanupFailures({
    sessionName,
    phase: 'session_close_cleanup_failed',
    failures: cleanupFailures,
  });
  const deviceClaimBlockingError = platformCloseError ?? cleanupAggregate;
  if (deviceClaimBlockingError) {
    if (session.deviceClaim) {
      emitDiagnostic({
        level: 'warn',
        phase: 'device_claim_close_effects_unconfirmed',
        data: {
          deviceKey: session.deviceClaim.deviceKey,
          session: sessionName,
        },
      });
    }
  } else {
    await clearDeviceClaim(session.deviceClaim);
  }
  sessionStore.delete(sessionName);
  if (deviceClaimBlockingError) throw deviceClaimBlockingError;
  if (saveScriptError) throw saveScriptError;
  return { kind: 'closed', providerData: leaseRelease.providerData };
}

function buildCloseSuccessResponse(params: {
  session: SessionState;
  repair: Extract<RepairClosePreparation, { repairArmed: boolean }>;
  requestedSaveScript: boolean;
  shutdownResult: DeviceTargetShutdownResult | undefined;
  providerData: Record<string, unknown> | undefined;
}): DaemonResponse {
  const { session, repair, requestedSaveScript, shutdownResult, providerData } = params;
  if (repair.aborted && requestedSaveScript) {
    return {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'The repair was aborted and no script was written.',
        hint: 'Recovery: replay --from <n> --plan-digest <digest> before closing.',
        details: { session: session.name },
      },
    };
  }
  // ADR 0012 decision 6 (BLOCKER 2a): positively report the committed healed
  // artifact path so the agent learns the repair published (and where) without
  // an extra round-trip.
  const savedScript = repair.healedScriptPath ? { savedScript: repair.healedScriptPath } : {};
  const provider = providerData ? { provider: providerData } : {};
  const text = `Closed: ${session.name}`;
  if (shutdownResult) {
    return {
      ok: true,
      data: withSuccessText(
        { session: session.name, shutdown: shutdownResult, ...savedScript, ...provider },
        text,
      ),
    };
  }
  return {
    ok: true,
    data: { session: session.name, ...successText(text), ...savedScript, ...provider },
  };
}

async function closeAppWithoutEndingSession(params: {
  req: DaemonRequest;
  session: SessionState;
  logPath: string;
}): Promise<DaemonResponse> {
  const { req, session, logPath } = params;
  const app = req.positionals?.[0];
  if (!app) {
    return errorResponse('INVALID_ARGS', 'App-only close requires an app target');
  }
  const platformCloseError = await dispatchTargetedPlatformClose({ req, session, logPath });
  if (platformCloseError) throw platformCloseError;
  return {
    ok: true,
    data: {
      app,
      ...successText(`Closed: ${app}`),
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
