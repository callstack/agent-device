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
import type {
  LaunchConfirmationAbsent,
  LaunchConfirmationOutcome,
  LaunchConfirmationUnansweredReason,
  OpenApplicationOutcome,
  OpenApplicationTiming,
} from '@agent-device/contracts/application-lifecycle-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonPlatformServices } from '../../../core/platform-services.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../../../core/session-state.ts';
import {
  abortAuthoringOnSecondOpen,
  armAuthoringOnOpen,
  isAuthoringArmedSession,
} from '../../../core/session-script-publication-capability.ts';
import { isRequestCanceled } from '@agent-device/host-kit/request';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { SessionStore } from '../../../core/session-store.ts';
import {
  countConfiguredRuntimeHints,
  runtimeHintValues,
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
  type ResolvedOpenRuntimeHintPlan,
} from './session-open-prepare.ts';
import {
  buildDeviceInUseBySessionError,
  buildForeignWorkspaceSessionConflict,
} from '../../../core/session-recovery-hints.ts';
import { describeOpenWaitForRefusal } from '../../open-device-contention-wait.ts';
import { isImplicitSessionScopeConflict, resolvePublicSessionName } from '../../session-routing.ts';
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
import {
  errorResponse,
  type DaemonFailureResponse,
  type DaemonResponse,
} from '@agent-device/kernel/contracts';

export type SessionOpenResult =
  | Readonly<{ type: 'opened'; response: DaemonResponse; ref: SessionRef }>
  | Readonly<{ type: 'response'; response: DaemonResponse }>;

type OpenTiming = OpenApplicationTiming & { totalDurationMs?: number };

type NewSessionOpenEffects = { mayHaveStarted: boolean };

export type OpenApplicationRuntime = BoundDeviceRuntime<typeof openApplicationRuntimeUse>;
export type RuntimeHintApplyOperation = BoundDeviceRuntime<
  typeof openApplicationWithRuntimeHintApplyUse
>['operations']['applyRuntimeHints'];
export type RuntimeHintClearOperation = BoundDeviceRuntime<
  typeof openApplicationWithRuntimeHintClearUse
>['operations']['clearRuntimeHints'];

function applyOrdinaryScriptRecordingOpenOutcome(params: {
  session: SessionState;
  existingSession: SessionState | undefined;
  saveScriptRequested: boolean;
  responseData: Record<string, unknown>;
  hostCwd: string;
}): void {
  const { session, existingSession, saveScriptRequested, responseData, hostCwd } = params;
  if (!existingSession && saveScriptRequested) {
    // The recorded `open` action's flag ingress applies the explicit path/force right after
    // this arm (`applyRecordedSaveScriptFlags`), exactly as the field writers used to split it.
    armAuthoringOnOpen(session, {}, hostCwd);
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
 * What the caller's `open` output says when a claim was taken over because its device rebooted. A
 * `macos-app` lease tenant is not told whose claim it was: that belongs to the host (ADR 0007).
 */
function deviceClaimTakeoverWarning(tookOver: TakenOverDeviceClaim, req: DaemonRequest): string {
  if (req.internal?.admittedLease?.backend === 'macos-app') {
    return 'Took the device over: it rebooted after its previous claim was taken, so the previous app was already gone.';
  }
  return (
    `Took the device from session "${tookOver.session}" in workspace "${tookOver.workspace}": ` +
    'that device rebooted after its claim was taken, so its app and runner were already gone.'
  );
}

/** What the caller's `open` output says about the launch-confirmation probe on this outcome. */
function launchConfirmationReport(
  outcome: OpenApplicationOutcome,
): LaunchConfirmationOutcome | LaunchConfirmationAbsent {
  switch (outcome.launchConfirmation) {
    case 'accepted':
      return { launchConfirmation: 'accepted' };
    case 'unanswered':
      return {
        launchConfirmation: 'unanswered',
        launchConfirmationReason: outcome.launchConfirmationReason,
      };
    default:
      // Keeps the typed probe-failure step on the response beside its warning, so a machine
      // reader tells "no prompt" from "prompt state unreadable" without parsing prose.
      return outcome.launchConfirmationProbeFailure
        ? { launchConfirmationProbeFailure: outcome.launchConfirmationProbeFailure }
        : {};
  }
}

/** What the caller's `open` output says when a confirmation probe step failed unverified. */
function launchConfirmationProbeFailureWarning(): string {
  return (
    'agent-device could not read whether iOS is asking to confirm the launch URL, so the launch ' +
    'URL may still be held by a prompt. Check with `alert get` before retrying.'
  );
}

/** What the caller's `open` output says when the launch confirmation it saw stayed unanswered. */
function launchConfirmationUnansweredWarning(reason: LaunchConfirmationUnansweredReason): string {
  if (reason === 'url-owner-unresolved') {
    return (
      'iOS is still holding the launch confirmation and the installed app that owns the launch ' +
      "URL's scheme could not be resolved, so this launch URL has not reached the app. Answer it " +
      'with `alert accept`.'
    );
  }
  return (
    'iOS shows an alert this open did not recognize (alert-unrecognized), so it left the launch ' +
    'URL unconfirmed. The alert can be the launch confirmation in another language, or an alert ' +
    "of the app's own, such as a permission prompt. Read it with `alert get`. Answer with " +
    '`alert accept` only when it is the launch confirmation; answer any other alert on its own ' +
    'terms.'
  );
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
      reason: 'claim-lost-during-open',
      deviceKey: ownership.deviceKey,
      hint: 'Close this session and open the device again to claim it.',
    },
  );
}

// fallow-ignore-next-line complexity
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
  runtimeHints: ReturnType<SessionStore['getRuntimeHints']>;
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
  const outcome = await lifecycle.operations.openApplication({
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
    runtimeHints: runtimeHintValues(runtimeHints),
    applyRuntimeHints,
    execution: applicationLifecycleExecutionFromRequest(
      req,
      logPath,
      openDispatchSession?.trace?.outPath,
    ),
  });
  sessionAppBundleId = outcome.appBundleId ?? sessionAppBundleId;
  const timing: OpenTiming = { ...outcome.timing };
  const preparedSelection = markSelectionBootOccurred(selection);
  const startupSample = openTarget
    ? buildStartupPerfSample(openStartedAtMs, openTarget, sessionAppBundleId)
    : undefined;
  if (isRequestCanceled(req.meta?.requestId)) {
    const canceled = createRequestCanceledError();
    return {
      type: 'response',
      response: errorResponse(canceled.code, canceled.message, canceled.details),
    };
  }

  requireOpenSessionAdmission(sessionStore, sessionName, openDispatchRef);
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
    launchConfirmation: launchConfirmationReport(outcome),
  });
  if (tookOverDeviceClaim) {
    appendResponseWarning(openResult, deviceClaimTakeoverWarning(tookOverDeviceClaim, req));
  }
  if (outcome.launchConfirmation === 'unanswered') {
    appendResponseWarning(
      openResult,
      launchConfirmationUnansweredWarning(outcome.launchConfirmationReason),
    );
  }
  if (outcome.launchConfirmation === undefined && outcome.launchConfirmationProbeFailure) {
    appendResponseWarning(openResult, launchConfirmationProbeFailureWarning());
  }
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
  const nextSession = sessionStore.requireCurrent(nextRef);
  markPostOpenStabilization(nextSession, timing.postOpenObservation);
  if (req.runtime !== undefined)
    setSessionRuntimeHintsForOpen(sessionStore, sessionName, runtimeHints);
  applyOrdinaryScriptRecordingOpenOutcome({
    session: nextSession,
    existingSession: existingRef ? nextSession : undefined,
    saveScriptRequested: Boolean(req.flags?.saveScript),
    responseData: openResult,
    hostCwd: sessionStore.host.cwd,
  });
  sessionStore.recordAction(nextRef, {
    command: 'open',
    positionals: openPositionals,
    flags: req.flags ?? {},
    runtime: req.runtime !== undefined ? runtimeHints : undefined,
    result: openResult,
  });
  return { type: 'opened', ref: nextRef, response: { ok: true, data: openResult } };
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

/**
 * The refusal an open gets when another session already holds the device, or a device that
 * overlaps it. The wait an expired `--wait` budget spent is carried into the recovery text, because
 * a caller that waited is not helped by being told to wait.
 */
function findNewSessionDeviceConflict(params: {
  req: DaemonRequest;
  device: DeviceInfo;
  sessionStore: SessionStore;
}): DaemonFailureResponse | undefined {
  const { req, device, sessionStore } = params;
  const inUse = sessionStore.findByDevice(device.id);
  if (!inUse) return undefined;
  // The wait the caller paid for belongs to `open` alone: an interaction that hits the same busy
  // device cannot wait for it, and would be sent off with a flag its own command rejects.
  const attempt = describeOpenWaitForRefusal(req);
  if (isImplicitSessionScopeConflict(req, inUse.session)) {
    return buildForeignWorkspaceSessionConflict(inUse, device, attempt);
  }
  return buildDeviceInUseBySessionError(inUse, device, attempt);
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
        workspace: req.meta?.cwd ?? params.host.cwd,
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
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  device: DeviceInfo;
  surface: SessionSurface;
  openTarget: string | undefined;
  lifecycle: OpenApplicationRuntime;
  runtimeHintPlan: ResolvedOpenRuntimeHintPlan;
  applyRuntimeHints?: RuntimeHintApplyOperation;
  clearRuntimeHints?: RuntimeHintClearOperation;
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
  const conflict = findNewSessionDeviceConflict({ req, device, sessionStore });
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
