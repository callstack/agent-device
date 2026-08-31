import { asAppError } from '@agent-device/kernel/errors';
import type { DaemonResponse, SessionState } from '../../types.ts';
import { errorResponse } from '../../handlers/response.ts';
import { runAdReplay } from '@agent-device/ad-replay';
import type { SnapshotTimingSample } from '@agent-device/contracts/capture';
import { summarizeSnapshotTimingSamples } from '@agent-device/contracts/capture';
import type { ReplayCommandResult } from '@agent-device/contracts/replay';
import { isMaestroYamlPath, maestroBackendRequiredMessage } from '@agent-device/ad-script';
import { getRequestSignal } from '@agent-device/host-kit/request';
import {
  createReplayCoordinator,
  type ReplayCoordinator,
} from '../../session-replay-coordinator.ts';
import {
  createAdReplayStepRuntime,
  type ReplayStepContext,
} from './session-replay-runtime-engine-adapter.ts';
import { prepareReplayPlan, routeMaestroReplay } from './session-replay-runtime-plan.ts';
import {
  readReplayScriptSourceFile,
  REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE,
} from '../../replay-script-source.ts';
import { prepareReplaySession } from './session-replay-runtime-session.ts';
import type { ReplayCommand, ReplaySessionStore } from './command-types.ts';

/**
 * #1555 P5 (decomposition): the replay request's own orchestration — routing, plan resolution,
 * session preparation, the engine step loop, and run completion — kept thin by extracting the
 * three cohesive pieces it drives into their own modules:
 *  - the plan-side helpers (`validateReplayBackendFlag`, `inspectReplayPlanManifest`,
 *    `resolveReplayPlanEntryIndex`, `routeMaestroReplay`, and `prepareReplayPlan` itself) live in
 *    `session-replay-runtime-plan.ts`, alongside the digest/resume metadata helper that was
 *    already there.
 *  - session preparation (the R2 repair preflight, resume-state consumption, and save-script
 *    arming) lives in `session-replay-runtime-session.ts`.
 *  - the `AdReplayStepRuntime` engine adapter (`createAdReplayStepRuntime`, its `build*Failure`
 *    capability implementations, and the `lastResponse`/`lastObservation` side-map mechanics)
 *    lives in `session-replay-runtime-engine-adapter.ts`.
 * This file is what remains: the one place `runReplayCommand` composes them, and the run's
 * completion (`completeReplayRun`/`requireLiveSessionForKeepSession`), which runs after the engine
 * loop returns and never touches the step runtime itself.
 *
 * Coordinator ownership is unchanged by this split: `createReplayCoordinator` is still called
 * here, and only here — see `src/daemon/__tests__/replay-coordinator-ownership.test.ts` — every
 * extracted module receives the already-constructed `ReplayCoordinator` as a parameter instead of
 * constructing its own.
 */

/**
 * #1802: the run's script text arrives IN THE REQUEST (a replay script source
 * bundle the caller read and resolved), never as a path this process opens.
 * That is why this is `runReplayCommand` and no longer the old
 * `…ScriptFile`: a remote daemon shares no filesystem with the caller,
 * so a handler that opened `req.positionals[0]` could only ever work when the
 * two happened to be the same host.
 */
export async function runReplayCommand(command: ReplayCommand): Promise<DaemonResponse> {
  const {
    request: req,
    session: { name: sessionName, logPath, store: sessionStore, mutationStore, observationStore },
    tracePath,
    onStep,
    invoke,
  } = command;
  const bundle = req.flags?.replayScriptSource;
  if (!bundle) {
    return errorResponse('INVALID_ARGS', REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE);
  }

  const startedAt = Date.now();
  const keepSession = req.flags?.replayKeepSession === true;
  let resolved = '';
  // The run's ONE artifact ledger (#1478 P5 follow-up): `createAdReplayStepRuntime`'s
  // `dispatchStep` is its only writer and hands its contents back to the engine,
  // which threads them as a plain value rather than accumulating a second set of
  // its own. Read below by the catch block, so a mid-loop exception still reports
  // the artifacts collected up to that point.
  const artifactPaths = new Set<string>();
  // #1478 P4b: the one locked coordinator this request reaches the repair
  // transaction and resume watermark through.
  const coordinator = createReplayCoordinator({ sessionStore, mutationStore });
  try {
    resolved = bundle.entry;
    if (isMaestroYamlPath(resolved) && req.flags?.replayBackend !== 'maestro') {
      return errorResponse('INVALID_ARGS', maestroBackendRequiredMessage('replay', resolved));
    }
    const maestroResponse = await routeMaestroReplay({
      resolved,
      keepSession,
      coordinator,
      command,
    });
    if (maestroResponse) return maestroResponse;
    const planPreparation = prepareReplayPlan({
      req,
      sessionName,
      sessionStore,
      tracePath,
      resolved,
      script: readReplayScriptSourceFile(bundle, resolved),
      coordinator,
    });
    if (!planPreparation.ok) return planPreparation.response;
    const {
      replayReq,
      actions,
      actionLines,
      actionSourcePaths,
      planDigest,
      entryIndex,
      varSources,
      actionTracePath,
    } = planPreparation.value;
    const sessionPreparation = prepareReplaySession({
      req,
      entryIndex,
      sessionStore,
      sourcePath: resolved,
      coordinator,
    });
    if (!sessionPreparation.ok) return sessionPreparation.response;
    const stepContext: ReplayStepContext = {
      replayReq,
      sessionName,
      sessionStore,
      observationStore,
      logPath,
      resolved,
      actions,
      actionLines,
      actionSourcePaths,
      planDigest,
      actionTracePath,
      responseLevel: req.meta?.responseLevel,
      invoke,
      signal: getRequestSignal(req.meta?.requestId),
      coordinator,
    };
    const { runtime, readLastResponse } = createAdReplayStepRuntime({
      ctx: stepContext,
      req,
      artifactPaths,
      onStep,
      armSaveScript: sessionPreparation.armSaveScript,
    });
    const outcome = await runAdReplay(
      {
        actions,
        entryIndex,
        keepSession,
        actionLines,
        actionSourcePaths,
        resolvedPath: resolved,
        varSources,
      },
      runtime,
    );
    if (outcome.status === 'failed') {
      // #1555 P1 (neutral outcomes): `runAdReplay` never holds or returns a
      // `DaemonResponse` — it only reports WHICH step failed. The real wire
      // response was built (and wrapped with diagnostics/repair-hold marking)
      // by this adapter's own dispatch/build-failure capabilities, which
      // stashed it in `readLastResponse`'s closure as it went; reading it
      // back here is what makes the final response byte-identical to the
      // pre-split code that threaded it straight through the engine's return
      // value. The fallback below is unreachable in practice (a response is
      // always recorded before any failure can be reported) and exists only
      // so this stays total.
      return (
        readLastResponse() ??
        errorResponse('COMMAND_FAILED', 'replay step failed with no recorded response')
      );
    }
    return completeReplayRun({
      startedAt,
      sessionName,
      sessionStore,
      replayed: outcome.replayed,
      artifactPaths: outcome.artifactPaths,
      snapshotDiagnosticSamples: outcome.snapshotDiagnosticSamples,
      armSaveScript: sessionPreparation.armSaveScript,
      coordinator,
      keepSession,
    });
  } catch (error) {
    const appErr = asAppError(error);
    return errorResponse(
      appErr.code,
      appErr.message,
      artifactPaths.size > 0 ? { artifactPaths: [...artifactPaths] } : undefined,
    );
  }
}

function completeReplayRun(params: {
  startedAt: number;
  sessionName: string;
  sessionStore: ReplaySessionStore;
  replayed: number;
  artifactPaths: readonly string[];
  snapshotDiagnosticSamples: readonly SnapshotTimingSample[];
  armSaveScript: () => void;
  coordinator: ReplayCoordinator;
  keepSession: boolean;
}): DaemonResponse {
  const {
    startedAt,
    sessionName,
    sessionStore,
    replayed,
    artifactPaths,
    snapshotDiagnosticSamples,
    armSaveScript,
    coordinator,
    keepSession,
  } = params;
  armSaveScript();
  coordinator.markCompleteIfArmed();
  const completedSession = sessionStore.get();
  const keepSessionFailure = requireLiveSessionForKeepSession({
    keepSession,
    sessionName,
    completedSession,
    artifactPaths,
  });
  if (keepSessionFailure) return keepSessionFailure;
  const snapshotDiagnosticsSummary = summarizeSnapshotTimingSamples([...snapshotDiagnosticSamples]);
  return {
    ok: true,
    data: {
      replayed,
      healed: 0,
      session: sessionName,
      sessionActive: completedSession !== undefined,
      artifactPaths: [...artifactPaths],
      ...(snapshotDiagnosticsSummary ? { snapshotDiagnostics: snapshotDiagnosticsSummary } : {}),
      message: formatReplaySuccessMessage(replayed, Date.now() - startedAt),
    } satisfies ReplayCommandResult,
  };
}

/**
 * `--keep-session`'s postcondition (#1554): a suppressed terminal close only
 * ever promises a live session, so a session that is gone by completion
 * anyway (some other action closed or otherwise removed it) must fail loudly
 * rather than silently report `sessionActive: false` as if `--keep-session`
 * had never been requested. Stays daemon-side, unlike the terminal-close
 * suppression itself (`resolveSuppressedTerminalCloseIndex`,
 * `@agent-device/ad-replay`'s step loop): it inspects `SessionState`, which
 * the engine never sees.
 */
/**
 * #1555 review P1 (second pass, "keep success formatting daemon-side"):
 * moved verbatim from `@agent-device/ad-replay`'s `step-loop.ts` — pure
 * presentation of the run's own `replayed` count/wall-clock duration, not
 * engine policy, so it sits beside its one caller (`completeReplayRun`
 * above) instead of behind the façade.
 */
function formatReplaySuccessMessage(replayed: number, wallClockMs: number): string {
  const seconds = (wallClockMs / 1000).toFixed(1);
  const noun = replayed === 1 ? 'step' : 'steps';
  return `Replayed ${replayed} ${noun} in ${seconds}s`;
}

function requireLiveSessionForKeepSession(params: {
  keepSession: boolean;
  sessionName: string;
  completedSession: SessionState | undefined;
  artifactPaths: readonly string[];
}): DaemonResponse | undefined {
  const { keepSession, sessionName, completedSession, artifactPaths } = params;
  if (!keepSession || completedSession) return undefined;
  return errorResponse(
    'COMMAND_FAILED',
    `Replay completed but --keep-session could not preserve session "${sessionName}". Run the script again after checking which action closed the session.`,
    artifactPaths.length > 0 ? { artifactPaths: [...artifactPaths] } : undefined,
  );
}
