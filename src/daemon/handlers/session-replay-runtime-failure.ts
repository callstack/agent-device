import { formatDivergenceActionLabel } from '../../replay/script-utils.ts';
import { scrubReplayVarValues, type ReplayVarScrubEntry } from '../../replay/divergence.ts';
import { collectReplayScrubbableVarValues, type ReplayVarScope } from '../../replay/vars.ts';
import {
  summarizeSnapshotTimingSamples,
  type SnapshotDiagnosticsSummary,
  type SnapshotTimingSample,
} from '../../snapshot-diagnostics.ts';
import { buildDisplayPositionals } from '../session-event-action.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import { buildReplayFailureDivergence } from './session-replay-divergence.ts';

export async function withReplayFailureDiagnostics(params: {
  response: DaemonResponse;
  action: SessionAction;
  index: number;
  replayPath: string;
  sourcePath: string;
  sourceLine: number;
  artifactPaths: string[];
  snapshotDiagnosticSamples: SnapshotTimingSample[];
  scope: ReplayVarScope;
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  planActions: SessionAction[];
  planDigest: string;
}): Promise<DaemonResponse> {
  return await withReplayFailureContext({
    ...params,
    snapshotDiagnostics: summarizeSnapshotTimingSamples(params.snapshotDiagnosticSamples),
  });
}

async function withReplayFailureContext(params: {
  response: DaemonResponse;
  action: SessionAction;
  index: number;
  replayPath: string;
  sourcePath: string;
  sourceLine: number;
  artifactPaths?: string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  scope: ReplayVarScope;
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  planActions: SessionAction[];
  planDigest: string;
}): Promise<DaemonResponse> {
  const {
    response,
    action,
    index,
    replayPath,
    sourcePath,
    sourceLine,
    artifactPaths = [],
    snapshotDiagnostics,
    scope,
    req,
    sessionName,
    sessionStore,
    logPath,
    planActions,
    planDigest,
  } = params;
  if (response.ok) return response;
  const failureSource = readReplayFailureSource(response.error.details?.replaySource);
  const scrubVars = collectReplayScrubbableVarValues(scope);
  const cause = hoistCauseDiagnosticMeta(response.error);
  const divergence = await buildReplayFailureDivergence({
    error: cause,
    action,
    index,
    sourcePath: failureSource?.path ?? sourcePath,
    sourceLine: failureSource?.line ?? sourceLine,
    session: sessionStore.get(sessionName),
    sessionName,
    sessionStore,
    logPath,
    responseLevel: req.meta?.responseLevel,
    scrubVars,
    planActions,
    planDigest,
  });
  return buildReplayDivergenceFailureResponse({
    error: cause,
    action,
    step: index + 1,
    replayPath,
    artifactPaths,
    snapshotDiagnostics,
    divergence,
    scrubVars,
  });
}

type ReplayFailureCause = Extract<DaemonResponse, { ok: false }>['error'];

function hoistCauseDiagnosticMeta(error: ReplayFailureCause): ReplayFailureCause {
  return {
    ...error,
    hint: error.hint ?? readStringDetail(error.details, 'hint'),
    diagnosticId: error.diagnosticId ?? readStringDetail(error.details, 'diagnosticId'),
    logPath: error.logPath ?? readStringDetail(error.details, 'logPath'),
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

function buildReplayDivergenceFailureResponse(params: {
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

function readReplayFailureSource(value: unknown): { path?: string; line?: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const path = typeof record.path === 'string' && record.path.length > 0 ? record.path : undefined;
  const line = typeof record.line === 'number' ? record.line : undefined;
  if (path === undefined && line === undefined) return undefined;
  return { path, line };
}
