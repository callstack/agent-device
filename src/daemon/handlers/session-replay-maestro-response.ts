import type { ReplayCommandResult } from '@agent-device/contracts/replay';
import type { MaestroExecutionOutcome } from '@agent-device/maestro';
import { normalizeError } from '@agent-device/kernel/errors';
import { summarizeSnapshotTimingSamples } from '@agent-device/contracts/capture';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { buildTypedMaestroFailureResponse } from './session-replay-maestro-failure.ts';
import { errorResponse } from './response.ts';

export function buildTypedMaestroSuccessResponse(params: {
  outcome: Extract<MaestroExecutionOutcome, { ok: true }>;
  startedAt: number;
  sessionName: string;
  sessionStore: SessionStore;
  snapshotStart: number;
}): DaemonResponse {
  const { outcome, startedAt, sessionName, sessionStore, snapshotStart } = params;
  const snapshotDiagnostics = readSnapshotDiagnostics(sessionStore, sessionName, snapshotStart);
  const replayed = outcome.replayed;
  return {
    ok: true,
    data: {
      replayed,
      healed: 0,
      session: sessionName,
      sessionActive: sessionStore.get(sessionName) !== undefined,
      artifactPaths: outcome.artifactPaths,
      ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
      ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
      message: replaySuccessMessage(replayed, Date.now() - startedAt),
    } satisfies ReplayCommandResult,
  };
}

export async function buildTypedMaestroReplayErrorResponse(params: {
  req: DaemonRequest;
  requestedPath: string;
  state: {
    snapshotStart: number;
  };
  outcome: Extract<MaestroExecutionOutcome, { ok: false }>;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
}): Promise<DaemonResponse> {
  const { failure } = params.outcome;
  const normalizedError = normalizeError(params.outcome.error);
  if (failure) {
    return await buildTypedMaestroFailureResponse({
      error: normalizedError,
      failure,
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
    ...buildErrorDetails(failure),
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
  failure: Extract<MaestroExecutionOutcome, { ok: false }>['failure'],
): Record<string, unknown> {
  if (!failure) return {};
  return {
    replaySource: failure.source,
    replayStep: failure.stepIndex,
    replayStepTotal: failure.stepTotal,
  };
}

function replaySuccessMessage(replayed: number, wallClockMs: number): string {
  const noun = replayed === 1 ? 'step' : 'steps';
  return `Replayed ${replayed} ${noun} in ${(wallClockMs / 1_000).toFixed(1)}s`;
}
