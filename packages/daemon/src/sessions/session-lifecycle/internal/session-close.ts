import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonPlatformServices } from '../../../core/platform-services.ts';
import type { LaunchedDeviceProcessService } from '@agent-device/contracts/device-boot';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { LeaseLifecycleProvider, TargetShutdownResult } from '@agent-device/contracts/device';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../../../core/session-state.ts';
import { SessionStore } from '../../../core/session-store.ts';
import { successText, withSuccessText } from '@agent-device/kernel/success-text';
import { resolveCommandDevice } from '../../../resources/session-device-resolution.ts';
import { expireRefFrame } from '../../../core/ref-frame.ts';
import type { LeaseRegistry } from '../../../resources/lease-registry.ts';
import { releaseSessionLease } from '../../lease-lifecycle.ts';
import { recordEndedLease } from '../../../core/request-ended-leases.ts';
import { releaseTargetLease } from '../../target-lease-release.ts';
import {
  hasRepairPlatformCloseReceipt,
  isRepairArmedSession,
  recordRepairPlatformClose,
} from '../../../core/session-replay-transaction.ts';
import {
  isAuthoringArmedSession,
  remoteCloseScriptDelivery,
  type RemoteCloseScript,
} from '../../../core/session-script-publication-capability.ts';
import type { SessionCleanupFailure } from '../../session-teardown.ts';
import { isWebSession } from '../../web-session-names.ts';
import { clearDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import { applicationLifecycleExecutionFromRequest } from '../../application-lifecycle-execution.ts';
import { hasRuntimeTransportHints } from '../../session-runtime.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../../core/request-runtime-binding.ts';
import {
  buildRetriableRepairCloseFailureResponse,
  commitRepairScriptBeforeClose,
  finalizeOrdinaryCloseScript,
} from './session-close-script.ts';
import {
  admitCloseRuntime,
  type CloseRuntime,
  type CloseRuntimeWithRuntimeHintClear,
  type RuntimeHintClearOperation,
} from './session-close-runtime-admission.ts';
import { appendResponseWarning } from './session-open-warnings.ts';
import { closeCleanupError, runSessionCloseTeardown } from './session-close-lifecycle-teardown.ts';
import type { PlatformResourceCleanup } from '../../../core/platform-resource-cleanup.ts';
import { errorResponse } from '@agent-device/kernel/contracts';
import { resolveCloseTargetRuntimeUse } from '@agent-device/contracts/application-lifecycle-runtime-plan';
import { CLOSE_BOOT_OWNER_UNVERIFIED_REASONS } from '@agent-device/contracts/device-boot';
import { admitRuntimeUse } from '../../../core/runtime-admission.ts';

export type SessionCloseCommandInput = Readonly<{
  host: HostEnvironment;
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  sessionRef?: SessionRef;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
  platformResourceCleanup?: PlatformResourceCleanup;
  deviceShutdownDenied?: boolean;
}>;

function toRepairPlatformCloseFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new AppError('COMMAND_FAILED', `The platform close failed: ${detail}`, {
    hint: 'The repair transaction was not committed because the platform close failed; fix the underlying issue and retry close --save-script.',
  });
}

type RepairClosePreparation =
  | { repairArmed: boolean; healedScriptPath?: string; aborted?: boolean }
  | { response: DaemonResponse };

/**
 * The positionals the platform close receives. A close without an app closes the session app,
 * the way `close <app>` does (#4684). A web session always dispatches, with no app. A native
 * session that never opened an app has nothing to close.
 */
function platformCloseTarget(req: DaemonRequest, session: SessionState): string[] | undefined {
  if (req.positionals && req.positionals.length > 0) return req.positionals;
  if (isWebSession(session)) return [];
  return session.appBundleId ? [session.appBundleId] : undefined;
}

async function prepareRepairClose(params: {
  req: DaemonRequest;
  ref: SessionRef;
  logPath: string;
  sessionStore: SessionStore;
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
}): Promise<RepairClosePreparation> {
  const { req, ref, logPath, sessionStore, lifecycle } = params;
  const session = sessionStore.requireCurrent(ref);
  const repairArmed = isRepairArmedSession(session);
  const closeReceipt = JSON.stringify(platformCloseTarget(req, session) ?? []);
  if (repairArmed && !hasRepairPlatformCloseReceipt(session, closeReceipt)) {
    const platformCloseError = await dispatchTargetedPlatformClose({
      req,
      session,
      logPath,
      lifecycle,
    });
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
    recordRepairPlatformClose(sessionStore.requireCurrent(ref), closeReceipt);
  }
  const repairCommit = commitRepairScriptBeforeClose(sessionStore, ref, req);
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
  shutdownPrepared: boolean;
  cleanupFailures: SessionCleanupFailure[];
  sessionName: string;
  req: DaemonRequest;
  session: SessionState;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider: LeaseLifecycleProvider | undefined;
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
}): Promise<{
  providerData?: Record<string, unknown>;
  shutdownResult?: TargetShutdownResult;
  response?: DaemonResponse;
}> {
  try {
    let providerRelease: { providerData?: Record<string, unknown> } | undefined;
    let shutdownResult: TargetShutdownResult | undefined;
    const shutdownTarget = params.lifecycle.operations.shutdownTarget;
    if (
      params.req.flags?.shutdown &&
      shutdownTarget &&
      params.lifecycle.owner.kind === 'provider-runtime'
    ) {
      if (!params.shutdownPrepared) {
        throw (
          closeCleanupError(params.sessionName, params.cleanupFailures, { sessionKept: true }) ??
          new AppError('COMMAND_FAILED', 'Target shutdown preparation failed. Retry close.')
        );
      }
      shutdownResult = await shutdownTarget({
        releaseLease: async (leaseId) => {
          const result = await releaseTargetLease({
            ...params,
            owner: params.lifecycle.owner,
            leaseId,
          });
          providerRelease = { providerData: result.provider };
          return result.shutdown;
        },
      });
    }
    if (providerRelease) return { ...providerRelease, shutdownResult };
    const { endedLeaseId, providerData } = await releaseSessionLease(params);
    if (endedLeaseId) recordEndedLease(params.req, endedLeaseId);
    return { providerData, shutdownResult };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      response: {
        ok: false,
        error: {
          ...normalized,
          hint: 'The target could not be shut down or released. Retry close after resolving the failure.',
          details: { ...normalized.details, session: params.sessionName },
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
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
}): Promise<unknown> {
  const { req, session, logPath, lifecycle } = params;
  const positionals = platformCloseTarget(req, session);
  if (!positionals) return undefined;
  try {
    await lifecycle.operations.closeApplication({
      positionals,
      outPath: req.flags?.out,
      appBundleId: session.appBundleId,
      surface: session.surface ?? 'app',
      ...(req.internal?.killApp === true ? { mode: 'kill' as const } : {}),
      execution: applicationLifecycleExecutionFromRequest(req, logPath, session.trace?.outPath),
    });
    return undefined;
  } catch (error) {
    return error;
  }
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

/**
 * A session on an app device closes only its own app (ADR 0035). The platform resolves the target
 * before any teardown, the way open does, and refuses another app, so the session and its
 * resources stay intact; the platform close refuses it too.
 */
async function refuseCloseOutsideAppDevice(params: {
  session: SessionState;
  app: string | undefined;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  platformServices: DaemonPlatformServices;
}): Promise<DaemonResponse | undefined> {
  const { session, app } = params;
  if (!session.device.hostApp || !app) return undefined;
  const admitted = await admitRuntimeUse({
    command: 'close',
    device: session.device,
    use: resolveCloseTargetRuntimeUse,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
    platformServices: params.platformServices,
  });
  if (admitted.type === 'response') return admitted.response;
  await admitted.runtime.operations.resolveOpenTarget({
    target: app,
    surface: 'app',
    foreground: false,
  });
  return undefined;
}

export async function handleSessionCloseCommands(
  params: SessionCloseCommandInput,
): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, leaseRegistry, leaseLifecycleProvider } = params;
  const ref = params.sessionRef ?? sessionStore.lookup(sessionName);
  if (!ref) {
    return await closeWithoutSession({
      req,
      sessionName,
      logPath,
      env: params.host.env,
      inspectFacts: params.inspectFacts,
      platformServices: params.platformServices,
      bindDevice: params.bindDevice,
    });
  }
  let session = sessionStore.requireCurrent(ref);
  assertTerminalRecordingCloseAllowed(req, session);
  const app = req.positionals?.[0];
  const outsideAppDevice = await refuseCloseOutsideAppDevice({
    session,
    app,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
    platformServices: params.platformServices,
  });
  if (outsideAppDevice) return outsideAppDevice;
  if (req.internal?.closeAppOnly === true && !app) {
    return errorResponse('INVALID_ARGS', 'App-only close requires an app target');
  }
  if (!params.platformResourceCleanup) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Platform resource cleanup was not supplied by root runtime composition',
    );
  }
  const platformResourceCleanup = params.platformResourceCleanup;
  const admission = await admitCloseRuntime({
    device: session.device,
    clearRuntimeHints:
      req.internal?.closeAppOnly !== true &&
      Boolean(session.appBundleId) &&
      hasRuntimeTransportHints(sessionStore.getRuntimeHints(sessionName)),
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (admission.type === 'response') return admission.response;
  session = sessionStore.requireCurrent(ref);
  // Teardown can restore durable IME state, terminate an app, or shut down a target. All are
  // mutating leaves, so invalidate the frame before the first teardown phase, not after dispatch.
  expireRefFrame(session);
  if (req.internal?.closeAppOnly === true && app) {
    return await closeAppWithoutEndingSession({
      req,
      session,
      logPath,
      lifecycle: admission.runtime,
      app,
    });
  }
  const repair = await prepareRepairClose({
    req,
    ref,
    logPath,
    sessionStore,
    lifecycle: admission.runtime,
  });
  if ('response' in repair) return repair.response;
  const closed = await markSessionKeptAfterTeardown(sessionStore, ref, () =>
    runCloseTeardownAndRelease({
      env: params.host.env,
      req,
      ref,
      logPath,
      sessionStore,
      leaseRegistry,
      leaseLifecycleProvider,
      lifecycle: admission.runtime,
      clearRuntimeHints: admission.clearRuntimeHints,
      repairArmed: repair.repairArmed,
      platformResourceCleanup,
      launchedProcess: params.platformServices.launchedDeviceProcess,
      deviceShutdownDenied: params.deviceShutdownDenied,
    }),
  );
  if (closed.kind === 'response') return closed.response;
  const response = buildCloseSuccessResponse({
    session,
    repair,
    requestedSaveScript: Boolean(req.flags?.saveScript),
    shutdownResult: closed.shutdownResult,
    providerData: closed.providerData,
    implicitShutdownDeniedByPolicy: closed.implicitShutdownDeniedByPolicy,
    implicitShutdownClaimLost: closed.implicitShutdownClaimLost,
    implicitShutdownBootOwnerUnverified: closed.implicitShutdownBootOwnerUnverified,
    implicitShutdownLaunchedProcessGone: closed.implicitShutdownLaunchedProcessGone,
    implicitShutdownLaunchedProcessUnverified: closed.implicitShutdownLaunchedProcessUnverified,
    shutdownStopUnconfirmed: closed.shutdownStopUnconfirmed,
  });
  return remoteCloseScriptDelivery(response, closed.remoteScript);
}

/**
 * #4237: the one owner of "a kept session is marked". A close that ran its teardown either retires
 * the session or keeps it for a retried close, whichever step failed (platform close, cleanup, or
 * provider lease release). Every kept session is marked, so daemon idle reap never waits on it.
 */
async function markSessionKeptAfterTeardown<Result>(
  sessionStore: SessionStore,
  ref: SessionRef,
  finalize: () => Promise<Result>,
): Promise<Result> {
  try {
    return await finalize();
  } finally {
    if (sessionStore.resolveCurrent(ref)) sessionStore.markCloseEffectsUnconfirmed(ref);
  }
}

type SessionCloseFinalization =
  | { kind: 'response'; response: DaemonResponse }
  | {
      kind: 'closed';
      providerData?: Record<string, unknown>;
      shutdownResult?: TargetShutdownResult;
      /** What close delivers for a remote recording, taken from the close-time write (ADR 0016). */
      remoteScript?: RemoteCloseScript;
      /** #4162: the policy denied the stop this close owed its own boot, so the device kept running. */
      implicitShutdownDeniedByPolicy: boolean;
      implicitShutdownClaimLost: boolean;
      /** #4791: the platform said its own boot step never booted this device, so close owed it no stop. */
      implicitShutdownBootOwnerUnverified: boolean;
      /** #4585: the device has been rebooted outside this session since its open, so close left it running. */
      implicitShutdownLaunchedProcessGone: boolean;
      implicitShutdownLaunchedProcessUnverified: boolean;
      shutdownStopUnconfirmed: boolean;
    };

// Everything between a settled repair decision and a success response:
// failure-isolated resource teardown, provider lease release, then (only
// once both are known) the device-claim clear and session delete. A failed
// teardown that withholds the device claim keeps the session and its lease
// for a retried close; a failed lease release keeps the session retryable
// too (`{kind:'response'}`).
async function runCloseTeardownAndRelease(params: {
  env: HostEnvironment['env'];
  req: DaemonRequest;
  ref: SessionRef;
  logPath: string;
  sessionStore: SessionStore;
  sessionRef?: SessionRef;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider: LeaseLifecycleProvider | undefined;
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
  clearRuntimeHints?: RuntimeHintClearOperation;
  repairArmed: boolean;
  platformResourceCleanup: PlatformResourceCleanup;
  deviceShutdownDenied?: boolean;
  /** The host process this session's `open` launched, as the root-composed owner answers for it. */
  launchedProcess: LaunchedDeviceProcessService;
}): Promise<SessionCloseFinalization> {
  const {
    req,
    ref,
    logPath,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider,
    lifecycle,
    clearRuntimeHints,
  } = params;
  const { address: sessionName } = ref;
  const cleanupFailures: SessionCleanupFailure[] = [];
  const {
    platformCloseError,
    retainExecutionHost,
    saveScriptOutcome,
    shutdownPrepared,
    shutdownResult,
    implicitShutdownDeniedByPolicy,
    implicitShutdownClaimLost,
    implicitShutdownBootOwnerUnverified,
    implicitShutdownLaunchedProcessGone,
    implicitShutdownLaunchedProcessUnverified,
    shutdownStopUnconfirmed,
  } = await runSessionCloseTeardown({
    env: params.env,
    leaseRegistry,
    req,
    ref,
    logPath,
    sessionStore,
    lifecycle,
    clearRuntimeHints,
    cleanupFailures,
    repairArmed: params.repairArmed,
    dispatchTargetedPlatformClose,
    finalizeOrdinaryCloseScript,
    platformResourceCleanup: params.platformResourceCleanup,
    deviceShutdownDenied: params.deviceShutdownDenied,
    launchedProcess: params.launchedProcess,
  });
  let session = sessionStore.requireCurrent(ref);
  // Each cleanup report is built where the session's fate is decided, so its diagnostic and hint
  // describe what actually happened to the session. It is built even when a platform-close error
  // takes precedence, so that error never hides the cleanup failures.
  if (session.deviceClaim) {
    const cleanupError = closeCleanupError(sessionName, cleanupFailures, { sessionKept: true });
    const claimBlockingError = platformCloseError ?? cleanupError;
    if (claimBlockingError) {
      emitDiagnostic({
        level: 'warn',
        phase: 'device_claim_close_effects_unconfirmed',
        data: {
          deviceKey: session.deviceClaim.deviceKey,
          session: sessionName,
        },
      });
      // The withheld claim names a live owner, so `--stale` cannot reclaim it. Retiring the
      // session would leave nothing able to release it; keeping it, and its lease, lets a retried
      // close rerun the teardown.
      throw claimBlockingError;
    }
  }
  const leaseRelease = await releaseProviderLeaseForClose({
    req,
    session,
    leaseRegistry,
    leaseLifecycleProvider,
    lifecycle,
    shutdownPrepared,
    cleanupFailures,
    sessionName,
  });
  if (leaseRelease.response) return { kind: 'response', response: leaseRelease.response };
  session = sessionStore.resolveCurrent(ref) ?? session;
  const cleanupError = closeCleanupError(sessionName, cleanupFailures, { sessionKept: false });
  const closeError = platformCloseError ?? cleanupError;
  if (!closeError) await clearDeviceClaim(session.deviceClaim, params.env);
  sessionStore.retire(ref, { retainExecutionHost });
  if (closeError) throw closeError;
  if (saveScriptOutcome.error) throw saveScriptOutcome.error;
  return {
    kind: 'closed',
    providerData: leaseRelease.providerData,
    shutdownResult: leaseRelease.shutdownResult ?? shutdownResult,
    remoteScript: saveScriptOutcome.remote,
    implicitShutdownDeniedByPolicy,
    implicitShutdownClaimLost,
    implicitShutdownBootOwnerUnverified,
    implicitShutdownLaunchedProcessGone,
    implicitShutdownLaunchedProcessUnverified,
    shutdownStopUnconfirmed,
  };
}

function buildCloseSuccessResponse(params: {
  session: SessionState;
  repair: Extract<RepairClosePreparation, { repairArmed: boolean }>;
  requestedSaveScript: boolean;
  shutdownResult: TargetShutdownResult | undefined;
  providerData: Record<string, unknown> | undefined;
  implicitShutdownDeniedByPolicy: boolean;
  implicitShutdownClaimLost: boolean;
  implicitShutdownLaunchedProcessGone: boolean;
  implicitShutdownLaunchedProcessUnverified: boolean;
  implicitShutdownBootOwnerUnverified: boolean;
  shutdownStopUnconfirmed: boolean;
}): DaemonResponse {
  const {
    session,
    repair,
    requestedSaveScript,
    shutdownResult,
    providerData,
    implicitShutdownDeniedByPolicy,
    implicitShutdownClaimLost,
    implicitShutdownLaunchedProcessGone,
    implicitShutdownLaunchedProcessUnverified,
    implicitShutdownBootOwnerUnverified,
    shutdownStopUnconfirmed,
  } = params;
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
  const data: Record<string, unknown> = shutdownResult
    ? withSuccessText(
        { session: session.name, shutdown: shutdownResult, ...savedScript, ...provider },
        text,
      )
    : { session: session.name, ...successText(text), ...savedScript, ...provider };
  // #4162: the close owed this device a stop because its own open booted it, but the daemon's
  // policy denies `device-shutdown`. The close still succeeded; say plainly what stayed up.
  if (implicitShutdownDeniedByPolicy) {
    appendResponseWarning(
      data,
      "This session's open booted this device and close would stop it, but this daemon's policy denies device-shutdown. The device is still running.",
    );
  }
  if (implicitShutdownClaimLost) {
    appendResponseWarning(
      data,
      "This session's open booted this device, but close could not verify its device claim and did not request a stop.",
    );
  }
  // #4585: the stop this session owed was owed to the emulator process its own open launched. That
  // process is gone, so whatever answers the serial now is somebody else's device and stopping it
  // would stop a boot this session never caused. Say which device close left running, and why.
  if (implicitShutdownLaunchedProcessGone) {
    appendResponseWarning(
      data,
      "This session's open booted this device, but its emulator process has changed, so close did not request a stop. The device is still running.",
    );
  }
  if (implicitShutdownLaunchedProcessUnverified) {
    appendResponseWarning(
      data,
      session.androidLaunchIdentity
        ? "This session's open booted this device, but close could not verify its emulator process identity, so it did not request a stop and left the device as it found it."
        : "This session's open booted this device, but open recorded no emulator process identity, so close did not request a stop and left the device as it found it.",
    );
  }
  // #4791: the open inferred a boot from a snapshot that said the simulator was stopped, and the
  // platform's own boot step then said it never booted it. Whatever is running is somebody else's
  // boot, so close leaves it running and says which reason it refused the stop for.
  if (implicitShutdownBootOwnerUnverified) {
    appendResponseWarning(
      data,
      `This session's open found this device stopped, but reported ${CLOSE_BOOT_OWNER_UNVERIFIED_REASONS.bootOwnerUnverified}: its own boot step never booted the device, so close did not request a stop. The device is still running.`,
    );
  }
  if (shutdownStopUnconfirmed) {
    appendResponseWarning(
      data,
      'Close asked this device to stop, but could not confirm that its emulator process exited. The device may still be running.',
    );
  }
  return { ok: true, data };
}

async function closeAppWithoutEndingSession(params: {
  req: DaemonRequest;
  session: SessionState;
  logPath: string;
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
  app: string;
}): Promise<DaemonResponse> {
  const { req, session, logPath, lifecycle, app } = params;
  const platformCloseError = await dispatchTargetedPlatformClose({
    req,
    session,
    logPath,
    lifecycle,
  });
  if (platformCloseError) throw platformCloseError;
  return {
    ok: true,
    data: {
      app,
      ...successText(`Closed: ${app}`),
    },
  };
}

async function closeWithoutSession(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  env: EnvMap;
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, env, inspectFacts, bindDevice, platformServices } = params;
  const { requireNamedSessionHoldsDevice } =
    await import('../../../core/explicit-session-resolution.ts');
  requireNamedSessionHoldsDevice({ req, sessionAddress: sessionName, session: undefined });
  if (!req.positionals || req.positionals.length === 0)
    return errorResponse('SESSION_NOT_FOUND', 'No active session');
  const device = await resolveCommandDevice({
    session: undefined,
    req,
    env,
    platformServices,
  });
  const admission = await admitCloseRuntime({
    device,
    clearRuntimeHints: false,
    inspectFacts,
    bindDevice,
    platformServices,
  });
  if (admission.type === 'response') return admission.response;
  await admission.runtime.operations.closeApplication({
    positionals: req.positionals,
    outPath: req.flags?.out,
    surface: 'app',
    ensureReady: true,
    ...(req.internal?.killApp === true ? { mode: 'kill' as const } : {}),
    execution: applicationLifecycleExecutionFromRequest(req, logPath),
  });
  return {
    ok: true,
    data: {
      app: req.positionals[0],
      ...successText(`Closed: ${req.positionals[0]}`),
    },
  };
}
