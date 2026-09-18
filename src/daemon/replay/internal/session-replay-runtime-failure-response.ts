import type { SessionAction } from '@agent-device/contracts/session';
import { scrubReplayVarValues, type ReplayVarScrubEntry } from '@agent-device/ad-replay/divergence';
import { formatDivergenceActionLabel } from '@agent-device/ad-script';
import type { SnapshotDiagnosticsSummary } from '@agent-device/contracts/capture';
import { buildDisplayPositionals } from '@agent-device/session-journal/session-event-action';
import { type DaemonResponse } from '@agent-device/kernel/contracts';

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
  scrubVars: readonly ReplayVarScrubEntry[];
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
  return buildReplayDivergenceFailureResponseFromDescriptor({
    error,
    actionLabel: formatDivergenceActionLabel(action),
    action: action.command,
    positionals: buildDisplayPositionals(action) ?? [],
    step,
    replayPath,
    artifactPaths,
    snapshotDiagnostics,
    divergence,
    scrubVars,
  });
}

export function buildReplayDivergenceFailureResponseFromDescriptor(params: {
  error: ReplayFailureCause;
  actionLabel: string;
  action: string;
  positionals: string[];
  step: number;
  replayPath: string;
  artifactPaths: string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  divergence: unknown;
  scrubVars: readonly ReplayVarScrubEntry[];
  /**
   * Composable warnings accumulated before the failing step (skipped `optional`
   * steps, capture degradations). They describe the run, not this step's cause,
   * so they ride at response-error level rather than through the cause allowlist.
   */
  warnings?: readonly string[];
}): DaemonResponse {
  const {
    error,
    actionLabel,
    action,
    positionals,
    step,
    replayPath,
    artifactPaths,
    snapshotDiagnostics,
    divergence,
    scrubVars,
    warnings,
  } = params;
  return {
    ok: false,
    error: {
      code: 'REPLAY_DIVERGENCE',
      message: scrubReplayVarValues(
        `Replay failed at step ${step} (${actionLabel}): ${error.message}`,
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
        action,
        positionals,
        artifactPaths,
        ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
        ...(warnings && warnings.length > 0
          ? { warnings: warnings.map((warning) => scrubReplayVarValues(warning, scrubVars)) }
          : {}),
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

const SAFE_CAUSE_DETAIL_KEYS = [
  'reason',
  'recovery',
  'retriable',
  'snapshotQuality',
  'supportedOn',
  'systemSurface',
] as const;

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
