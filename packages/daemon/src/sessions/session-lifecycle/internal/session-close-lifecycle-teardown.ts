import type { LeaseRegistry } from '../../../resources/lease-registry.ts';
import { inspectSessionLeaseRetainedOnClose } from '../../lease-lifecycle.ts';
import type { CloseApplicationFinalizationResult } from '@agent-device/contracts/application-lifecycle-runtime';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import type { DeviceShutdownGenerationService } from '@agent-device/contracts/device-boot';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { renewDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
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
   * #4585: the close owned stopping the device its own `open` booted, but the device has been
   * through a boot this session never described since that open, so the running device is not the
   * one this session started and the implicit stop is withheld. The close itself succeeded.
   */
  implicitShutdownDeviceRebooted: boolean;
  implicitShutdownGenerationUnobserved: boolean;
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
 * #4585: a stop this session owes its own open is a stop owed to the boot that open caused, so the
 * the Android host generation is checked only once the stop is otherwise owed. An
 * explicit `--shutdown` commands the stop whatever the device says, and a lost claim or a policy
 * refusal has already decided it without reaching the device. Each reason is reported as itself and
 * in this order: what settled the stop first is the only reason close can honestly give.
 */
async function decideDeviceStopOnClose(params: {
  env: EnvMap;
  explicitShutdown: boolean;
  session: SessionState;
  localFamily: boolean;
  deviceShutdownDenied: boolean;
  observeDeviceBoot: DeviceShutdownGenerationService;
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
  const generation =
    implicitShutdown && !implicitShutdownDeniedByPolicy && claimRenewal?.status === 'renewed'
      ? await params.observeDeviceBoot
          .assessShutdownGeneration(session.device, session.androidLaunchIdentity)
          .catch(() => 'unobserved' as const)
      : 'not-applicable';
  const implicitShutdownDeviceRebooted = generation === 'changed';
  const implicitShutdownGenerationUnobserved = generation === 'unobserved';
  return {
    shutdownRequested:
      params.explicitShutdown ||
      (implicitShutdown &&
        !implicitShutdownDeniedByPolicy &&
        !implicitShutdownDeviceRebooted &&
        !implicitShutdownGenerationUnobserved &&
        claimRenewal?.status === 'renewed'),
    implicitShutdownDeniedByPolicy,
    implicitShutdownClaimLost,
    implicitShutdownDeviceRebooted,
    implicitShutdownGenerationUnobserved,
  };
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
  observeDeviceBoot: DeviceShutdownGenerationService;
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
    observeDeviceBoot: params.observeDeviceBoot,
  });
  const { shutdownRequested, ...stopReasons } = deviceStop;
  const expectedAndroidLaunchIdentity = session.androidLaunchIdentity;
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
        ...(shutdownRequested && req.flags?.shutdown !== true
          ? {
              verifyAndroidShutdown: async () => {
                const generation = await params.observeDeviceBoot
                  .assessShutdownGeneration(session.device, expectedAndroidLaunchIdentity)
                  .catch(() => 'unobserved' as const);
                return generation === 'same' || generation === 'changed'
                  ? generation
                  : ('unobserved' as const);
              },
            }
          : {}),
      })) ?? {},
  );
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
    implicitShutdownDeviceRebooted:
      stopReasons.implicitShutdownDeviceRebooted ||
      finalization?.androidShutdownRetained === 'changed',
    implicitShutdownGenerationUnobserved:
      stopReasons.implicitShutdownGenerationUnobserved ||
      finalization?.androidShutdownRetained === 'unobserved',
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
