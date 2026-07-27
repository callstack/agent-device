import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { AppError, normalizeError } from '../../kernel/errors.ts';
import { scheduleIosRunnerIdleStop } from '../../platforms/apple/core/runner/runner-client.ts';
import { isApplePlatform, type DeviceInfo } from '../../kernel/device.ts';
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
import { recordSessionAction } from './handler-utils.ts';
import { stopSessionRecordingForTeardown } from './record-trace-recording.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import { releaseSessionLease } from '../lease-lifecycle.ts';
import type { LeaseLifecycleProvider } from '../../contracts/device-provider.ts';
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
import { clearAdvisoryDeviceClaim } from '../device-claims.ts';

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

/**
 * #1258: the effective `--force`/`--overwrite` decision for a `close`-time
 * publish — this close request's own flag OR'd with whatever was persisted
 * on the session at an earlier arm (`open --save-script --force`, or a
 * repair's first `replay --save-script --force`). Either source authorizes
 * overwriting; neither being set keeps the default refuse-on-exist.
 */
function resolveEffectiveSaveScriptForce(req: DaemonRequest, session: SessionState): boolean {
  return Boolean(req.flags?.force || session.saveScriptForce);
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

/**
 * ADR 0012 decision 6 (BLOCKER 2): outcome of committing a repair transaction
 * at `close` time, BEFORE any destructive teardown. `not-armed` = not a repair
 * session (normal close flow); `committed` = the healed `.ad` was written
 * (`path`) or the transaction was incomplete and intentionally discarded (no
 * `path`) — either way close proceeds and tears the session down; `failed` = a
 * COMPLETE transaction's commit failed (no-clobber / bare-`@ref` / fs error),
 * so the session must be KEPT for retry and the failure surfaced.
 */
type RepairCloseOutcome =
  | { kind: 'not-armed' }
  | { kind: 'committed'; path?: string }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: AppError };

function commitRepairBeforeClose(
  sessionStore: SessionStore,
  session: SessionState,
  req: DaemonRequest,
): RepairCloseOutcome {
  if (session.saveScriptBoundary === undefined) return { kind: 'not-armed' };
  // Record the finalize `close` (so the committed healed slice ends with it),
  // then COMMIT before any destructive teardown. A repair-armed session commits
  // iff the transaction COMPLETED, regardless of `--save-script` on the close
  // (C2); `recordSession` is already true from arming.
  const actionsBeforeClose = session.actions.length;
  recordSessionAction(sessionStore, session, req, 'close', {
    session: session.name,
    ...successText(`Closed: ${session.name}`),
  });
  const result = sessionStore.writeSessionLog(session, {
    force: resolveEffectiveSaveScriptForce(req, session),
  });
  if (result.written) return { kind: 'committed', path: result.path };
  if (result.error) {
    // The session is kept for retry (BLOCKER 2b): roll back the just-recorded
    // finalize `close` so a subsequent `close --save-script=<other>` retry does
    // not accumulate duplicate `close` lines in the healed slice.
    session.actions.length = actionsBeforeClose;
    return { kind: 'failed', error: result.error };
  }
  if (!session.saveScriptComplete) {
    return { kind: 'aborted' };
  }
  return { kind: 'committed' };
}

/**
 * ADR 0012 decision 6 (BLOCKER 2b): a commit-failure close response. The session
 * is intentionally NOT torn down (the caller returns before teardown), so the
 * agent can fix the cause and retry `close --save-script`.
 *
 * BLOCKER 2 (second follow-up): routes `error` through the SAME
 * `normalizeError` normalization every other AppError -> DaemonResponse
 * conversion in this codebase uses (see `repairExpiredIfTombstoned` in
 * request-router.ts and the dozens of handler call sites doing
 * `{ ok: false, error: normalizeError(error) }`) — a hand-rolled reshape here
 * previously dropped the underlying platform/commit error's `details`,
 * `diagnosticId`, and `logPath` entirely, and put `retriable` under
 * `error.details.retriable`, a location neither the router's `enrichDaemonError`
 * nor the client reads (both read the TOP-LEVEL `error.retriable` — see
 * `DaemonError` in kernel/contracts.ts). `retriable: true` is still forced
 * unconditionally at the end: the session was preserved specifically so the
 * agent can retry (`close`/`close --save-script=<other>`), which must never
 * be contradicted by the underlying error's own (usually absent) classification.
 */
function buildRepairCloseFailureResponse(session: SessionState, error: AppError): DaemonResponse {
  const normalized = normalizeError(error);
  return {
    ok: false,
    error: {
      ...normalized,
      details: {
        ...normalized.details,
        session: session.name,
        ...(session.saveScriptPath ? { savedScript: session.saveScriptPath } : {}),
      },
      retriable: true,
    },
  };
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
  // #1391: an ordinary (non-repair) session's close-time script write (implicit
  // from `open --save-script`, or this close's own `--save-script`) can refuse
  // to publish (no-clobber target-exists, or any other fs AppError). Unlike the
  // repair-armed commit (which keeps its session alive for a `--force` retry —
  // ADR 0012 BLOCKER 2b), an ordinary session has no transaction to retry: its
  // `close` already ran (or was skipped) and its teardown below must still
  // release the lease/device claim and delete the session, exactly as a
  // `platformCloseError` does not block them either. Surfaced separately so
  // `handleCloseCommand` can report it AFTER teardown completes, never before.
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

/**
 * ADR 0012 decision 6 (BLOCKER 2): only an ordinary (non-repair) session
 * records its finalize `close` and writes its session log here — see the
 * call site's own comment for why a repair-armed session skips this entirely.
 *
 * #1391: the write can refuse to publish (no-clobber target-exists, or any
 * other fs `AppError`). Unlike a repair-armed commit failure — which keeps
 * its session alive so `commitRepairBeforeClose` must roll back its
 * just-recorded `close` action to keep a later retry from duplicating it —
 * this caller (`runSessionCloseTeardown`) always completes teardown and
 * deletes the session regardless of the outcome returned here, so there is
 * no surviving session for a retry to duplicate anything on. No rollback:
 * the recorded `close` action (and its durable `events.ndjson` entry) stay
 * exactly as they are — an accurate record that the close itself happened,
 * independent of whether the script also got saved.
 */
function finalizeOrdinaryCloseScript(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionStore: SessionStore;
  platformCloseError: unknown;
}): AppError | undefined {
  const { req, session, sessionStore, platformCloseError } = params;
  if (!platformCloseError) {
    recordSessionAction(sessionStore, session, req, 'close', {
      session: session.name,
      ...successText(`Closed: ${session.name}`),
    });
  }
  if (req.flags?.saveScript) {
    session.recordSession = true;
  }
  try {
    sessionStore.writeSessionLog(session, { force: resolveEffectiveSaveScriptForce(req, session) });
    return undefined;
  } catch (error) {
    return toOrdinaryCloseSaveScriptFailure(error);
  }
}

/**
 * #1391: normalizes an ordinary (non-repair) session's close-time script-write
 * failure. `SessionScriptWriter.write()` only ever throws a genuine `AppError`
 * here (a non-clobber refusal or another fs AppError — see
 * `handleSessionScriptWriteFailure`'s non-repair, non-active-publication
 * branch); anything else is already swallowed into a silent `{written:false}`
 * there. Only the message/hint/retriable are corrected for THIS call site (the
 * shared `publishHealedScriptAtomically` wording, "retry close --save-script",
 * describes the repair-commit retry contract, which does not apply here — by
 * the time the agent sees this, `close` has already released the device and
 * deleted the session, so there is nothing left to retry in place); the
 * original error's machine-readable `details` (e.g. `reason:
 * "script_target_exists"`, `path`) are preserved so a caller dispatching on
 * them still can.
 */
function toOrdinaryCloseSaveScriptFailure(error: unknown): AppError {
  const overrides = {
    hint: 'Remove the existing target (or pass --force/--overwrite), then re-record with open --save-script.',
    retriable: false,
  };
  if (error instanceof AppError) {
    return new AppError(
      'COMMAND_FAILED',
      `The session was closed, but its script was not saved: ${error.message}`,
      { ...error.details, ...overrides },
      error.cause,
    );
  }
  const detail = normalizeError(error).message;
  return new AppError(
    'COMMAND_FAILED',
    `The session was closed, but its script was not saved: ${detail}`,
    overrides,
  );
}

type CleanupRunner = (step: string, run: () => Promise<void>) => Promise<void>;

async function stopBestEffortSessionResources(
  session: SessionState,
  sessionStore: SessionStore,
  attemptCleanup: CleanupRunner,
): Promise<void> {
  // Recording overlay finalization needs the Apple runner.
  await attemptCleanup('recording', () => stopSessionRecordingForTeardown(session));
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
  const repairArmed = session.saveScriptBoundary !== undefined;
  const closeReceipt = buildRepairPlatformCloseReceipt(req);
  if (repairArmed && session.repairPlatformCloseReceipt !== closeReceipt) {
    const platformCloseError = await dispatchTargetedPlatformClose({ req, session, logPath });
    if (platformCloseError) {
      return {
        response: buildRepairCloseFailureResponse(
          session,
          toRepairPlatformCloseFailure(platformCloseError),
        ),
      };
    }
    session.repairPlatformCloseReceipt = closeReceipt;
  }
  const repairCommit = commitRepairBeforeClose(sessionStore, session, req);
  if (repairCommit.kind === 'failed') {
    return { response: buildRepairCloseFailureResponse(session, repairCommit.error) };
  }
  session.repairPlatformCloseReceipt = undefined;
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

function assertTerminalRecordingCloseAllowed(req: DaemonRequest, session: SessionState): void {
  if (!req.flags?.saveScript) return;
  if (session.scriptRecordingState !== 'aborted' && session.scriptRecordingState !== 'published') {
    return;
  }
  throw new AppError(
    'INVALID_ARGS',
    `close --save-script cannot ${session.scriptRecordingState === 'published' ? 're-publish' : 'publish'} this terminal recording. Retry with plain close; it will tear down the session without writing.`,
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

/**
 * Everything between a settled repair decision and a success response: the
 * failure-isolated resource teardown, the provider lease release, and — only
 * once both have run — the device-claim clear and session delete. A rejected
 * cleanup step is collected instead of short-circuiting the rest, so every
 * subsequent resource (and the runner stop) is still attempted; the provider
 * lease is released only after that teardown, and a failed release keeps the
 * session retryable (returned as `{kind:'response'}`, mirroring the
 * repair-commit-failure path above it). The platform-close failure is thrown
 * as the primary error with its original code/details/hint intact; the
 * cleanup aggregate has already been emitted as a diagnostic by this point so
 * per-resource failures stay visible; a failed script save (#1391) is thrown
 * last since — unlike the two above it — the session has already ended and
 * the device is already released by the time it surfaces.
 */
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
  // #1391: a failed script save is never a reason to keep the device claimed —
  // only a genuine platform-close failure (the device may still be busy) or a
  // resource-cleanup failure withholds it, exactly as before.
  if (!platformCloseError && !cleanupAggregate) {
    await clearAdvisoryDeviceClaim(session.deviceClaim);
  }
  sessionStore.delete(sessionName);
  if (platformCloseError) throw platformCloseError;
  if (cleanupAggregate) throw cleanupAggregate;
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
