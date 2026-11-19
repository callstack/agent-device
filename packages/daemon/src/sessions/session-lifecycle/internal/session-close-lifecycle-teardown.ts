import type { LeaseRegistry } from '../../../resources/lease-registry.ts';
import { inspectSessionLeaseRetainedOnClose } from '../../lease-lifecycle.ts';
import type { CloseApplicationFinalizationResult } from '@agent-device/contracts/application-lifecycle-runtime';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { renewDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { OrdinaryCloseScript } from './session-close-script.ts';
import type { SessionRef, SessionState } from '../../../core/session-state.ts';
import { SessionStore } from '../../../core/session-store.ts';
import {
  checkAndroidEmulatorProcess,
  confirmAndroidEmulatorProcessStopped,
  type AndroidEmulatorProcessCheck,
} from './session-close-emulator-process.ts';
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
   * #4585: the emulator process this session's `open` launched is not running any more, so whoever
   * answers that serial now is somebody else's device and the implicit stop is withheld. The close
   * itself succeeded.
   */
  implicitShutdownLaunchedProcessGone: boolean;
  /**
   * #4585: close could not establish whether its own launched emulator process still runs, so it
   * stops nothing. This covers the open that recorded no process identity and a host that would not
   * answer for the recorded pid.
   */
  implicitShutdownLaunchedProcessUnverified: boolean;
}>;

export type SessionCloseTeardownResult = Readonly<{
  platformCloseError: unknown;
  retainExecutionHost: boolean;
  saveScriptOutcome: OrdinaryCloseScript;
  shutdownResult?: TargetShutdownResult;
  shutdownPrepared: boolean;
}> &
  Omit<CloseDeviceStopDecision, 'shutdownRequested'>;

/**
 * #4162: plain close stops a local virtual device this session's own open booted. The boot fact
 * only ever comes from local selection, and the local-family check keeps it off provider paths,
 * which release through their lease instead. A policy that denies `device-shutdown` keeps this
 * close's own stop from ever being asked: the refusal is decided before the call, so the runner
 * retention a kept-running device earns is not spent on a stop that can never happen.
 *
 * #4585: on Android, the stop this session owes is owed to the emulator PROCESS its own open
 * launched, not to whatever answers that serial now, so the recorded process is checked once, right
 * before the stop is asked for. An explicit `--shutdown` commands the stop whatever the process
 * says, and a lost claim or a policy refusal has already decided it without reaching the host. Each
 * reason is reported as itself and in this order: what settled the stop first is the only reason
 * close can honestly give.
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
  const launchedProcess =
    implicitShutdown && !implicitShutdownDeniedByPolicy && claimRenewal?.status === 'renewed'
      ? await checkLaunchedAndroidEmulatorProcess(session)
      : 'not-applicable';
  const implicitShutdownLaunchedProcessGone = launchedProcess === 'changed';
  const implicitShutdownLaunchedProcessUnverified = launchedProcess === 'unverified';
  return {
    shutdownRequested:
      params.explicitShutdown ||
      (implicitShutdown &&
        !implicitShutdownDeniedByPolicy &&
        !implicitShutdownLaunchedProcessGone &&
        !implicitShutdownLaunchedProcessUnverified &&
        claimRenewal?.status === 'renewed'),
    implicitShutdownDeniedByPolicy,
    implicitShutdownClaimLost,
    implicitShutdownLaunchedProcessGone,
    implicitShutdownLaunchedProcessUnverified,
  };
}

/**
 * Whether the emulator process this session's open launched still runs the device it booted. Only
 * the Android emulator has a host process this daemon launched to check; every other device is
 * stopped by the platform answer alone, so this reports `not-applicable` rather than a miss.
 */
async function checkLaunchedAndroidEmulatorProcess(
  session: SessionState,
): Promise<AndroidEmulatorProcessCheck | 'not-applicable'> {
  if (session.device.platform !== 'android' || session.device.kind !== 'emulator')
    return 'not-applicable';
  const identity = session.androidLaunchIdentity;
  if (!identity) {
    emitAndroidLaunchIdentityMiss('open-recorded-no-process');
    return 'unverified';
  }
  const check = await checkAndroidEmulatorProcess(identity);
  if (check !== 'same')
    emitAndroidLaunchIdentityMiss(`process-check-${check}`, { pid: identity.pid });
  return check;
}

/**
 * Step 3 of the implicit Android stop: the platform asked the emulator to shut itself down through
 * `adb emu kill`, so confirm the process this session launched actually left. One that ignores the
 * kill is stopped by pid, and host-kit refuses a pid that no longer carries the recorded start time.
 */
async function confirmLaunchedAndroidEmulatorStopped(session: SessionState): Promise<void> {
  if (session.device.platform !== 'android' || session.device.kind !== 'emulator') return;
  const identity = session.androidLaunchIdentity;
  if (!identity) return;
  if ((await confirmAndroidEmulatorProcessStopped(identity)) === 'unconfirmed')
    emitAndroidLaunchIdentityMiss('launched-process-stop-unconfirmed', { pid: identity.pid });
}

/**
 * The one diagnostic for a session whose close could not settle the state of the emulator process
 * its own `open` launched. `step` names the step that decided it, which is the only thing that
 * separates the cases the caller reports with the same warning.
 */
function emitAndroidLaunchIdentityMiss(step: string, data: Record<string, unknown> = {}): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'android_launch_identity_miss',
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
  const finalization = await attemptCleanup(
    'application_lifecycle',
    async (): Promise<CloseApplicationFinalizationResult> =>
      (await lifecycle.operations.finalizeApplicationClose({
        appBundleId: session.appBundleId,
        surface: session.surface ?? 'app',
        retainRunner: retainExecutionHost,
        stateDir: sessionStore.resolveDaemonStateDir(),
        shutdownTarget: shutdownRequested && lifecycle.owner.kind === 'local-family',
      })) ?? {},
  );
  // The platform has asked the emulator it owns to shut down; this is where this session checks the
  // process it launched actually left, because `adb emu kill` answers for the guest, not for the
  // host process. An explicit `--shutdown` is the user's own command for the device and is not this
  // session's launched process to confirm.
  if (shutdownRequested && req.flags?.shutdown !== true)
    await confirmLaunchedAndroidEmulatorStopped(session);
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
