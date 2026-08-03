import type { AdReplayScrubValue, ReplaySelectorPort } from '@agent-device/ad-replay';
import {
  summarizeSnapshotTimingSamples,
  type SnapshotDiagnosticsSummary,
  type SnapshotTimingSample,
} from '@agent-device/contracts/capture';
import type { SessionStore } from '../session-store.ts';
import type { ReplayResumeStamper } from '../session-replay-coordinator.ts';
import type { DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import { buildReplayFailureDivergence } from './session-replay-divergence.ts';
import {
  buildReplayDivergenceFailureResponse,
  hoistReplayFailureCauseDiagnosticMeta,
} from './session-replay-runtime-failure-response.ts';
import { getRequestSignal } from '../../request/cancel.ts';

export async function withReplayFailureDiagnostics(params: {
  response: DaemonResponse;
  action: SessionAction;
  index: number;
  replayPath: string;
  sourcePath: string;
  sourceLine: number;
  artifactPaths: string[];
  snapshotDiagnosticSamples: SnapshotTimingSample[];
  /** The engine's own live `${VAR}` scrub list, as of this point in the run — never recomputed here from a second scope object. */
  scrubVars: readonly AdReplayScrubValue[];
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  /** #1478 P4b: the request's bound resume-stamping capability — never a second-constructed coordinator. */
  resumeStamper: ReplayResumeStamper;
  logPath: string;
  planActions: SessionAction[];
  planDigest: string;
  port: ReplaySelectorPort;
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
  /** The engine's own live `${VAR}` scrub list, as of this point in the run — never recomputed here from a second scope object. */
  scrubVars: readonly AdReplayScrubValue[];
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  /** #1478 P4b: the request's bound resume-stamping capability — never a second-constructed coordinator. */
  resumeStamper: ReplayResumeStamper;
  logPath: string;
  planActions: SessionAction[];
  planDigest: string;
  port: ReplaySelectorPort;
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
    scrubVars,
    req,
    sessionName,
    sessionStore,
    resumeStamper,
    logPath,
    planActions,
    planDigest,
    port,
  } = params;
  if (response.ok) return response;
  const failureSource = readReplayFailureSource(response.error.details?.replaySource);
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
    resumeStamper,
    logPath,
    responseLevel: req.meta?.responseLevel,
    scrubVars,
    planActions,
    planDigest,
    signal: getRequestSignal(req.meta?.requestId),
    port,
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
