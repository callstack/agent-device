import type { ReplayCommandResult } from '@agent-device/contracts/replay';
import type { MaestroExecutionOutcome } from '@agent-device/maestro';
import { normalizeError } from '@agent-device/kernel/errors';
import { summarizeSnapshotTimingSamples } from '@agent-device/contracts/capture';
import type { DaemonResponse } from '../../types.ts';
import { buildTypedMaestroFailureResponse } from './session-replay-maestro-failure.ts';
import type { ReplayCommand, ReplaySessionStore } from './command-types.ts';

type TypedMaestroSuccessResponseParams = Readonly<{
  command: ReplayCommand;
  outcome: Extract<MaestroExecutionOutcome, { ok: true }>;
  startedAt: number;
  snapshotStart: number;
}>;

export function buildTypedMaestroSuccessResponse(
  params: TypedMaestroSuccessResponseParams,
): DaemonResponse {
  const { command, outcome, startedAt, snapshotStart } = params;
  const {
    session: { name: sessionName, store: sessionStore },
  } = command;
  const snapshotDiagnostics = readSnapshotDiagnostics(sessionStore, snapshotStart);
  const replayed = outcome.replayed;
  return {
    ok: true,
    data: {
      replayed,
      healed: 0,
      session: sessionName,
      sessionActive: sessionStore.get() !== undefined,
      artifactPaths: outcome.artifactPaths,
      ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
      ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
      message: replaySuccessMessage(replayed, Date.now() - startedAt),
    } satisfies ReplayCommandResult,
  };
}

type TypedMaestroErrorResponseParams = Readonly<{
  command: ReplayCommand;
  /** The entry flow's caller-resolved display path (the replay script source bundle's entry). */
  replayPath: string;
  state: {
    snapshotStart: number;
  };
  outcome: Extract<MaestroExecutionOutcome, { ok: false }>;
}>;

export async function buildTypedMaestroReplayErrorResponse(
  params: TypedMaestroErrorResponseParams,
): Promise<DaemonResponse> {
  const { command, replayPath, state, outcome } = params;
  const {
    request: req,
    session: { name: sessionName, store: sessionStore, observationStore, logPath },
  } = command;
  const { failure } = outcome;
  const normalizedError = normalizeError(outcome.error);
  if (failure) {
    return await buildTypedMaestroFailureResponse({
      error: normalizedError,
      failure,
      replayPath,
      req,
      sessionName,
      sessionStore,
      observationStore,
      logPath,
      snapshotDiagnostics: readSnapshotDiagnostics(sessionStore, state.snapshotStart),
    });
  }
  // The normalized error IS the wire error shape. Returning it whole keeps the
  // fields `normalizeError` projects out of `details` — `hint`, `diagnosticId`,
  // `logPath`, `retriable`, `supportedOn` — which re-spreading `details` drops.
  return { ok: false, error: normalizedError };
}

function readSnapshotDiagnostics(sessionStore: ReplaySessionStore, snapshotStart: number) {
  const samples = sessionStore.get()?.snapshotDiagnostics?.samples.slice(snapshotStart) ?? [];
  return summarizeSnapshotTimingSamples(samples);
}

function replaySuccessMessage(replayed: number, wallClockMs: number): string {
  const noun = replayed === 1 ? 'step' : 'steps';
  return `Replayed ${replayed} ${noun} in ${(wallClockMs / 1_000).toFixed(1)}s`;
}
