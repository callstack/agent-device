import {
  openApplicationRuntimeUse,
  openApplicationWithRuntimeHintApplyUse,
  openApplicationWithRuntimeHintClearUse,
} from '@agent-device/contracts/application-lifecycle-runtime-plan';
import {
  markSelectionBootOccurred,
  type DeviceSelectionResult,
} from '../../core/device-selection-resolver.ts';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DaemonRequest,
  DaemonResponse,
  SessionRef,
  SessionScope,
  SessionState,
} from '../types.ts';
import {
  abortAuthoringOnSecondOpen,
  armAuthoringOnOpen,
  isAuthoringArmedSession,
} from '../session-script-publication-capability.ts';
import { isRequestCanceled } from '@agent-device/host-kit/request';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  resolveSessionRequestLogPath,
  resolveSessionRunnerLogPath,
  SessionStore,
} from '../session-store.ts';
import {
  countConfiguredRuntimeHints,
  runtimeHintValues,
  setSessionRuntimeHintsForOpen,
} from './session-runtime.ts';
import { STARTUP_SAMPLE_METHOD, type StartupPerfSample } from './session-startup-metrics.ts';
import { buildNextOpenSession, buildOpenResult } from './session-open-surface.ts';
import { markDeferredInteractionOutcome } from '../deferred-interaction-outcome.ts';
import { emitDiagnostic, getDiagnosticsMeta } from '@agent-device/host-kit/diagnostics';
import {
  prepareOpenCommandDetails,
  type ResolvedOpenRuntimeHintPlan,
} from './session-open-prepare.ts';
import { errorResponse } from './response.ts';
import { buildSessionRecoveryHint } from '../session-recovery-hints.ts';
import {
  isImplicitSessionScopeConflict,
  resolveSessionScope,
  resolvePublicSessionName,
} from '../session-routing.ts';
import { resolveSessionLeaseForRequest } from '../lease-lifecycle.ts';
import { applicationLifecycleExecutionFromRequest } from '../application-lifecycle-execution.ts';
import {
  abandonDeviceClaim,
  acquireDeviceClaim,
  clearDeviceClaim,
  isLocalDeviceClaimTarget,
  type DeviceClaimAcquireResult,
  type DeviceClaimSessionOwnership,
  type DeviceClaimReconciler,
} from '../device-claims.ts';
import { buildDeviceClaimConflictError } from '../device-claim-conflict.ts';

type OpenTiming = {
  totalDurationMs?: number;
  relaunchCloseDurationMs?: number;
  runtimeHintsDurationMs?: number;
  runnerPrewarmKind?: 'session' | 'xctestrun';
  runnerPrewarmScheduled?: boolean;
  runnerPrewarmWaited?: boolean;
  runnerPrewarmDurationMs?: number;
  openDispatchDurationMs?: number;
  launchUrlDurationMs?: number;
  postOpenSettleDurationMs?: number;
};

type NewSessionOpenEffects = { mayHaveStarted: boolean };

export type OpenApplicationRuntime = BoundDeviceRuntime<typeof openApplicationRuntimeUse>;
export type RuntimeHintApplyOperation = BoundDeviceRuntime<
  typeof openApplicationWithRuntimeHintApplyUse
>['operations']['applyRuntimeHints'];
export type RuntimeHintClearOperation = BoundDeviceRuntime<
  typeof openApplicationWithRuntimeHintClearUse
>['operations']['clearRuntimeHints'];

function resolveOpenSessionScope(req: DaemonRequest): SessionScope {
  return req.internal?.resolvedSessionScope ?? resolveSessionScope(req);
}

function applyOrdinaryScriptRecordingOpenOutcome(params: {
  session: SessionState;
  existingSession: SessionState | undefined;
  saveScriptRequested: boolean;
  responseData: Record<string, unknown>;
}): void {
  const { session, existingSession, saveScriptRequested, responseData } = params;
  if (!existingSession && saveScriptRequested) {
    // The recorded `open` action's flag ingress applies the explicit path/force right after
    // this arm (`applyRecordedSaveScriptFlags`), exactly as the field writers used to split it.
    armAuthoringOnOpen(session, {});
    return;
  }
  if (!isAuthoringArmedSession(existingSession)) return;
  abortAuthoringOnSecondOpen(session);
  const warnings = Array.isArray(responseData.warnings)
    ? responseData.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  responseData.warnings = [
    ...warnings,
    'Script publication was aborted because this session completed a second open. Start a fresh session with open --save-script to author another script.',
  ];
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
  existingSession?: SessionState;
  deviceClaim?: DeviceClaimSessionOwnership;
  selection?: DeviceSelectionResult;
}): Promise<DaemonResponse> {
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
    existingSession,
    deviceClaim,
    selection,
  } = params;
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
    existingSession,
  });
  if (provisionalSession.type === 'response') return provisionalSession.response;
  const openDispatchSession = provisionalSession.session ?? existingSession;
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
      existingSession?.trace?.outPath,
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
    return errorResponse(canceled.code, canceled.message, canceled.details);
  }

  if (existingSession) {
    // Mark before buildNextOpenSession clears the stored snapshot. `open` is one of the few
    // nav-sensitive commands that would otherwise lose its pre-action freshness baseline.
    markDeferredInteractionOutcome({
      session: existingSession,
      command: 'open',
      positionals: [],
      flags: undefined,
    });
  }
  const nextSession = buildNextOpenSession({
    existingSession: openDispatchSession,
    sessionName: existingSession?.name ?? resolvePublicSessionName(req),
    sessionScope: existingSession?.sessionScope ?? resolveOpenSessionScope(req),
    device,
    surface,
    appBundleId: sessionAppBundleId,
    appName,
  });
  nextSession.lease = resolveSessionLeaseForRequest({
    req,
    existingLease: existingSession?.lease,
  });
  if (deviceClaim) nextSession.deviceClaim = deviceClaim;
  if (req.runtime !== undefined) {
    setSessionRuntimeHintsForOpen(sessionStore, sessionName, runtimeHints);
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
    sessionName: nextSession.name,
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
  });
  applyOrdinaryScriptRecordingOpenOutcome({
    session: nextSession,
    existingSession,
    saveScriptRequested: Boolean(req.flags?.saveScript),
    responseData: openResult,
  });
  sessionStore.set(sessionName, nextSession);
  sessionStore.recordAction(nextSession, {
    command: 'open',
    positionals: openPositionals,
    flags: req.flags ?? {},
    runtime: req.runtime !== undefined ? runtimeHints : undefined,
    result: openResult,
  });
  return { ok: true, data: openResult };
}

async function prepareOpenDispatchSession(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  device: DeviceInfo;
  surface: SessionSurface;
  sessionAppBundleId: string | undefined;
  appName: string | undefined;
  existingSession: SessionState | undefined;
}): Promise<
  { type: 'session'; session?: SessionState } | { type: 'response'; response: DaemonResponse }
> {
  const { req, sessionName, sessionStore, existingSession } = params;
  const beforeDispatch = req.internal?.openLifecycle?.beforeDispatch;
  if (!beforeDispatch) return { type: 'session', session: existingSession };
  const provisionalSession = createProvisionalOpenDispatchSession(params);
  sessionStore.set(sessionName, provisionalSession);
  const lifecycleResponse = await beforeDispatch(provisionalSession);
  if (lifecycleResponse && !lifecycleResponse.ok) {
    return { type: 'response', response: lifecycleResponse };
  }
  return { type: 'session', session: sessionStore.get(sessionName) ?? provisionalSession };
}

function createProvisionalOpenDispatchSession(params: {
  req: DaemonRequest;
  sessionName: string;
  device: DeviceInfo;
  surface: SessionSurface;
  sessionAppBundleId: string | undefined;
  appName: string | undefined;
  existingSession: SessionState | undefined;
}): SessionState {
  const { req, device, surface, sessionAppBundleId, appName, existingSession } = params;
  const provisionalSession = buildNextOpenSession({
    existingSession,
    sessionName: existingSession?.name ?? resolvePublicSessionName(req),
    sessionScope: existingSession?.sessionScope ?? resolveOpenSessionScope(req),
    device,
    surface,
    appBundleId: sessionAppBundleId,
    appName,
  });
  provisionalSession.lease = resolveSessionLeaseForRequest({
    req,
    existingLease: existingSession?.lease,
  });
  return provisionalSession;
}

function findNewSessionDeviceConflict(params: {
  req: DaemonRequest;
  device: DeviceInfo;
  sessionStore: SessionStore;
}): DaemonResponse | undefined {
  const { req, device, sessionStore } = params;
  const inUse = sessionStore.findByDevice(device.id);
  if (!inUse) return undefined;
  if (isImplicitSessionScopeConflict(req, inUse.session)) {
    return errorResponse(
      'DEVICE_IN_USE',
      'Device is already in use by another workspace session.',
      {
        deviceId: device.id,
        deviceName: device.name,
        hint: 'Use a different device selector, wait for the other workspace to close its session, or run agent-device devices to choose another target.',
      },
    );
  }
  return buildDeviceInUseBySessionError(inUse, device);
}

// Exported as the single by-session DEVICE_IN_USE producer so the help-benchmark sample parity
// test renders the exact error this handler returns; a message or hint change here fails that
// gate instead of drifting past it.
export function buildDeviceInUseBySessionError(
  inUse: SessionRef,
  device: DeviceInfo,
): DaemonResponse {
  return errorResponse('DEVICE_IN_USE', `Device is already in use by session "${inUse.address}".`, {
    session: inUse.address,
    deviceId: device.id,
    deviceName: device.name,
    hint: buildSessionRecoveryHint(inUse, 'device-in-use'),
  });
}

async function acquireLocalDeviceClaim(params: {
  req: DaemonRequest;
  device: DeviceInfo;
  owner: OpenApplicationRuntime['owner'];
  sessionName: string;
  sessionStore: SessionStore;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): Promise<DeviceClaimAcquireResult | { status: 'not-required' }> {
  const { req, device, owner, sessionName, sessionStore, reconcileOrphanedDeviceClaim } = params;
  if (!isLocalDeviceClaimTarget(owner)) return { status: 'not-required' };
  return await acquireDeviceClaim({
    device,
    session: sessionName,
    workspace: req.meta?.cwd ?? process.cwd(),
    stateDir: sessionStore.resolveDaemonStateDir(),
    reconcileOrphanedDeviceClaim,
  });
}

export async function openNewSessionWithDeviceClaim(params: {
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
}): Promise<DaemonResponse> {
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
  } = params;
  const conflict = findNewSessionDeviceConflict({ req, device, sessionStore });
  if (conflict) return conflict;

  const localClaim = await acquireLocalDeviceClaim({
    req,
    device,
    owner: lifecycle.owner,
    sessionName,
    sessionStore,
    reconcileOrphanedDeviceClaim,
  });
  if (localClaim.status === 'conflict') {
    return buildDeviceClaimConflictError(device, localClaim.conflict);
  }
  const deviceClaim = localClaim.status === 'acquired' ? localClaim.ownership : undefined;
  const effects: NewSessionOpenEffects = { mayHaveStarted: false };
  const rollbackClaim = async () =>
    await rollbackNewSessionClaim({
      ownership: deviceClaim,
      effects,
      sessionName,
      sessionStore,
    });
  try {
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
      return details.response;
    }
    // Preparation can boot the device or warm caches, but it cannot establish session ownership.
    // `completeOpenCommand` can relaunch-close an app or write runtime hints before its main open
    // dispatch, so a failure from that point cannot prove ownership was not established.
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
      selection,
    });
    if (!response.ok) await rollbackClaim();
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
}): Promise<void> {
  const { ownership, effects, sessionName, sessionStore } = params;
  if (!ownership) return;
  if (!effects.mayHaveStarted) {
    await clearDeviceClaim(ownership);
    return;
  }
  if (sessionStore.get(sessionName)?.deviceClaim?.ownerToken === ownership.ownerToken) return;
  const outcome = await abandonDeviceClaim(ownership);
  emitDiagnostic({
    level: 'warn',
    phase: 'device_claim_open_effects_unconfirmed',
    data: { deviceKey: ownership.deviceKey, outcome },
  });
}
