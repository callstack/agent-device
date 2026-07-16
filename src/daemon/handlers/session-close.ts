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

/**
 * ADR 0012 decision 6 (BLOCKER 2, new): normalizes a repair-armed session's
 * FAILED platform close into a distinct, surfaceable AppError, mirroring
 * `toRepairCommitFailure` in `session-script-writer.ts`. An AppError from the
 * platform close (e.g. a device-unavailable failure) already carries its own
 * code/details/hint and passes through unchanged; anything else is wrapped
 * with a clear message so the agent can tell this apart from a write failure.
 */
function toRepairPlatformCloseFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new AppError('COMMAND_FAILED', `The platform close failed: ${detail}`, {
    hint: 'The repair transaction was not committed because the platform close failed; fix the underlying issue and retry close --save-script.',
  });
}

// Runs the failure-isolated resource teardown and the targeted platform close
// (#1225). Returns the preserved platform-close error (if any); best-effort
// cleanup failures are pushed into `cleanupFailures`. Never throws for a cleanup
// step so the caller can make an explicit decision about lease/session commit.
async function runSessionCloseTeardown(params: {
  req: DaemonRequest;
  session: SessionState;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  cleanupFailures: SessionCleanupFailure[];
  repairArmed: boolean;
  // ADR 0012 decision 6 (BLOCKER 2): a repair-armed session already dispatched
  // (and confirmed the success of) its platform close BEFORE this teardown —
  // see `handleCloseCommand`. Dispatching it again here would be redundant at
  // best and a double-close at worst, so it is skipped for that case only.
  skipPlatformClose: boolean;
}): Promise<unknown> {
  const { req, session, sessionName, logPath, sessionStore, cleanupFailures, repairArmed } = params;
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
  const platformCloseError = params.skipPlatformClose
    ? undefined
    : await dispatchTargetedPlatformClose({ req, session, logPath });
  await stopOrRetainAppleRunnerAfterClose(req, session, attemptCleanup);
  await clearSessionRuntimeHints(session, sessionStore, sessionName);
  // ADR 0012 decision 6 (BLOCKER 2): a repair-armed session already recorded its
  // finalize `close` and committed (or aborted) its healed `.ad` BEFORE this
  // teardown (commit-state machine — the single commit path), and only AFTER
  // its platform close (dispatched above `handleCloseCommand`) was confirmed to
  // succeed. Only an ordinary (non-repair) session records `close` + writes its
  // session log here, and — per #1225 — a failed platform close is not recorded
  // as `Closed`.
  if (!repairArmed) {
    if (!platformCloseError) {
      recordSessionAction(sessionStore, session, req, 'close', {
        session: session.name,
        ...successText(`Closed: ${session.name}`),
      });
    }
    if (req.flags?.saveScript) {
      session.recordSession = true;
    }
    sessionStore.writeSessionLog(session, { force: resolveEffectiveSaveScriptForce(req, session) });
  }
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

/**
 * ADR 0012 decision 6 (BLOCKER 3, third follow-up): identifies WHICH close
 * request's platform close succeeded — not merely THAT one did. Only the
 * request's TARGET (`positionals`) can change what `dispatchTargetedPlatformClose`
 * actually does: `shouldDispatchPlatformClose` decides purely from
 * `hasCloseTarget(req)` (plus the `web` special case, constant for a given
 * session), and the dispatch itself is `dispatchCommand(device, 'close',
 * req.positionals, ...)`. `close`'s only other flags (`shutdown`, `saveScript`
 * — see `closeCliSchema`) feed the post-teardown shutdown and the commit path
 * respectively, never this call, so they carry no identity here. Binding the
 * marker to this identity means an untargeted close's "succeeded" (a no-op,
 * since `shouldDispatchPlatformClose` was false) can never be misread as "the
 * platform close for THIS target already ran" by a later retry that adds or
 * changes the target — that retry's identity differs, so it re-dispatches.
 */
function repairPlatformCloseIdentity(req: DaemonRequest): string {
  return JSON.stringify(req.positionals ?? []);
}

type RepairClosePreparation =
  | { repairArmed: boolean; healedScriptPath?: string }
  | { response: DaemonResponse };

async function prepareRepairClose(params: {
  req: DaemonRequest;
  session: SessionState;
  logPath: string;
  sessionStore: SessionStore;
}): Promise<RepairClosePreparation> {
  const { req, session, logPath, sessionStore } = params;
  const repairArmed = session.saveScriptBoundary !== undefined;
  const closeIdentity = repairPlatformCloseIdentity(req);
  if (
    repairArmed &&
    !(session.repairPlatformCloseSucceeded && session.repairPlatformCloseIdentity === closeIdentity)
  ) {
    const platformCloseError = await dispatchTargetedPlatformClose({ req, session, logPath });
    if (platformCloseError) {
      return {
        response: buildRepairCloseFailureResponse(
          session,
          toRepairPlatformCloseFailure(platformCloseError),
        ),
      };
    }
    session.repairPlatformCloseSucceeded = true;
    session.repairPlatformCloseIdentity = closeIdentity;
  }
  const repairCommit = commitRepairBeforeClose(sessionStore, session, req);
  if (repairCommit.kind === 'failed') {
    return { response: buildRepairCloseFailureResponse(session, repairCommit.error) };
  }
  session.repairPlatformCloseSucceeded = false;
  session.repairPlatformCloseIdentity = undefined;
  return {
    repairArmed,
    ...(repairCommit.kind === 'committed' ? { healedScriptPath: repairCommit.path } : {}),
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
  if (req.internal?.closeAppOnly === true) {
    return await closeAppWithoutEndingSession({ req, session, logPath });
  }
  // ADR 0012 decision 6 (BLOCKER 2): for a repair-armed session, the platform
  // close must run and SUCCEED before anything is committed or torn down —
  // otherwise a committed healed `.ad` could claim a successful `close` that
  // never actually happened on the device. On failure, return without
  // touching the session at all (mirrors the commit-failure path below): it
  // stays addressable so the agent can fix the cause and retry.
  //
  // BLOCKER 3: a PRIOR close attempt on this same session may already have
  // dispatched the platform close and confirmed its success, then failed to
  // commit (the session is retained for exactly that retry — see below). A
  // retry must never re-dispatch a (possibly non-idempotent) platform close
  // against an already-closed target; `repairPlatformCloseSucceeded` +
  // `repairPlatformCloseIdentity` together record that the platform-level
  // close already happened FOR THIS EXACT request identity, so a same-identity
  // retry consumes it and goes straight to the commit instead. A retry whose
  // identity DIFFERS (third follow-up: e.g. untargeted -> targeted, or a
  // changed target) never matches — the marker only ever attests to the
  // identity it was recorded under, so the platform close runs (again).
  const repair = await prepareRepairClose({ req, session, logPath, sessionStore });
  if ('response' in repair) return repair.response;
  // Resource teardown is failure-isolated: a rejected step is collected instead of
  // short-circuiting the rest, so every subsequent resource (and the runner stop)
  // is still attempted. The provider lease is committed only after that teardown,
  // and a failed provider release keeps the session retryable.
  const cleanupFailures: SessionCleanupFailure[] = [];
  const platformCloseError = await runSessionCloseTeardown({
    req,
    session,
    sessionName,
    logPath,
    sessionStore,
    cleanupFailures,
    repairArmed: repair.repairArmed,
    // The platform close for a repair-armed session already ran (and was
    // confirmed to succeed) above, before the commit — never dispatch it twice.
    skipPlatformClose: repair.repairArmed,
  });
  const leaseRelease = await releaseProviderLeaseForClose({
    session,
    leaseRegistry,
    leaseLifecycleProvider,
  });
  if (leaseRelease.response) return leaseRelease.response;
  sessionStore.delete(sessionName);
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
  // ADR 0012 decision 6 (BLOCKER 2a): positively report the committed healed
  // artifact path so the agent learns the repair published (and where) without
  // an extra round-trip.
  const savedScript = repair.healedScriptPath ? { savedScript: repair.healedScriptPath } : {};
  if (shutdownResult) {
    return {
      ok: true,
      data: withSuccessText(
        {
          session: session.name,
          shutdown: shutdownResult,
          ...savedScript,
          ...(leaseRelease.providerData ? { provider: leaseRelease.providerData } : {}),
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
      ...savedScript,
      ...(leaseRelease.providerData ? { provider: leaseRelease.providerData } : {}),
    },
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
