import type { ReplayCommandResult } from '@agent-device/contracts/replay';
import type { MaestroExecutionOutcome } from '@agent-device/maestro';
import { normalizeError } from '@agent-device/kernel/errors';
import { summarizeSnapshotTimingSamples } from '@agent-device/contracts/capture';
import type { DaemonRequest, DaemonResponse } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import { buildTypedMaestroFailureResponse } from './session-replay-maestro-failure.ts';

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
  /** The entry flow's caller-resolved display path (the replay script source bundle's entry). */
  replayPath: string;
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
      replayPath: params.replayPath,
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
  // The normalized error IS the wire error shape. Returning it whole keeps the
  // fields `normalizeError` projects out of `details` — `hint`, `diagnosticId`,
  // `logPath`, `retriable`, `supportedOn` — which re-spreading `details` drops.
  return { ok: false, error: normalizedError };
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

function replaySuccessMessage(replayed: number, wallClockMs: number): string {
  const noun = replayed === 1 ? 'step' : 'steps';
  return `Replayed ${replayed} ${noun} in ${(wallClockMs / 1_000).toFixed(1)}s`;
}
