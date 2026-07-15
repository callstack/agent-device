import type { ReplayCommandResult } from '../../contracts/replay.ts';
import type { MaestroReplayPlan } from '../../compat/maestro/replay-plan-types.ts';
import { normalizeError } from '../../kernel/errors.ts';
import { summarizeSnapshotTimingSamples } from '../../snapshot-diagnostics.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import {
  buildTypedMaestroFailureResponse,
  type MaestroFailedEngineEvent,
} from './session-replay-maestro-failure.ts';
import { errorResponse } from './response.ts';

export function buildTypedMaestroSuccessResponse(params: {
  result: { artifactPaths: string[]; warnings?: string[] };
  plan: MaestroReplayPlan;
  startIndex: number;
  startedAt: number;
  sessionName: string;
  sessionStore: SessionStore;
  snapshotStart: number;
}): DaemonResponse {
  const { result, plan, startIndex, startedAt, sessionName, sessionStore, snapshotStart } = params;
  const snapshotDiagnostics = readSnapshotDiagnostics(sessionStore, sessionName, snapshotStart);
  const replayed = plan.total - startIndex;
  return {
    ok: true,
    data: {
      replayed,
      healed: 0,
      session: sessionName,
      artifactPaths: result.artifactPaths,
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
      message: replaySuccessMessage(replayed, Date.now() - startedAt),
    } satisfies ReplayCommandResult,
  };
}

export async function buildTypedMaestroReplayErrorResponse(params: {
  req: DaemonRequest;
  requestedPath: string;
  state: {
    failedEvent?: MaestroFailedEngineEvent;
    plan?: MaestroReplayPlan;
    snapshotStart: number;
  };
  error: unknown;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
}): Promise<DaemonResponse> {
  const { failedEvent, plan } = params.state;
  const normalizedError = normalizeError(failedEvent?.error ?? params.error);
  if (failedEvent && plan) {
    return await buildTypedMaestroFailureResponse({
      error: normalizedError,
      event: failedEvent,
      plan,
      replayPath: SessionStore.expandHome(params.requestedPath, params.req.meta?.cwd),
      req: params.req,
      sessionName: params.sessionName,
      sessionStore: params.sessionStore,
      logPath: params.logPath,
      snapshotDiagnostics: readSnapshotDiagnostics(
        params.sessionStore,
        params.sessionName,
        params.state.snapshotStart,
      ),
    });
  }
  return errorResponse(normalizedError.code, normalizedError.message, {
    ...(normalizedError.details ?? {}),
    ...buildErrorDetails(failedEvent),
  });
}

function readSnapshotDiagnostics(
  sessionStore: SessionStore,
  sessionName: string,
  snapshotStart: number,
) {
  const samples =
    sessionStore.get(sessionName)?.snapshotDiagnostics?.samples.slice(snapshotStart) ?? [];
  return summarizeSnapshotTimingSamples(samples);
}

function buildErrorDetails(
  failedEvent: MaestroFailedEngineEvent | undefined,
): Record<string, unknown> {
  if (!failedEvent) return {};
  return {
    replaySource: failedEvent.source,
    replayStep: failedEvent.stepIndex,
    replayStepTotal: failedEvent.stepTotal,
  };
}

function replaySuccessMessage(replayed: number, wallClockMs: number): string {
  const noun = replayed === 1 ? 'step' : 'steps';
  return `Replayed ${replayed} ${noun} in ${(wallClockMs / 1_000).toFixed(1)}s`;
}
