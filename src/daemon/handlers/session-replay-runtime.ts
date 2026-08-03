import { asAppError } from '@agent-device/kernel/errors';
import type { DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { errorResponse } from './response.ts';
import { createDaemonReplaySelectorPort } from '../replay-selector-port.ts';
import { runAdReplay } from '@agent-device/ad-replay';
import type { SnapshotTimingSample } from '@agent-device/contracts/capture';
import { summarizeSnapshotTimingSamples } from '@agent-device/contracts/capture';
import type { ReplayCommandResult } from '@agent-device/contracts/replay';
import { isMaestroYamlPath, maestroBackendRequiredMessage } from '../../replay/format.ts';
import { getRequestSignal } from '../../request/cancel.ts';
import { createReplayCoordinator, type ReplayCoordinator } from '../session-replay-coordinator.ts';
import {
  createAdReplayStepRuntime,
  type ReplayStepContext,
} from './session-replay-runtime-engine-adapter.ts';
import {
  prepareReplayPlan,
  routeMaestroReplay,
  type ReplayScriptFileParams,
} from './session-replay-runtime-plan.ts';
import { prepareReplaySession } from './session-replay-runtime-session.ts';

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
 * This file is what remains: the one place `runReplayScriptFile` composes them, and the run's
 * completion (`completeReplayRun`/`requireLiveSessionForKeepSession`), which runs after the engine
 * loop returns and never touches the step runtime itself.
 *
 * Coordinator ownership is unchanged by this split: `createReplayCoordinator` is still called
 * here, and only here — see `src/daemon/__tests__/replay-coordinator-ownership.test.ts` — every
 * extracted module receives the already-constructed `ReplayCoordinator` as a parameter instead of
 * constructing its own.
 */

export async function runReplayScriptFile(params: ReplayScriptFileParams): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, tracePath, onStep, invoke } = params;
  const filePath = req.positionals?.[0];
  if (!filePath) {
    return errorResponse('INVALID_ARGS', 'replay requires a path');
  }

  const startedAt = Date.now();
  const keepSession = req.flags?.replayKeepSession === true;
  let resolved = '';
  // The one accumulator `createAdReplayStepRuntime`'s adapter mutates as it
  // dispatches/builds each step's failure (via `collectReplayActionArtifactPaths`),
  // so a mid-loop exception still reports the artifacts collected up to that
  // point.
  const artifactPaths = new Set<string>();
  // #1478 P4b: the one locked coordinator this request reaches the repair
  // transaction and resume watermark through.
  const coordinator = createReplayCoordinator({ sessionStore, sessionName });
  // #1478 P5 stage C: the one selector-port instance this request threads
  // through the divergence-report chain (verification, classification,
  // suggestion building) — never a second-constructed adapter.
  const port = createDaemonReplaySelectorPort();
  try {
    resolved = SessionStore.expandHome(filePath, req.meta?.cwd);
    if (isMaestroYamlPath(resolved) && req.flags?.replayBackend !== 'maestro') {
      return errorResponse('INVALID_ARGS', maestroBackendRequiredMessage('replay', filePath));
    }
    const maestroResponse = await routeMaestroReplay({
      resolved,
      req,
      keepSession,
      coordinator,
      maestroParams: params,
    });
    if (maestroResponse) return maestroResponse;
    const planPreparation = prepareReplayPlan({
      req,
      sessionName,
      sessionStore,
      tracePath,
      resolved,
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
      sessionName,
      sourcePath: resolved,
      coordinator,
    });
    if (!sessionPreparation.ok) return sessionPreparation.response;
    const stepContext: ReplayStepContext = {
      replayReq,
      sessionName,
      sessionStore,
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
      port,
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
  } catch (err) {
    const appErr = asAppError(err);
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
  sessionStore: SessionStore;
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
  const completedSession = sessionStore.get(sessionName);
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
