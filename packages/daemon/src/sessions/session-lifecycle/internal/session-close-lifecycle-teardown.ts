import type { LeaseRegistry } from '../../../resources/lease-registry.ts';
import { inspectSessionLeaseRetainedOnClose } from '../../lease-lifecycle.ts';
import type { CloseApplicationFinalizationResult } from '@agent-device/contracts/application-lifecycle-runtime';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
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
import { requiresRuntimeHintsClear, runtimeHintsClearInput } from '../../session-runtime.ts';
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
  saveScriptOutcome: OrdinaryCloseScript;
  shutdownResult?: TargetShutdownResult;
  shutdownPrepared: boolean;
}>;

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
  /** True when an enclosing `test` suite or outer session owns `session.lease`, so attempt close keeps it. */
  leaseRetainedBySuite?: boolean;
  dispatchTargetedPlatformClose: PlatformCloseDispatcher;
  finalizeOrdinaryCloseScript(input: {
    req: DaemonRequest;
    ref: SessionRef;
    sessionStore: SessionStore;
    platformCloseError: unknown;
  }): OrdinaryCloseScript;
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
  const retainExecutionHost = params.platformResourceCleanup.retainExecutionHostAfterClose({
    device: session.device,
    shutdownRequested: req.flags?.shutdown === true,
    hasScreenRecording: Boolean(session.screenRecording),
    leaseWillEnd:
      Boolean(session.lease) &&
      !params.leaseRetainedBySuite &&
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
  const runtimeHintsClear = runtimeHintsClearInput(configuredRuntimeHints, session.appBundleId);
  if (clearRuntimeHints && requiresRuntimeHintsClear(runtimeHintsClear)) {
    await attemptCleanup('runtime_hints', async () => {
      await clearRuntimeHints(runtimeHintsClear);
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
        shutdownTarget: req.flags?.shutdown === true && lifecycle.owner.kind === 'local-family',
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
