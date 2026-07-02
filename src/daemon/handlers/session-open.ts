import { dispatchCommand, resolveTargetDevice } from '../../core/dispatch.ts';
import { isDeepLinkTarget } from '../../core/open-target.ts';
import type { SessionSurface } from '../../core/session-surface.ts';
import { contextFromFlags } from '../context.ts';
import { createRequestCanceledError, isRequestCanceled } from '../request-cancel.ts';
import {
  prewarmIosRunnerSession,
  stopIosRunnerSession,
} from '../../platforms/apple/core/runner/runner-client.ts';
import {
  buildAppleRunnerSessionOptions,
  createAppleRunnerCacheColdBootPrewarmForOpen,
} from '../apple-runner-options.ts';
import { applyRuntimeHintsToApp } from '../runtime-hints.ts';
import { isApplePlatform, isIosFamily, type DeviceInfo } from '../../kernel/device.ts';
import type { DaemonRequest, DaemonResponse, SessionRuntimeHints, SessionState } from '../types.ts';
import {
  resolveSessionRequestLogPath,
  resolveSessionRunnerLogPath,
  SessionStore,
} from '../session-store.ts';
import {
  IOS_SIMULATOR_POST_CLOSE_SETTLE_MS,
  IOS_SIMULATOR_POST_OPEN_SETTLE_MS,
  isIosSimulator,
  refreshSessionDeviceIfNeeded,
  settleIosSimulator,
} from './session-device-utils.ts';
import { countConfiguredRuntimeHints, setSessionRuntimeHintsForOpen } from './session-runtime.ts';
import { STARTUP_SAMPLE_METHOD, type StartupPerfSample } from './session-startup-metrics.ts';
import { buildNextOpenSession, buildOpenResult } from './session-open-surface.ts';
import { markAndroidSnapshotFreshness } from '../android-snapshot-freshness.ts';
import { resetAndroidFramePerfStats } from '../../platforms/android/perf.ts';
import { withKeyedLock } from '../../utils/keyed-lock.ts';
import { getDiagnosticsMeta } from '../../utils/diagnostics.ts';
import { inferAndroidPackageAfterOpen } from './session-open-target.ts';
import {
  invalidOpenArgs,
  prepareOpenCommandDetails,
  resolveOpenSurfaceResponse,
  validatePreResolvedOpenRequest,
  validateResolvedOpenRequest,
} from './session-open-prepare.ts';
import { errorResponse } from './response.ts';
import { buildSessionRecoveryHint } from '../session-recovery-hints.ts';
import {
  isImplicitSessionScopeConflict,
  resolveImplicitSessionScope,
  resolvePublicSessionName,
} from '../session-routing.ts';
import { resolveSessionLeaseForRequest } from '../lease-lifecycle.ts';

const firstSessionOpenLocks = new Map<string, Promise<unknown>>();

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

async function relaunchCloseApp(params: {
  device: DeviceInfo;
  closeTarget: string;
  outFlag: string | undefined;
  context: Parameters<typeof dispatchCommand>[4];
}): Promise<void> {
  const { device, closeTarget, outFlag, context } = params;
  // Only Apple targets have an XCUITest runner to tear down, and simulators
  // keep theirs hot: their close/open go through simctl and never touch the
  // runner (~6s saved per open --relaunch); one that goes stale is caught by
  // the readiness preflight and restarted via invalidateRunnerSession.
  // macOS and real iOS devices keep the conservative teardown — the device
  // transport rides the tunnel, which app relaunches can disturb.
  if (isApplePlatform(device.platform) && !isIosSimulator(device)) {
    await stopIosRunnerSession(device.id);
  }
  await dispatchCommand(device, 'close', [closeTarget], outFlag, context);
  await settleIosSimulator(device, IOS_SIMULATOR_POST_CLOSE_SETTLE_MS);
}

async function maybeApplySessionLaunchUrl(params: {
  runtime: SessionRuntimeHints | undefined;
  device: DeviceInfo;
  req: DaemonRequest;
  logPath: string;
  appBundleId?: string;
  traceLogPath?: string;
  openPositionals: string[];
}): Promise<void> {
  const { runtime, device, req, logPath, appBundleId, traceLogPath, openPositionals } = params;
  const launchUrl = runtime?.launchUrl;
  if (!launchUrl) return;
  if (openPositionals.length === 0) return;
  if (openPositionals.length > 1) return;
  const openTarget = openPositionals[0]?.trim();
  if (!openTarget || isDeepLinkTarget(openTarget)) return;
  await dispatchCommand(device, 'open', [launchUrl], req.flags?.out, {
    ...contextForRuntimeLaunchUrl(logPath, req.flags, appBundleId, traceLogPath),
  });
}

function contextForRuntimeLaunchUrl(
  logPath: string,
  flags: DaemonRequest['flags'],
  appBundleId?: string,
  traceLogPath?: string,
): ReturnType<typeof contextFromFlags> {
  const context = contextFromFlags(logPath, flags, appBundleId, traceLogPath);
  delete context.launchConsole;
  delete context.launchArgs;
  return context;
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
async function completeOpenCommand(params: {
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
  runtime: SessionRuntimeHints | undefined;
  existingSession?: SessionState;
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
    runtime,
    existingSession,
  } = params;
  const shouldRelaunch = req.flags?.relaunch === true;
  const traceLogPath = existingSession?.trace?.outPath;
  let sessionAppBundleId = appBundleId;
  const openCommandStartedAtMs = Date.now();
  const timing: OpenTiming = {};

  const shouldPrewarmIosRunner =
    isIosFamily(device) &&
    surface === 'app' &&
    openPositionals.length > 0 &&
    Boolean(sessionAppBundleId);
  const runnerPrewarmOptions = buildAppleRunnerSessionOptions({
    req,
    logPath,
    appBundleId: sessionAppBundleId,
    traceLogPath,
  });
  const shouldPrewarmRunnerBeforeOpen = req.flags?.maestro?.prewarmRunnerBeforeOpen === true;
  let runnerPrewarm: Promise<void> | undefined;
  // Tracked separately from `runnerPrewarm`: prewarmIosRunnerSession may
  // return undefined (prewarm unavailable), and one attempt is one attempt.
  let runnerPrewarmScheduled = false;
  let runnerPrewarmAwaited = false;
  const schedulePrewarm = (
    options: Parameters<typeof prewarmIosRunnerSession>[1] = runnerPrewarmOptions,
  ): void => {
    runnerPrewarmScheduled = true;
    timing.runnerPrewarmKind = 'session';
    timing.runnerPrewarmScheduled = true;
    runnerPrewarm = prewarmIosRunnerSession(device, options);
  };
  const awaitPrewarm = async (): Promise<void> => {
    if (!runnerPrewarm || runnerPrewarmAwaited) return;
    runnerPrewarmAwaited = true;
    const startedAtMs = Date.now();
    await runnerPrewarm;
    timing.runnerPrewarmWaited = true;
    timing.runnerPrewarmDurationMs = Math.max(0, Date.now() - startedAtMs);
  };
  // Start the runner spin-up before close/open dispatch on simulators: neither
  // touches the runner there (both ride simctl), so the xcodebuild ramp
  // overlaps the app relaunch instead of following it. Real devices tear the
  // runner down in relaunchCloseApp, so their prewarm stays post-open.
  if (shouldPrewarmIosRunner && isIosSimulator(device) && !shouldPrewarmRunnerBeforeOpen) {
    schedulePrewarm();
  }

  if (shouldRelaunch && openTarget) {
    const closeTarget = sessionAppBundleId ?? openTarget;
    const closeStartedAtMs = Date.now();
    await relaunchCloseApp({
      device,
      closeTarget,
      outFlag: req.flags?.out,
      context: {
        ...contextFromFlags(
          logPath,
          req.flags,
          sessionAppBundleId ?? existingSession?.appBundleId,
          traceLogPath,
        ),
      },
    });
    timing.relaunchCloseDurationMs = Math.max(0, Date.now() - closeStartedAtMs);
  }

  const runtimeHintsStartedAtMs = Date.now();
  await applyRuntimeHintsToApp({
    device,
    appId: sessionAppBundleId,
    runtime,
  });
  timing.runtimeHintsDurationMs = Math.max(0, Date.now() - runtimeHintsStartedAtMs);
  if (shouldPrewarmIosRunner && shouldPrewarmRunnerBeforeOpen) {
    schedulePrewarm({ ...runnerPrewarmOptions, propagateError: true });
    await awaitPrewarm();
  }
  const openStartedAtMs = Date.now();
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
  if (provisionalSession.type === 'response') {
    return provisionalSession.response;
  }
  const openDispatchSession = provisionalSession.session ?? existingSession;
  await dispatchCommand(device, 'open', openPositionals, req.flags?.out, {
    ...contextFromFlags(logPath, req.flags, sessionAppBundleId),
  });
  timing.openDispatchDurationMs = Math.max(0, Date.now() - openStartedAtMs);
  const launchUrlStartedAtMs = Date.now();
  await maybeApplySessionLaunchUrl({
    runtime,
    device,
    req,
    logPath,
    appBundleId: sessionAppBundleId,
    traceLogPath,
    openPositionals,
  });
  timing.launchUrlDurationMs = Math.max(0, Date.now() - launchUrlStartedAtMs);
  if (shouldPrewarmIosRunner && !runnerPrewarmScheduled) {
    schedulePrewarm();
  }
  if (shouldRelaunch) {
    await awaitPrewarm();
  } else if (runnerPrewarm && !runnerPrewarmAwaited) {
    timing.runnerPrewarmWaited = false;
  }
  sessionAppBundleId = await inferAndroidPackageAfterOpen(device, openTarget, sessionAppBundleId);
  if (device.platform === 'android' && sessionAppBundleId) {
    await resetAndroidFramePerfStats(device, sessionAppBundleId);
  }
  const startupSample = openTarget
    ? buildStartupPerfSample(openStartedAtMs, openTarget, sessionAppBundleId)
    : undefined;
  const settleStartedAtMs = Date.now();
  await settleIosSimulator(device, IOS_SIMULATOR_POST_OPEN_SETTLE_MS);
  timing.postOpenSettleDurationMs = Math.max(0, Date.now() - settleStartedAtMs);
  if (isRequestCanceled(req.meta?.requestId)) {
    const canceled = createRequestCanceledError();
    return errorResponse(canceled.code, canceled.message, canceled.details);
  }

  if (existingSession) {
    // Mark freshness before buildNextOpenSession clears the stored snapshot. `open` is one of
    // the few nav-sensitive commands that would otherwise lose its pre-action baseline.
    markAndroidSnapshotFreshness(existingSession, 'open', existingSession.snapshot);
  }
  const nextSession = buildNextOpenSession({
    existingSession: openDispatchSession,
    sessionName: existingSession?.name ?? resolvePublicSessionName(req),
    sessionScope: existingSession?.sessionScope ?? resolveImplicitSessionScope(req),
    device,
    surface,
    appBundleId: sessionAppBundleId,
    appName,
    saveScript: Boolean(req.flags?.saveScript),
  });
  nextSession.lease = resolveSessionLeaseForRequest({
    req,
    existingLease: existingSession?.lease,
  });
  if (req.runtime !== undefined) {
    setSessionRuntimeHintsForOpen(sessionStore, sessionName, runtime);
  }
  const sessionStateDir = sessionStore.ensureSessionDir(sessionName);
  const requestLogPath = resolveSessionRequestLogPath(
    sessionStateDir,
    req.meta?.requestId ?? getDiagnosticsMeta().requestId,
  );
  timing.totalDurationMs = Math.max(0, Date.now() - openCommandStartedAtMs);
  const openResult = buildOpenResult({
    sessionName: nextSession.name,
    sessionStateDir,
    runnerLogPath: resolveSessionRunnerLogPath(sessionStateDir),
    requestLogPath,
    appName,
    appBundleId: sessionAppBundleId,
    surface,
    startup: startupSample,
    timing,
    device,
    runtime,
    runtimeHintCount: countConfiguredRuntimeHints,
  });
  sessionStore.recordAction(nextSession, {
    command: 'open',
    positionals: openPositionals,
    flags: req.flags ?? {},
    runtime: req.runtime !== undefined ? runtime : undefined,
    result: openResult,
  });
  sessionStore.set(sessionName, nextSession);
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
  const {
    req,
    sessionName,
    sessionStore,
    device,
    surface,
    sessionAppBundleId,
    appName,
    existingSession,
  } = params;
  const beforeDispatch = req.internal?.openLifecycle?.beforeDispatch;
  if (!beforeDispatch) return { type: 'session', session: existingSession };
  const provisionalSession = buildNextOpenSession({
    existingSession,
    sessionName: existingSession?.name ?? resolvePublicSessionName(req),
    sessionScope: existingSession?.sessionScope ?? resolveImplicitSessionScope(req),
    device,
    surface,
    appBundleId: sessionAppBundleId,
    appName,
    saveScript: Boolean(req.flags?.saveScript),
  });
  provisionalSession.lease = resolveSessionLeaseForRequest({
    req,
    existingLease: existingSession?.lease,
  });
  sessionStore.set(sessionName, provisionalSession);
  const lifecycleResponse = await beforeDispatch(provisionalSession);
  if (lifecycleResponse && !lifecycleResponse.ok) {
    return { type: 'response', response: lifecycleResponse };
  }
  return { type: 'session', session: sessionStore.get(sessionName) ?? provisionalSession };
}

// fallow-ignore-next-line complexity
export async function handleOpenCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore } = params;

  const session = sessionStore.get(sessionName);
  if (session) {
    const shouldRelaunch = req.flags?.relaunch === true;
    const requestedOpenTarget = req.positionals?.[0];
    const openTarget = requestedOpenTarget ?? (shouldRelaunch ? session.appName : undefined);
    const surfaceResult = resolveOpenSurfaceResponse(
      session.device,
      req.flags?.surface,
      openTarget,
      session.surface,
    );
    if (typeof surfaceResult !== 'string') {
      return surfaceResult;
    }
    if (!openTarget && surfaceResult === 'app') {
      return shouldRelaunch
        ? invalidOpenArgs('open --relaunch requires an app name or an active session app.')
        : invalidOpenArgs('Session already active. Close it first or pass a new --session name.');
    }

    const validation = validateResolvedOpenRequest({
      shouldRelaunch,
      openTarget,
      surface: surfaceResult,
      device: session.device,
    });
    if (validation) {
      return validation;
    }

    const device = await refreshSessionDeviceIfNeeded(session.device);
    const details = await prepareOpenCommandDetails({
      req,
      sessionName,
      sessionStore,
      device,
      surface: surfaceResult,
      openTarget,
      existingSession: session,
      onIosSimulatorColdBootStart: createAppleRunnerCacheColdBootPrewarmForOpen({
        req,
        logPath,
        device,
        surface: surfaceResult,
        openTarget,
        traceLogPath: session.trace?.outPath,
      }),
    });
    if (details.type === 'response') {
      return details.response;
    }

    return await completeOpenCommand({
      req,
      sessionName,
      sessionStore,
      logPath,
      device,
      openTarget,
      openPositionals: requestedOpenTarget
        ? (req.positionals ?? [])
        : openTarget
          ? [openTarget]
          : [],
      appBundleId: details.details.appBundleId,
      appName: details.details.appName,
      runtime: details.details.runtime,
      surface: surfaceResult,
      existingSession: session,
    });
  }

  const shouldRelaunch = req.flags?.relaunch === true;
  const openTarget = req.positionals?.[0];
  if (shouldRelaunch && !openTarget) {
    return invalidOpenArgs('open --relaunch requires an app argument.');
  }

  const preResolvedValidation = validatePreResolvedOpenRequest({
    shouldRelaunch,
    openTarget,
    platform: req.flags?.platform === 'android' ? 'android' : undefined,
  });
  if (preResolvedValidation) {
    return preResolvedValidation;
  }

  const device = await resolveTargetDevice(req.flags ?? {});
  const surfaceResult = resolveOpenSurfaceResponse(device, req.flags?.surface, openTarget);
  if (typeof surfaceResult !== 'string') {
    return surfaceResult;
  }

  const validation = validateResolvedOpenRequest({
    shouldRelaunch,
    openTarget,
    surface: surfaceResult,
    device,
  });
  if (validation) {
    return validation;
  }

  return await withKeyedLock(firstSessionOpenLocks, device.id, async () => {
    const inUse = sessionStore
      .toArray()
      .find((activeSession) => activeSession.device.id === device.id);
    if (inUse) {
      if (isImplicitSessionScopeConflict(req, inUse)) {
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
      return errorResponse(
        'DEVICE_IN_USE',
        `Device is already in use by session "${inUse.name}".`,
        {
          session: inUse.name,
          deviceId: device.id,
          deviceName: device.name,
          hint: buildSessionRecoveryHint(inUse, 'device-in-use'),
        },
      );
    }

    const details = await prepareOpenCommandDetails({
      req,
      sessionName,
      sessionStore,
      device,
      surface: surfaceResult,
      openTarget,
      onIosSimulatorColdBootStart: createAppleRunnerCacheColdBootPrewarmForOpen({
        req,
        logPath,
        device,
        surface: surfaceResult,
        openTarget,
      }),
    });
    if (details.type === 'response') {
      return details.response;
    }

    return await completeOpenCommand({
      req,
      sessionName,
      sessionStore,
      logPath,
      device,
      openTarget,
      openPositionals: req.positionals ?? [],
      appBundleId: details.details.appBundleId,
      appName: details.details.appName,
      runtime: details.details.runtime,
      surface: surfaceResult,
    });
  });
}
