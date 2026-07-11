import { scrubReplayVarValues, type ReplayVarScrubEntry } from '../../replay/divergence.ts';
import { formatDivergenceActionLabel } from '../../replay/script-utils.ts';
import type { SnapshotDiagnosticsSummary } from '../../snapshot-diagnostics.ts';
import { buildDisplayPositionals } from '../session-event-action.ts';
import type { DaemonResponse, SessionAction } from '../types.ts';

export type ReplayFailureCause = Extract<DaemonResponse, { ok: false }>['error'];

export function hoistReplayFailureCauseDiagnosticMeta(
  error: ReplayFailureCause,
): ReplayFailureCause {
  return {
    ...error,
    hint: error.hint ?? readStringDetail(error.details, 'hint'),
    diagnosticId: error.diagnosticId ?? readStringDetail(error.details, 'diagnosticId'),
    logPath: error.logPath ?? readStringDetail(error.details, 'logPath'),
  };
}

export function buildReplayDivergenceFailureResponse(params: {
  error: ReplayFailureCause;
  action: SessionAction;
  step: number;
  replayPath: string;
  artifactPaths: string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  divergence: unknown;
  scrubVars: ReplayVarScrubEntry[];
}): DaemonResponse {
  const {
    error,
    action,
    step,
    replayPath,
    artifactPaths,
    snapshotDiagnostics,
    divergence,
    scrubVars,
  } = params;
  return {
    ok: false,
    error: {
      code: 'REPLAY_DIVERGENCE',
      message: scrubReplayVarValues(
        `Replay failed at step ${step} (${formatDivergenceActionLabel(action)}): ${error.message}`,
        scrubVars,
      ),
      hint: error.hint === undefined ? undefined : scrubReplayVarValues(error.hint, scrubVars),
      diagnosticId: error.diagnosticId,
      logPath: error.logPath,
      ...(error.retriable !== undefined ? { retriable: error.retriable } : {}),
      ...(error.supportedOn !== undefined ? { supportedOn: error.supportedOn } : {}),
      details: {
        ...pickSafeCauseDetails(error.details),
        replayPath,
        step,
        action: action.command,
        positionals: buildDisplayPositionals(action) ?? [],
        artifactPaths,
        ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
        divergence,
      },
    },
  };
}

function readStringDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const SAFE_CAUSE_DETAIL_KEYS = ['reason', 'retriable', 'supportedOn'] as const;

function pickSafeCauseDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!details) return {};
  const safe: Record<string, unknown> = {};
  for (const key of SAFE_CAUSE_DETAIL_KEYS) {
    if (details[key] !== undefined) safe[key] = details[key];
  }
  return safe;
}
