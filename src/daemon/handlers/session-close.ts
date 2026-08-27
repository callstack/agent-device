import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { LeaseLifecycleProvider, TargetShutdownResult } from '@agent-device/contracts/device';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { successText, withSuccessText } from '@agent-device/kernel/success-text';
import { resolveCommandDevice } from './session-device-utils.ts';
import { errorResponse } from './response.ts';
import { expireRefFrame } from '../ref-frame.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import { releaseSessionLease } from '../lease-lifecycle.ts';
import {
  hasRepairPlatformCloseReceipt,
  isRepairArmedSession,
  recordRepairPlatformClose,
} from '../session-replay-transaction.ts';
import { isAuthoringArmedSession } from '../session-script-publication-capability.ts';
import type { SessionCleanupFailure } from '../session-teardown.ts';
import { isWebSession } from '../web-session-names.ts';
import { clearDeviceClaim } from '../device-claims.ts';
import { applicationLifecycleExecutionFromRequest } from '../application-lifecycle-execution.ts';
import { hasRuntimeTransportHints } from './session-runtime.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
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
import { closeCleanupError, runSessionCloseTeardown } from './session-close-lifecycle-teardown.ts';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';

function toRepairPlatformCloseFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new AppError('COMMAND_FAILED', `The platform close failed: ${detail}`, {
    hint: 'The repair transaction was not committed because the platform close failed; fix the underlying issue and retry close --save-script.',
  });
}

function requirePlatformCleanup(
  cleanup: PlatformResourceCleanup | undefined,
): PlatformResourceCleanup {
  if (!cleanup) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Platform resource cleanup was not supplied by root runtime composition',
    );
  }
  return cleanup;
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
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
}): Promise<RepairClosePreparation> {
  const { req, session, logPath, sessionStore, lifecycle } = params;
  const repairArmed = isRepairArmedSession(session);
  const closeReceipt = buildRepairPlatformCloseReceipt(req);
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
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
}): Promise<unknown> {
  const { req, session, logPath, lifecycle } = params;
  if (!shouldDispatchPlatformClose(req, session)) return undefined;
  try {
    await lifecycle.operations.closeApplication({
      positionals: req.positionals ?? [],
      outPath: req.flags?.out,
      appBundleId: session.appBundleId,
      surface: session.surface ?? 'app',
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

export async function handleCloseCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  platformResourceCleanup?: PlatformResourceCleanup;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, leaseRegistry, leaseLifecycleProvider } = params;
  const session = sessionStore.get(sessionName);
  if (!session) {
    return await closeWithoutSession({
      req,
      logPath,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
  }
  assertTerminalRecordingCloseAllowed(req, session);
  if (req.internal?.closeAppOnly === true && !req.positionals?.[0]) {
    return errorResponse('INVALID_ARGS', 'App-only close requires an app target');
  }
  const platformResourceCleanup = requirePlatformCleanup(params.platformResourceCleanup);
  const admission = await admitCloseRuntime({
    device: session.device,
    clearRuntimeHints:
      req.internal?.closeAppOnly !== true &&
      Boolean(session.appBundleId) &&
      hasRuntimeTransportHints(sessionStore.getRuntimeHints(sessionName)),
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (admission.type === 'response') return admission.response;
  // Teardown can restore durable IME state, terminate an app, or shut down a target. All are
  // mutating leaves, so invalidate the frame before the first teardown phase, not after dispatch.
  expireRefFrame(session);
  if (req.internal?.closeAppOnly === true) {
    return await closeAppWithoutEndingSession({
      req,
      session,
      logPath,
      lifecycle: admission.runtime,
    });
  }
  const repair = await prepareRepairClose({
    req,
    session,
    logPath,
    sessionStore,
    lifecycle: admission.runtime,
  });
  if ('response' in repair) return repair.response;
  const closed = await runCloseTeardownAndRelease({
    req,
    session,
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider,
    lifecycle: admission.runtime,
    clearRuntimeHints: admission.clearRuntimeHints,
    repairArmed: repair.repairArmed,
    platformResourceCleanup,
  });
  if (closed.kind === 'response') return closed.response;
  return buildCloseSuccessResponse({
    session,
    repair,
    requestedSaveScript: Boolean(req.flags?.saveScript),
    shutdownResult: closed.shutdownResult,
    providerData: closed.providerData,
  });
}

type SessionCloseFinalization =
  | { kind: 'response'; response: DaemonResponse }
  | {
      kind: 'closed';
      providerData?: Record<string, unknown>;
      shutdownResult?: TargetShutdownResult;
    };

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
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
  clearRuntimeHints?: RuntimeHintClearOperation;
  repairArmed: boolean;
  platformResourceCleanup: PlatformResourceCleanup;
}): Promise<SessionCloseFinalization> {
  const {
    req,
    session,
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider,
    lifecycle,
    clearRuntimeHints,
  } = params;
  const cleanupFailures: SessionCleanupFailure[] = [];
  const { platformCloseError, saveScriptError, shutdownResult } = await runSessionCloseTeardown({
    req,
    session,
    sessionName,
    logPath,
    sessionStore,
    lifecycle,
    clearRuntimeHints,
    cleanupFailures,
    repairArmed: params.repairArmed,
    dispatchTargetedPlatformClose,
    finalizeOrdinaryCloseScript,
    platformResourceCleanup: params.platformResourceCleanup,
  });
  const leaseRelease = await releaseProviderLeaseForClose({
    session,
    leaseRegistry,
    leaseLifecycleProvider,
  });
  if (leaseRelease.response) return { kind: 'response', response: leaseRelease.response };
  const cleanupAggregate = closeCleanupError(sessionName, cleanupFailures);
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
  return { kind: 'closed', providerData: leaseRelease.providerData, shutdownResult };
}

function buildCloseSuccessResponse(params: {
  session: SessionState;
  repair: Extract<RepairClosePreparation, { repairArmed: boolean }>;
  requestedSaveScript: boolean;
  shutdownResult: TargetShutdownResult | undefined;
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
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
}): Promise<DaemonResponse> {
  const { req, session, logPath, lifecycle } = params;
  const app = req.positionals?.[0];
  if (!app) {
    return errorResponse('INVALID_ARGS', 'App-only close requires an app target');
  }
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

function shouldDispatchPlatformClose(req: DaemonRequest, session: SessionState): boolean {
  return hasCloseTarget(req) || isWebSession(session);
}

function hasCloseTarget(req: DaemonRequest): boolean {
  return (req.positionals?.length ?? 0) > 0;
}

async function closeWithoutSession(params: {
  req: DaemonRequest;
  logPath: string;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req, logPath, inspectFacts, bindDevice } = params;
  if (!req.positionals || req.positionals.length === 0) {
    return errorResponse('SESSION_NOT_FOUND', 'No active session');
  }
  const device = await resolveCommandDevice({
    session: undefined,
    flags: req.flags,
    ensureReady: false,
  });
  const admission = await admitCloseRuntime({
    device,
    clearRuntimeHints: false,
    inspectFacts,
    bindDevice,
  });
  if (admission.type === 'response') return admission.response;
  await admission.runtime.operations.closeApplication({
    positionals: req.positionals,
    outPath: req.flags?.out,
    surface: 'app',
    ensureReady: true,
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
