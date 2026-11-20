import type { LeaseRegistry } from '../../../resources/lease-registry.ts';
import { inspectSessionLeaseRetainedOnClose } from '../../lease-lifecycle.ts';
import type { CloseApplicationFinalizationResult } from '@agent-device/contracts/application-lifecycle-runtime';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import type {
  LaunchedDeviceProcessService,
  LaunchedProcessCheck,
} from '@agent-device/contracts/device-boot';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { renewDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { OrdinaryCloseScript } from './session-close-script.ts';
import type { SessionRef, SessionState } from '../../../core/session-state.ts';
import { SessionStore } from '../../../core/session-store.ts';
import { cleanupRetainedMaterializedPathsForSession } from '../../materialized-path-registry.ts';
import {
  reportSessionCleanupFailures,
  sessionResourceStopSteps,
  type SessionCleanupFailure,
} from '../../session-teardown.ts';
import type { PlatformResourceCleanup } from '../../../core/platform-resource-cleanup.ts';
import { hasRuntimeTransportHints, runtimeHintValues } from '../../session-runtime.ts';
import type {
  CloseRuntime,
  CloseRuntimeWithRuntimeHintClear,
  RuntimeHintClearOperation,
} from './session-close-runtime-admission.ts';

export type PlatformCloseDispatcher = (params: {
  req: DaemonRequest;
  session: SessionState;
  logPath: string;
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
}) => Promise<unknown>;

/** The stop one close owes its device, and the reason it reports when it owes none. */
type CloseDeviceStopDecision = Readonly<{
  shutdownRequested: boolean;
  /**
   * #4162: the close owned stopping the device its own `open` booted, and this daemon's policy
   * denies `device-shutdown`, so the device stays running. The close itself succeeded.
   */
  implicitShutdownDeniedByPolicy: boolean;
  implicitShutdownClaimLost: boolean;
  /**
   * #4585: the process this session's `open` launched is not running the device any more, so whoever
   * answers that device address now is somebody else's device and the implicit stop is withheld. The
   * close itself succeeded.
   */
  implicitShutdownLaunchedProcessGone: boolean;
  /**
   * #4585: close could not establish whether its own launched process still runs, so it stops
   * nothing. This covers the open that recorded no process identity and a host that would not answer
   * for the recorded process.
   */
  implicitShutdownLaunchedProcessUnverified: boolean;
}>;

export type SessionCloseTeardownResult = Readonly<{
  platformCloseError: unknown;
  retainExecutionHost: boolean;
  saveScriptOutcome: OrdinaryCloseScript;
  shutdownResult?: TargetShutdownResult;
  shutdownPrepared: boolean;
  /**
   * The stop was asked for, but the process this session launched was still running when the
   * confirmation budget ended and the pid stop could not confirm its exit.
   */
  implicitShutdownStopUnconfirmed: boolean;
}> &
  Omit<CloseDeviceStopDecision, 'shutdownRequested'>;

/**
 * #4162: plain close stops a local virtual device this session's own open booted. The boot fact
 * only ever comes from local selection, and the local-family check keeps it off provider paths,
 * which release through their lease instead. A policy that denies `device-shutdown` keeps this
 * close's own stop from ever being asked: the refusal is decided before the call, so the runner
 * retention a kept-running device earns is not spent on a stop that can never happen.
 *
 * #4585: the stop this session owes is owed to the launch its own open caused, not to whatever
 * answers the device address now. This decides only whether a stop is owed. The process behind the
 * launch is checked once, later, right before the stop is asked for (`runSessionCloseTeardown`),
 * so platform close and hint cleanup cannot open a window in which a replacement takes the serial.
 * An explicit `--shutdown` commands the stop whatever the process says, and a lost claim or a
 * policy refusal has already decided it without reaching the host.
 */
async function decideDeviceStopOnClose(params: {
  env: EnvMap;
  explicitShutdown: boolean;
  session: SessionState;
  localFamily: boolean;
  deviceShutdownDenied: boolean;
}): Promise<CloseDeviceStopDecision> {
  const { session } = params;
  const implicitShutdown =
    !params.explicitShutdown && session.bootedByOpen === true && params.localFamily;
  const claimRenewal = implicitShutdown
    ? await renewDeviceClaim(session.deviceClaim, params.env)
    : undefined;
  const implicitShutdownClaimLost = claimRenewal?.status === 'lost';
  const implicitShutdownDeniedByPolicy =
    implicitShutdown && !implicitShutdownClaimLost && params.deviceShutdownDenied;
  return {
    shutdownRequested:
      params.explicitShutdown ||
      (implicitShutdown && !implicitShutdownDeniedByPolicy && claimRenewal?.status === 'renewed'),
    implicitShutdownDeniedByPolicy,
    implicitShutdownClaimLost,
    implicitShutdownLaunchedProcessGone: false,
    implicitShutdownLaunchedProcessUnverified: false,
  };
}

/**
 * Whether the process that launched this session's device still runs it. The owner answers
 * `not-applicable` for a device whose family launches no host process, so this never learns which
 * families have one, and it passes the recorded identity through as recorded — including its absence,
 * which is the answer a launch that recorded nothing gets.
 */
async function checkLaunchedProcessOwnership(
  session: SessionState,
  launchedProcess: LaunchedDeviceProcessService,
): Promise<LaunchedProcessCheck> {
  const identity = session.androidLaunchIdentity;
  const check = await launchedProcess.checkLaunchedProcess(session.device, identity);
  if (check === 'changed' || check === 'unverified')
    emitLaunchedProcessMiss(
      identity ? `process-check-${check}` : 'open-recorded-no-process',
      identity ? { pid: identity.pid } : {},
    );
  return check;
}

/**
 * Step 3 of the implicit stop: the platform asked its device to shut down, so confirm the process
 * this session launched actually left. A launch that recorded no process has nothing to confirm, and
 * the owner refuses to signal a process that no longer carries the recorded start time.
 */
async function confirmLaunchedProcessStopped(
  session: SessionState,
  launchedProcess: LaunchedDeviceProcessService,
): Promise<boolean> {
  const identity = session.androidLaunchIdentity;
  if (!identity) return false;
  if (
    (await launchedProcess.confirmLaunchedProcessStopped(session.device, identity)) !==
    'unconfirmed'
  )
    return false;
  emitLaunchedProcessMiss('launched-process-stop-unconfirmed', { pid: identity.pid });
  return true;
}

/**
 * The one diagnostic for a session whose close could not settle the state of the process its own
 * `open` launched. `step` names the step that decided it, which is the only thing that separates the
 * cases the caller reports with the same warning.
 */
function emitLaunchedProcessMiss(step: string, data: Record<string, unknown> = {}): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'launch_process_identity_miss',
    data: { step, ...data },
  });
}

/** Runs owned resources, native close, native hint cleanup, and final lifecycle disposal. */
export async function runSessionCloseTeardown(params: {
  env: EnvMap;
  req: DaemonRequest;
  ref: SessionRef;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  lifecycle: CloseRuntime | CloseRuntimeWithRuntimeHintClear;
  clearRuntimeHints?: RuntimeHintClearOperation;
  cleanupFailures: SessionCleanupFailure[];
  repairArmed: boolean;
  dispatchTargetedPlatformClose: PlatformCloseDispatcher;
  finalizeOrdinaryCloseScript(input: {
    req: DaemonRequest;
    ref: SessionRef;
    sessionStore: SessionStore;
    platformCloseError: unknown;
  }): OrdinaryCloseScript;
  platformResourceCleanup: PlatformResourceCleanup;
  deviceShutdownDenied?: boolean;
  /** The host process this session's `open` launched, as the root-composed owner answers for it. */
  launchedProcess: LaunchedDeviceProcessService;
}): Promise<SessionCloseTeardownResult> {
  const {
    req,
    ref,
    logPath,
    sessionStore,
    lifecycle,
    clearRuntimeHints,
    cleanupFailures,
    repairArmed,
    dispatchTargetedPlatformClose,
    finalizeOrdinaryCloseScript,
  } = params;
  const { address: sessionName } = ref;
  let session = sessionStore.requireCurrent(ref);
  const attemptCleanup = async <Result>(
    step: string,
    run: () => Promise<Result>,
  ): Promise<Result | undefined> => {
    try {
      return await run();
    } catch (error) {
      cleanupFailures.push({ step, error });
      return undefined;
    }
  };
  // #4162 + #4585: what this close owes the device, and which reason it reports when it owes nothing.
  const deviceStop = await decideDeviceStopOnClose({
    env: params.env,
    explicitShutdown: req.flags?.shutdown === true,
    session,
    localFamily: lifecycle.owner.kind === 'local-family',
    deviceShutdownDenied: params.deviceShutdownDenied === true,
  });
  const { shutdownRequested, ...stopReasons } = deviceStop;
  const retainExecutionHost = params.platformResourceCleanup.retainExecutionHostAfterClose({
    device: session.device,
    shutdownRequested,
    hasScreenRecording: Boolean(session.screenRecording),
    leaseWillEnd:
      Boolean(session.lease) &&
      !(await attemptCleanup('lease_retention', async () =>
        inspectSessionLeaseRetainedOnClose({ session, leaseRegistry: params.leaseRegistry }),
      )),
  });
  const configuredRuntimeHints = sessionStore.getRuntimeHints(sessionName);
  const resourceStops = sessionResourceStopSteps({
    ref,
    sessionStore,
    platformCleanup: params.platformResourceCleanup,
    appLog: 'run',
  });
  for (const { step, run } of resourceStops) await attemptCleanup(step, run);
  session = sessionStore.requireCurrent(ref);
  const platformCloseError = repairArmed
    ? undefined
    : await dispatchTargetedPlatformClose({ req, session, logPath, lifecycle });
  if (
    clearRuntimeHints &&
    session.appBundleId &&
    hasRuntimeTransportHints(configuredRuntimeHints)
  ) {
    await attemptCleanup('runtime_hints', async () => {
      await clearRuntimeHints({
        appId: session.appBundleId,
        values: runtimeHintValues(configuredRuntimeHints),
      });
    });
  }
  // #4585: the one ownership read, after every other close step and right before the stop is asked
  // for. A replacement that took the serial during platform close or hint cleanup is seen here.
  const implicitStop = shutdownRequested && req.flags?.shutdown !== true;
  const launchedProcess = implicitStop
    ? await checkLaunchedProcessOwnership(session, params.launchedProcess)
    : 'not-applicable';
  const stopOwed =
    shutdownRequested && launchedProcess !== 'changed' && launchedProcess !== 'unverified';
  const finalization = await attemptCleanup(
    'application_lifecycle',
    async (): Promise<CloseApplicationFinalizationResult> =>
      (await lifecycle.operations.finalizeApplicationClose({
        appBundleId: session.appBundleId,
        surface: session.surface ?? 'app',
        retainRunner: retainExecutionHost,
        stateDir: sessionStore.resolveDaemonStateDir(),
        shutdownTarget: stopOwed && lifecycle.owner.kind === 'local-family',
      })) ?? {},
  );
  // The platform has asked the emulator it owns to shut down; this is where this session checks the
  // process it launched actually left, because `adb emu kill` answers for the guest, not for the
  // host process. An explicit `--shutdown` is the user's own command for the device and is not this
  // session's launched process to confirm.
  const stopUnconfirmed =
    implicitStop && stopOwed
      ? await confirmLaunchedProcessStopped(session, params.launchedProcess)
      : false;
  const saveScriptOutcome = repairArmed
    ? {}
    : finalizeOrdinaryCloseScript({ req, ref, sessionStore, platformCloseError });
  await attemptCleanup('materialized_paths', () =>
    cleanupRetainedMaterializedPathsForSession(sessionName),
  );
  return {
    platformCloseError,
    retainExecutionHost,
    saveScriptOutcome,
    shutdownResult: finalization?.shutdown,
    shutdownPrepared: finalization !== undefined,
    ...stopReasons,
    implicitShutdownLaunchedProcessGone: launchedProcess === 'changed',
    implicitShutdownLaunchedProcessUnverified: launchedProcess === 'unverified',
    implicitShutdownStopUnconfirmed: stopUnconfirmed,
  };
}

export function closeCleanupError(
  sessionName: string,
  failures: readonly SessionCleanupFailure[],
  options: { sessionKept: boolean },
): Error | undefined {
  return reportSessionCleanupFailures({
    sessionName,
    phase: 'session_close_cleanup_failed',
    failures,
    ...(options.sessionKept
      ? {
          hint: 'Some session resources failed to release. The session was kept; retry close with the same options, leaving out --save-script once the script is published, to rerun the failed cleanup and release the remaining resources.',
        }
      : {}),
  });
}
