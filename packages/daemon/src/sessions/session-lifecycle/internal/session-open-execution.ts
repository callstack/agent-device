import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  resolveSessionRequestLogPath,
  resolveSessionRunnerLogPath,
} from '@agent-device/daemon-contracts/session-artifact-paths';
import {
  openApplicationRuntimeUse,
  openApplicationWithRuntimeHintApplyUse,
  openApplicationWithRuntimeHintClearUse,
} from '@agent-device/contracts/application-lifecycle-runtime-plan';
import {
  markSelectionBootOccurred,
  type DeviceSelectionResult,
} from '@agent-device/device-selection/device-selection-resolver';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { OpenApplicationTiming } from '@agent-device/contracts/application-lifecycle-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonPlatformServices } from '../../../core/platform-services.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import { requestCwd } from '../../../core/context.ts';
import type { SessionRef, SessionRuntimeHints, SessionState } from '../../../core/session-state.ts';
import {
  abortAuthoringOnSecondOpen,
  armAuthoringOnOpen,
  isAuthoringArmedSession,
  remoteScriptOpen,
} from '../../../core/session-script-publication-capability.ts';
import { isRequestCanceled } from '@agent-device/host-kit/request';
import {
  AppError,
  asAppError,
  createRequestCanceledError,
  readDispatchDisclosure,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import { SessionStore } from '../../../core/session-store.ts';
import {
  bindStoredRuntimeHintsToApp,
  countConfiguredRuntimeHints,
  openApplicationRuntimeHints,
  runtimeHintsClearInput,
  setSessionRuntimeHintsForOpen,
} from '../../session-runtime.ts';
import { STARTUP_SAMPLE_METHOD, type StartupPerfSample } from './session-startup-metrics.ts';
import { buildOpenResult } from './session-open-surface.ts';
import { publishOpenSession, requireOpenSessionAdmission } from './session-open-state.ts';
import {
  markDeferredInteractionOutcome,
  markPostOpenStabilization,
} from '../../../core/deferred-interaction-outcome.ts';
import { emitDiagnostic, getDiagnosticsMeta } from '@agent-device/host-kit/diagnostics';
import {
  prepareOpenCommandDetails,
  type ReplacedRuntimeHints,
  type ResolvedOpenRuntimeHintPlan,
} from './session-open-prepare.ts';
import { findSessionDeviceConflict } from '../../open-device-contention-wait.ts';
import { resolvePublicSessionName } from '../../session-routing.ts';
import { applicationLifecycleExecutionFromRequest } from '../../application-lifecycle-execution.ts';
import {
  abandonDeviceClaim,
  acquireDeviceClaim,
  clearDeviceClaim,
  renewDeviceClaim,
  type DeviceClaimAcquireResult,
  type DeviceClaimSessionOwnership,
  type DeviceClaimReconciler,
  type TakenOverDeviceClaim,
} from '@agent-device/daemon-contracts/device-claims';
import { appendResponseWarning } from './session-open-warnings.ts';
import { buildDeviceClaimConflictError } from '../../../resources/device/device-claim-conflict.ts';
import { deviceClaimRuleForOwner } from '../../../resources/device/device-claim-rule.ts';
import { errorResponse, type DaemonResponse } from '@agent-device/kernel/contracts';

const OPEN_CLAIM_REASONS = {
  // The device lost the claim this open was made with; close the session and open the device again.
  claimLost: { reason: 'claim-lost-during-open' },
} as const satisfies ReasonTable<'open'>;

export type SessionOpenResult =
  | Readonly<{ type: 'opened'; response: DaemonResponse; ref: SessionRef }>
  | Readonly<{ type: 'response'; response: DaemonResponse }>;

type OpenTiming = OpenApplicationTiming & { totalDurationMs?: number };

type NewSessionOpenEffects = { mayHaveStarted: boolean };

export type OpenApplicationRuntime = BoundDeviceRuntime<typeof openApplicationRuntimeUse>;
export type RuntimeHintApplyOperation = BoundDeviceRuntime<
  typeof openApplicationWithRuntimeHintApplyUse
>['operations']['applyRuntimeHints'];
export type OpenRuntimeHintClearOperation = BoundDeviceRuntime<
  typeof openApplicationWithRuntimeHintClearUse
>['operations']['clearRuntimeHints'];

function applyOrdinaryScriptRecordingOpenOutcome(params: {
  session: SessionState;
  existingSession: SessionState | undefined;
  saveScriptRequested: boolean;
  remoteDelivery: Parameters<typeof armAuthoringOnOpen>[3];
  responseData: Record<string, unknown>;
  hostCwd: string;
}): void {
  const { session, existingSession, saveScriptRequested, responseData, hostCwd } = params;
  if (!existingSession && saveScriptRequested) {
    // The recorded `open` action's flag ingress applies the explicit path/force right after
    // this arm (`applyRecordedSaveScriptFlags`), exactly as the field writers used to split it.
    armAuthoringOnOpen(session, {}, hostCwd, params.remoteDelivery);
    const publicationId = params.remoteDelivery?.publicationId;
    if (publicationId) responseData.scriptPublicationId = publicationId;
    return;
  }
  if (!isAuthoringArmedSession(existingSession)) return;
  abortAuthoringOnSecondOpen(session);
  appendResponseWarning(
    responseData,
    'Script publication was aborted because this session completed a second open. Start a fresh session with open --save-script to author another script.',
  );
}

/**
 * After the launch, the app the new hints bind to is the only one that keeps native hints. The
 * open already succeeded, so a failed removal from the replaced app becomes a warning, as close
 * treats its own clear as cleanup.
 */
async function clearReplacedRuntimeHints(
  replaced: ReplacedRuntimeHints | undefined,
  openedAppId: string | undefined,
): Promise<string | undefined> {
  if (!replaced || replaced.applied.appId === openedAppId) return undefined;
  try {
    await replaced.clear(runtimeHintsClearInput(replaced.applied, undefined));
    return undefined;
  } catch (error) {
    const message = asAppError(error).message;
    emitDiagnostic({
      level: 'warn',
      phase: 'open_replaced_runtime_hints_clear_failed',
      data: { appId: replaced.applied.appId, error: message },
    });
    return `The earlier runtime hints could not be removed from ${replaced.applied.appId}: ${message}`;
  }
}

// Default-on for emulators, opt-in via --test-ime on real devices; --no-test-ime forces off.
function shouldActivateAndroidTestIme(device: DeviceInfo, req: DaemonRequest): boolean {
  if (device.platform !== 'android') return false;
  const flag = req.flags?.testIme;
  if (flag !== undefined) return flag;
  return device.kind === 'emulator';
}

function buildStartupPerfSample(
  startedAtMs: number,
  appTarget: string | undefined,
  appBundleId: string | undefined,
): StartupPerfSample {
  return {
    durationMs: Math.max(0, Date.now() - startedAtMs),
    measuredAt: new Date().toISOString(),
    method: STARTUP_SAMPLE_METHOD,
    appTarget,
    appBundleId,
  };
}

/**
 * Stamps the moment an open established its device, which is the instant a later device boot has to
 * postdate before it can release the claim. A claim this open took, or one its session already held,
 * counts; a session that runs without a claim has nothing to stamp. Losing the claim mid-open ends
 * the open with the refusal every other surface reports, rather than a launch on a device this
 * session no longer owns.
 */
export async function renewOpenSessionClaim(
  device: DeviceInfo,
  ownership: DeviceClaimSessionOwnership | undefined,
  env: HostEnvironment['env'],
): Promise<DaemonResponse | undefined> {
  if (!ownership) return undefined;
  const renewal = await renewDeviceClaim(ownership, env);
  if (renewal.status === 'renewed') return undefined;
  if (renewal.conflict) return buildDeviceClaimConflictError(device, renewal.conflict);
  return errorResponse(
    'DEVICE_IN_USE',
    `${device.name} no longer holds the claim this open was made with.`,
    {
      reason: OPEN_CLAIM_REASONS.claimLost.reason,
      deviceKey: ownership.deviceKey,
      hint: 'Close this session and open the device again to claim it.',
    },
  );
}

export async function completeOpenCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  device: DeviceInfo;
  openTarget?: string;
  openPositionals: string[];
  appName?: string;
  surface: SessionSurface;
  appBundleId?: string;
  runtimeHints: SessionRuntimeHints | undefined;
  replacedRuntimeHints?: ReplacedRuntimeHints;
  lifecycle: OpenApplicationRuntime;
  applyRuntimeHints?: RuntimeHintApplyOperation;
  existingRef?: SessionRef;
  deviceClaim?: DeviceClaimSessionOwnership;
  /** The stale claim this open released before taking the device, when there was one. */
  tookOverDeviceClaim?: TakenOverDeviceClaim;
  selection?: DeviceSelectionResult;
}): Promise<SessionOpenResult> {
  const {
    req,
    sessionName,
    sessionStore,
    logPath,
    device,
    openTarget,
    openPositionals,
    appName,
    surface,
    appBundleId,
    runtimeHints,
    replacedRuntimeHints,
    lifecycle,
    applyRuntimeHints,
    existingRef,
    deviceClaim,
    tookOverDeviceClaim,
    selection,
  } = params;
  requireOpenSessionAdmission(sessionStore, sessionName, existingRef);
  const existingSession = existingRef ? sessionStore.requireCurrent(existingRef) : undefined;
  const freshnessBaseline = existingSession?.snapshot;
  const shouldRelaunch = req.flags?.relaunch === true;
  let sessionAppBundleId = appBundleId;
  const openCommandStartedAtMs = Date.now();

  const provisionalSession = await prepareOpenDispatchSession({
    req,
    sessionName,
    sessionStore,
    device,
    surface,
    sessionAppBundleId,
    appName,
    existingRef,
  });
  if (provisionalSession.type === 'response') return provisionalSession;
  const openDispatchRef = provisionalSession.ref;
  requireOpenSessionAdmission(sessionStore, sessionName, openDispatchRef);
  const openDispatchSession = openDispatchRef
    ? sessionStore.requireCurrent(openDispatchRef)
    : undefined;
  const openStartedAtMs = Date.now();
  const markUnconfirmedRelaunch = () => {
    if (existingRef && shouldRelaunch && sessionStore.resolveCurrent(existingRef)) {
      sessionStore.markCloseEffectsUnconfirmed(existingRef);
    }
  };
  const outcome = await lifecycle.operations
    .openApplication({
      target: openTarget,
      positionals: openPositionals,
      outPath: req.flags?.out,
      runtimeLaunchUrl: runtimeHints?.launchUrl,
      appBundleId: sessionAppBundleId,
      surface,
      hasExistingSession: existingSession !== undefined,
      relaunch: shouldRelaunch,
      prewarmRunnerBeforeOpen: req.flags?.maestro?.prewarmRunnerBeforeOpen === true,
      enableTestIme: shouldActivateAndroidTestIme(device, req),
      stateDir: sessionStore.resolveDaemonStateDir(),
      runtimeHints: openApplicationRuntimeHints(runtimeHints, applyRuntimeHints),
      execution: applicationLifecycleExecutionFromRequest(
        req,
        logPath,
        openDispatchSession?.trace?.outPath,
      ),
    })
    .catch((error: unknown) => {
      const effectsConfirmedOrUndispatched =
        error instanceof AppError && readDispatchDisclosure(error.details) === 'no';
      if (!effectsConfirmedOrUndispatched) markUnconfirmedRelaunch();
      throw error;
    });
  // One id feeds the session and the hint binding, so a later open compares one resolution. Each
  // platform reports the prepared id back when there is one; Android reports the app it saw for a
  // target without one, such as a deep link with no current app.
  sessionAppBundleId ??= outcome.appBundleId;
  const timing: OpenTiming = { ...outcome.timing };
  const preparedSelection = markSelectionBootOccurred(selection);
  const startupSample = openTarget
    ? buildStartupPerfSample(openStartedAtMs, openTarget, sessionAppBundleId)
    : undefined;
  if (isRequestCanceled(req.meta?.requestId)) {
    markUnconfirmedRelaunch();
    const canceled = createRequestCanceledError();
    return {
      type: 'response',
      response: errorResponse(canceled.code, canceled.message, canceled.details),
    };
  }

  requireOpenSessionAdmission(sessionStore, sessionName, openDispatchRef);
  const replacedRuntimeHintsWarning = await clearReplacedRuntimeHints(
    replacedRuntimeHints,
    sessionAppBundleId,
  );
  if (existingRef) {
    markDeferredInteractionOutcome({
      session: sessionStore.requireCurrent(existingRef),
      command: 'open',
      positionals: [],
      flags: undefined,
      androidFreshnessBaseline: freshnessBaseline,
    });
  }
  const sessionStateDir = sessionStore.ensureSessionDir(sessionName);
  const requestLogPath = resolveSessionRequestLogPath(
    sessionStateDir,
    req.meta?.requestId ?? getDiagnosticsMeta().requestId,
  );
  timing.totalDurationMs = Math.max(0, Date.now() - openCommandStartedAtMs);
  emitDiagnostic({
    level: 'info',
    phase: 'open_timing',
    durationMs: timing.totalDurationMs,
    data: timing,
  });
  const openResult = buildOpenResult({
    sessionName: openDispatchSession?.name ?? resolvePublicSessionName(req),
    sessionStateDir,
    runnerLogPath: resolveSessionRunnerLogPath(sessionStateDir),
    requestLogPath,
    eventLogPath: sessionStore.resolveEventLogPath(sessionName),
    appName,
    appBundleId: sessionAppBundleId,
    surface,
    startup: startupSample,
    timing,
    device,
    runtime: runtimeHints,
    runtimeHintCount: countConfiguredRuntimeHints,
    sessionReused: existingSession !== undefined,
    selection: preparedSelection,
    outcome,
    tookOverDeviceClaim,
    hidePreviousClaimOwner: req.internal?.admittedLease?.backend === 'macos-app',
    replacedRuntimeHintsWarning,
  });
  const nextRef = publishOpenSession({
    req,
    sessionStore,
    sessionName,
    existingRef: openDispatchRef,
    device,
    surface,
    appBundleId: sessionAppBundleId,
    appName,
    deviceClaim,
  });
  recordPublishedOpen({
    req,
    sessionStore,
    sessionName,
    ref: nextRef,
    appBundleId: sessionAppBundleId,
    runtimeHints,
    sessionReused: existingRef !== undefined,
    positionals: openPositionals,
    postOpenObservation: timing.postOpenObservation,
    result: openResult,
  });
  return { type: 'opened', ref: nextRef, response: { ok: true, data: openResult } };
}

function recordPublishedOpen(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  sessionName: string;
  ref: SessionRef;
  appBundleId: string | undefined;
  runtimeHints: SessionRuntimeHints | undefined;
  sessionReused: boolean;
  positionals: string[];
  postOpenObservation: OpenTiming['postOpenObservation'];
  result: Record<string, unknown>;
}): void {
  const { req, sessionStore, sessionName, ref, appBundleId, runtimeHints, result } = params;
  sessionStore.clearCloseEffectsUnconfirmed(ref);
  const session = sessionStore.requireCurrent(ref);
  markPostOpenStabilization(session, params.postOpenObservation, req.flags);
  if (req.runtime !== undefined) {
    setSessionRuntimeHintsForOpen(sessionStore, sessionName, runtimeHints, appBundleId);
  } else if (runtimeHints) {
    bindStoredRuntimeHintsToApp(sessionStore, sessionName, appBundleId);
  }
  applyOrdinaryScriptRecordingOpenOutcome({
    session,
    existingSession: params.sessionReused ? session : undefined,
    saveScriptRequested: Boolean(req.flags?.saveScript),
    remoteDelivery: remoteScriptOpen(req.meta),
    responseData: result,
    hostCwd: sessionStore.host.cwd,
  });
  sessionStore.recordAction(ref, {
    command: 'open',
    positionals: params.positionals,
    flags: req.flags ?? {},
    runtime: req.runtime !== undefined ? runtimeHints : undefined,
    result,
  });
}

async function prepareOpenDispatchSession(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  device: DeviceInfo;
  surface: SessionSurface;
  sessionAppBundleId: string | undefined;
  appName: string | undefined;
  existingRef: SessionRef | undefined;
}): Promise<
  { type: 'session'; ref?: SessionRef } | { type: 'response'; response: DaemonResponse }
> {
  const { req, sessionName, sessionStore, existingRef } = params;
  const beforeDispatch = req.internal?.openLifecycle?.beforeDispatch;
  if (!beforeDispatch) return { type: 'session', ref: existingRef };
  const ref = publishOpenSession({
    req,
    sessionName,
    sessionStore,
    existingRef,
    device: params.device,
    surface: params.surface,
    appBundleId: params.sessionAppBundleId,
    appName: params.appName,
  });
  const lifecycleResponse = await beforeDispatch();
  if (lifecycleResponse && !lifecycleResponse.ok)
    return { type: 'response', response: lifecycleResponse };
  requireOpenSessionAdmission(sessionStore, sessionName, ref);
  return { type: 'session', ref: sessionStore.refresh(ref) };
}

async function acquireDeviceClaimForOwner(params: {
  host: HostEnvironment;
  req: DaemonRequest;
  device: DeviceInfo;
  owner: OpenApplicationRuntime['owner'];
  sessionName: string;
  sessionStore: SessionStore;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
  platformServices: DaemonPlatformServices;
}): Promise<DeviceClaimAcquireResult | { status: 'not-required' }> {
  const {
    req,
    device,
    owner,
    sessionName,
    sessionStore,
    reconcileOrphanedDeviceClaim,
    platformServices,
  } = params;
  switch (deviceClaimRuleForOwner(owner)) {
    case 'none':
      return { status: 'not-required' };
    case 'ordinary':
      return await acquireDeviceClaim({
        device,
        session: sessionName,
        workspace: requestCwd(req, params.host),
        stateDir: sessionStore.resolveDaemonStateDir(),
        env: params.host.env,
        reconcileOrphanedDeviceClaim,
        observeDeviceBoot: platformServices.deviceBootObservation,
      });
  }
}

export async function openNewSessionWithDeviceClaim(params: {
  host: HostEnvironment;
  req: DaemonRequest;
  startupDeadlineAtMs: number | undefined;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  device: DeviceInfo;
  surface: SessionSurface;
  openTarget: string | undefined;
  lifecycle: OpenApplicationRuntime;
  runtimeHintPlan: ResolvedOpenRuntimeHintPlan;
  applyRuntimeHints?: RuntimeHintApplyOperation;
  clearRuntimeHints?: OpenRuntimeHintClearOperation;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
  selection?: DeviceSelectionResult;
  platformServices: DaemonPlatformServices;
}): Promise<SessionOpenResult> {
  const {
    req,
    sessionName,
    logPath,
    sessionStore,
    device,
    surface,
    openTarget,
    lifecycle,
    runtimeHintPlan,
    applyRuntimeHints,
    clearRuntimeHints,
    reconcileOrphanedDeviceClaim,
    selection,
    platformServices,
  } = params;
  requireOpenSessionAdmission(sessionStore, sessionName, undefined);
  const conflict = findSessionDeviceConflict({ req, device, sessionStore });
  if (conflict) return { type: 'response', response: conflict };

  const ownerClaim = await acquireDeviceClaimForOwner({
    host: params.host,
    req,
    device,
    owner: lifecycle.owner,
    sessionName,
    sessionStore,
    reconcileOrphanedDeviceClaim,
    platformServices,
  });
  if (ownerClaim.status === 'conflict')
    return {
      type: 'response',
      response: buildDeviceClaimConflictError(device, ownerClaim.conflict),
    };
  const deviceClaim = ownerClaim.status === 'acquired' ? ownerClaim.ownership : undefined;
  const tookOverDeviceClaim = ownerClaim.status === 'acquired' ? ownerClaim.tookOver : undefined;
  const effects: NewSessionOpenEffects = { mayHaveStarted: false };
  const rollbackClaim = async () =>
    await rollbackNewSessionClaim({
      ownership: deviceClaim,
      effects,
      sessionName,
      sessionStore,
      env: params.host.env,
    });
  try {
    requireOpenSessionAdmission(sessionStore, sessionName, undefined);
    const details = await prepareOpenCommandDetails({
      req,
      startupDeadlineAtMs: params.startupDeadlineAtMs,
      logPath,
      surface,
      openTarget,
      runtime: lifecycle,
      runtimeHintPlan,
      clearRuntimeHints,
      foreground: req.flags?.foreground === true && openTarget === undefined,
    });
    if (details.type === 'response') {
      await rollbackClaim();
      return { type: 'response', response: details.response };
    }
    // Preparation can boot the device or warm caches, but it cannot establish session ownership.
    // Stamping here is what covers a boot preparation caused for this very open; from
    // `completeOpenCommand` on, a relaunch-close or a runtime-hint write may already have touched the
    // app, so a failure from that point cannot prove ownership was never established.
    const reclaimed = await renewOpenSessionClaim(device, deviceClaim, params.host.env);
    if (reclaimed) return { type: 'response', response: reclaimed };
    effects.mayHaveStarted = true;
    const requestedPositionals = req.positionals ?? [];
    // `open <app> <url>` carries both positionals; only `--foreground`, which has none, gets its
    // target synthesized from the app the preparation resolved. Collapsing to the resolved target
    // would drop the URL of every deep-linked first open.
    const resolvedOpenTarget = openTarget ?? details.details.appBundleId;
    const response = await completeOpenCommand({
      req,
      sessionName,
      sessionStore,
      logPath,
      device,
      openTarget: resolvedOpenTarget,
      openPositionals:
        requestedPositionals.length > 0
          ? requestedPositionals
          : resolvedOpenTarget
            ? [resolvedOpenTarget]
            : [],
      appBundleId: details.details.appBundleId,
      appName: details.details.appName,
      runtimeHints: details.details.runtime,
      replacedRuntimeHints: details.details.replacedRuntimeHints,
      lifecycle,
      applyRuntimeHints,
      surface,
      deviceClaim,
      tookOverDeviceClaim,
      selection,
    });
    if (!response.response.ok) await rollbackClaim();
    return response;
  } catch (error) {
    await rollbackClaim();
    throw error;
  }
}

async function rollbackNewSessionClaim(params: {
  ownership: DeviceClaimSessionOwnership | undefined;
  effects: NewSessionOpenEffects;
  sessionName: string;
  sessionStore: SessionStore;
  env: HostEnvironment['env'];
}): Promise<void> {
  const { ownership, effects, sessionName, sessionStore, env } = params;
  if (!ownership) return;
  if (!effects.mayHaveStarted) {
    await clearDeviceClaim(ownership, env);
    return;
  }
  if (sessionStore.get(sessionName)?.deviceClaim?.ownerToken === ownership.ownerToken) return;
  const outcome = await abandonDeviceClaim(ownership, env);
  emitDiagnostic({
    level: 'warn',
    phase: 'device_claim_open_effects_unconfirmed',
    data: { deviceKey: ownership.deviceKey, outcome },
  });
}
