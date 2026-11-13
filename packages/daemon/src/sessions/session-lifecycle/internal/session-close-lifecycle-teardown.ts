import type { LeaseRegistry } from '../../../resources/lease-registry.ts';
import { inspectSessionLeaseRetainedOnClose } from '../../lease-lifecycle.ts';
import type { CloseApplicationFinalizationResult } from '@agent-device/contracts/application-lifecycle-runtime';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
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

export type SessionCloseTeardownResult = Readonly<{
  platformCloseError: unknown;
  retainExecutionHost: boolean;
  saveScriptError?: Error;
  shutdownResult?: TargetShutdownResult;
  shutdownPrepared: boolean;
  /**
   * #4162: the close owned stopping the device its own `open` booted, and this daemon's policy
   * denies `device-shutdown`, so the device stays running. The close itself succeeded.
   */
  implicitShutdownDeniedByPolicy: boolean;
}>;

/** Whether a failure is the operator's policy refusing the shutdown capability (ADR 0029). */
function isDaemonPolicyShutdownRefusal(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.details?.reason === 'DAEMON_POLICY_DENIED' &&
    error.details.rule === 'capability'
  );
}

/** Runs owned resources, native close, native hint cleanup, and final lifecycle disposal. */
export async function runSessionCloseTeardown(params: {
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
  }): Error | undefined;
  platformResourceCleanup: PlatformResourceCleanup;
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
  // #4162: plain close stops a local virtual device this session's own open booted. The boot fact
  // only ever comes from local selection, and the local-family check keeps it off provider paths,
  // which release through their lease instead.
  const explicitShutdown = req.flags?.shutdown === true;
  const implicitShutdown =
    !explicitShutdown && session.bootedByOpen === true && lifecycle.owner.kind === 'local-family';
  const shutdownRequested = explicitShutdown || implicitShutdown;
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
  let implicitShutdownDeniedByPolicy = false;
  const finalization = await attemptCleanup(
    'application_lifecycle',
    async (): Promise<CloseApplicationFinalizationResult> => {
      try {
        return (await lifecycle.operations.finalizeApplicationClose({
          appBundleId: session.appBundleId,
          surface: session.surface ?? 'app',
          retainRunner: retainExecutionHost,
          stateDir: sessionStore.resolveDaemonStateDir(),
          shutdownTarget: shutdownRequested && lifecycle.owner.kind === 'local-family',
        })) ?? {};
      } catch (error) {
        // #4162: an implicit stop is this close's own convenience, not something the caller asked
        // for. The capability gate may still refuse it (ADR 0029), and that refusal must not fail
        // the close: report the kept device instead. An explicit `--shutdown` keeps failing.
        if (!implicitShutdown || !isDaemonPolicyShutdownRefusal(error)) throw error;
        implicitShutdownDeniedByPolicy = true;
        return {};
      }
    },
  );
  const saveScriptError = repairArmed
    ? undefined
    : finalizeOrdinaryCloseScript({ req, ref, sessionStore, platformCloseError });
  await attemptCleanup('materialized_paths', () =>
    cleanupRetainedMaterializedPathsForSession(sessionName),
  );
  return {
    platformCloseError,
    retainExecutionHost,
    saveScriptError,
    shutdownResult: finalization?.shutdown,
    shutdownPrepared: finalization !== undefined,
    implicitShutdownDeniedByPolicy,
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
