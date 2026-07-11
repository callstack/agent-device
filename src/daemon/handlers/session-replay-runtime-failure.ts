import { collectReplayScrubbableVarValues, type ReplayVarScope } from '../../replay/vars.ts';
import {
  summarizeSnapshotTimingSamples,
  type SnapshotDiagnosticsSummary,
  type SnapshotTimingSample,
} from '../../snapshot-diagnostics.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import { buildReplayFailureDivergence } from './session-replay-divergence.ts';
import {
  buildReplayDivergenceFailureResponse,
  hoistReplayFailureCauseDiagnosticMeta,
} from './session-replay-runtime-failure-response.ts';

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
  const cause = hoistReplayFailureCauseDiagnosticMeta(response.error);
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

function readReplayFailureSource(value: unknown): { path?: string; line?: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const path = typeof record.path === 'string' && record.path.length > 0 ? record.path : undefined;
  const line = typeof record.line === 'number' ? record.line : undefined;
  if (path === undefined && line === undefined) return undefined;
  return { path, line };
}
