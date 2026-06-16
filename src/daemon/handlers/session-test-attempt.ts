import path from 'node:path';
import { emitRequestProgress } from '../request-progress.ts';
import type { DaemonResponse, ReplaySuiteTestFailed, ReplaySuiteTestResult } from '../types.ts';
import {
  buildReplayTestArtifactSlug,
  materializeReplayTestAttemptArtifacts,
  prepareReplayTestAttemptArtifacts,
} from './session-test-artifacts.ts';
import {
  buildReplayTestAttemptRequestId,
  buildReplayTestSessionName,
  type ReplayTestRunEntry,
} from './session-test-discovery.ts';
import { isReplayInfrastructureFailure } from './session-test-infrastructure.ts';
import { runReplayTestAttempt } from './session-test-runtime.ts';
import type { ReplayTestRuntimeDependencies } from './session-test-types.ts';
import type { ReplayTestShardContext } from './session-test-sharding.ts';
import { isRequestCanceled } from '../request-cancel.ts';
import { readSnapshotDiagnosticsSummary } from '../../snapshot-diagnostics.ts';

type ReplayTestCaseResult = Extract<ReplaySuiteTestResult, { status: 'passed' | 'failed' }>;
type ReplayTestAttemptFailure = NonNullable<
  Extract<ReplaySuiteTestResult, { status: 'passed' }>['attemptFailures']
>[number];

export async function runReplayTestCase(
  params: ReplayTestCaseParams,
): Promise<ReplayTestCaseResult> {
  const context = buildReplayTestCaseContext(params);
  const outcome = await runReplayTestCaseAttempts(params, context);
  return buildReplayTestCaseResult(params, context, outcome);
}

type ReplayTestCaseParams = {
  entry: ReplayTestRunEntry;
  sessionName: string;
  suiteInvocationId: string;
  caseIndex: number;
  cwd?: string;
  requestId?: string;
  retries: number;
  timeoutMs?: number;
  suiteArtifactsDir: string;
  suiteIndex: number;
  suiteTotal: number;
  shard?: ReplayTestShardContext;
} & ReplayTestRuntimeDependencies;

type ReplayTestCaseContext = {
  testStartedAt: number;
  testArtifactsDir: string;
  maxAttempts: number;
};

type ReplayTestAttemptResult = {
  response: DaemonResponse;
  sessionName: string;
  attempt: number;
  durationMs: number;
};

type ReplayTestCaseOutcome = {
  finalResponse?: DaemonResponse;
  finalSessionName: string;
  attempts: number;
  finalAttemptDurationMs: number;
  attemptFailures: ReplayTestAttemptFailure[];
};

function buildReplayTestCaseContext(params: ReplayTestCaseParams): ReplayTestCaseContext {
  const { entry, cwd, retries, suiteArtifactsDir, shard } = params;
  return {
    testStartedAt: Date.now(),
    testArtifactsDir: path.join(
      suiteArtifactsDir,
      ...(shard ? [`shard-${shard.shardIndex + 1}`] : []),
      buildReplayTestArtifactSlug(entry.path, cwd),
    ),
    maxAttempts: retries + 1,
  };
}

async function runReplayTestCaseAttempts(
  params: ReplayTestCaseParams,
  context: ReplayTestCaseContext,
): Promise<ReplayTestCaseOutcome> {
  emitReplayTestStartProgress(params, context);
  const outcome: ReplayTestCaseOutcome = {
    finalSessionName: '',
    attempts: 0,
    finalAttemptDurationMs: 0,
    attemptFailures: [],
  };

  for (let attemptIndex = 0; attemptIndex <= params.retries; attemptIndex += 1) {
    if (isRequestCanceled(params.requestId)) break;
    const attempt = await runSingleReplayTestAttempt(params, context, attemptIndex);
    updateReplayTestCaseOutcome(outcome, attempt);
    if (shouldStopReplayTestAttempts(params, attempt.response, attemptIndex)) break;
    emitReplayTestRetryProgress(params, context, attempt);
  }

  return outcome;
}

async function runSingleReplayTestAttempt(
  params: ReplayTestCaseParams,
  context: ReplayTestCaseContext,
  attemptIndex: number,
): Promise<ReplayTestAttemptResult> {
  const {
    entry,
    sessionName,
    suiteInvocationId,
    caseIndex,
    suiteIndex,
    suiteTotal,
    requestId,
    timeoutMs,
    shard,
  } = params;
  const attempt = attemptIndex + 1;
  const startedAt = Date.now();
  const testSessionName = buildReplayTestSessionName(
    sessionName,
    suiteInvocationId,
    entry.path,
    caseIndex,
    attemptIndex,
  );
  const attemptArtifactsDir = path.join(context.testArtifactsDir, `attempt-${attempt}`);
  prepareReplayTestAttemptArtifacts(entry.path, attemptArtifactsDir);
  const attemptRequestId = buildReplayTestAttemptRequestId({
    requestId,
    suiteInvocationId,
    filePath: entry.path,
    caseIndex,
    attemptIndex,
    shardIndex: shard?.shardIndex,
  });

  const response = await runReplayTestAttempt({
    filePath: entry.path,
    sessionName: testSessionName,
    requestId: attemptRequestId,
    parentRequestId: requestId,
    timeoutMs,
    platform: entry.metadata.platform,
    target: entry.metadata.target,
    artifactsDir: attemptArtifactsDir,
    shard,
    progress: {
      file: entry.path,
      title: entry.title,
      index: suiteIndex,
      total: suiteTotal,
      attempt,
      maxAttempts: context.maxAttempts,
      session: testSessionName,
      artifactsDir: context.testArtifactsDir,
      ...replayTestProgressShardMetadata(shard),
    },
    runReplay: params.runReplay,
    cleanupSession: params.cleanupSession,
    finalizeAttempt: params.finalizeAttempt,
  });
  const durationMs = Date.now() - startedAt;
  materializeReplayTestAttemptArtifacts({
    response,
    filePath: entry.path,
    sessionName: testSessionName,
    attempts: attempt,
    maxAttempts: context.maxAttempts,
    attemptArtifactsDir,
  });
  return { response, sessionName: testSessionName, attempt, durationMs };
}

function emitReplayTestStartProgress(
  params: ReplayTestCaseParams,
  context: ReplayTestCaseContext,
): void {
  const { entry, sessionName, suiteInvocationId, caseIndex, suiteIndex, suiteTotal, shard } =
    params;
  emitRequestProgress({
    type: 'replay-test',
    file: entry.path,
    title: entry.title,
    status: 'start',
    index: suiteIndex,
    total: suiteTotal,
    maxAttempts: context.maxAttempts,
    session: buildReplayTestSessionName(sessionName, suiteInvocationId, entry.path, caseIndex),
    artifactsDir: context.testArtifactsDir,
    ...replayTestProgressShardMetadata(shard),
  });
}

function updateReplayTestCaseOutcome(
  outcome: ReplayTestCaseOutcome,
  attempt: ReplayTestAttemptResult,
): void {
  outcome.finalResponse = attempt.response;
  outcome.finalSessionName = attempt.sessionName;
  outcome.attempts = attempt.attempt;
  outcome.finalAttemptDurationMs = attempt.durationMs;
  if (attempt.response.ok) return;
  outcome.attemptFailures.push({
    attempt: attempt.attempt,
    message: attempt.response.error.message,
    durationMs: attempt.durationMs,
  });
}

function shouldStopReplayTestAttempts(
  params: ReplayTestCaseParams,
  response: DaemonResponse,
  attemptIndex: number,
): boolean {
  return (
    response.ok ||
    isRequestCanceled(params.requestId) ||
    isReplayInfrastructureFailure(response) ||
    attemptIndex >= params.retries
  );
}

function emitReplayTestRetryProgress(
  params: ReplayTestCaseParams,
  context: ReplayTestCaseContext,
  attempt: ReplayTestAttemptResult,
): void {
  if (attempt.response.ok) return;
  emitRequestProgress({
    type: 'replay-test',
    file: params.entry.path,
    title: params.entry.title,
    status: 'fail',
    index: params.suiteIndex,
    total: params.suiteTotal,
    attempt: attempt.attempt,
    maxAttempts: context.maxAttempts,
    durationMs: attempt.durationMs,
    retrying: true,
    message: attempt.response.error.message,
    session: attempt.sessionName,
    artifactsDir: context.testArtifactsDir,
    ...replayTestProgressShardMetadata(params.shard),
  });
}

function buildReplayTestCaseResult(
  params: ReplayTestCaseParams,
  context: ReplayTestCaseContext,
  outcome: ReplayTestCaseOutcome,
): ReplayTestCaseResult {
  const durationMs = Date.now() - context.testStartedAt;
  if (outcome.finalResponse?.ok) {
    return buildReplayTestPassedResult(params, context, outcome, durationMs);
  }
  return buildReplayTestFailedResult(params, context, outcome, durationMs);
}

function buildReplayTestPassedResult(
  params: ReplayTestCaseParams,
  context: ReplayTestCaseContext,
  outcome: ReplayTestCaseOutcome,
  durationMs: number,
): Extract<ReplaySuiteTestResult, { status: 'passed' }> {
  const { entry, suiteIndex, suiteTotal, shard } = params;
  const response = outcome.finalResponse;
  if (!response?.ok) throw new Error('Expected passing replay test response.');
  emitRequestProgress({
    type: 'replay-test',
    file: entry.path,
    title: entry.title,
    status: 'pass',
    index: suiteIndex,
    total: suiteTotal,
    attempt: outcome.attempts,
    maxAttempts: context.maxAttempts,
    durationMs,
    session: outcome.finalSessionName,
    artifactsDir: context.testArtifactsDir,
    ...replayTestProgressShardMetadata(shard),
  });
  return {
    file: entry.path,
    title: entry.title,
    session: outcome.finalSessionName,
    status: 'passed',
    durationMs,
    finalAttemptDurationMs: outcome.finalAttemptDurationMs,
    attempts: outcome.attempts,
    artifactsDir: context.testArtifactsDir,
    ...replayTestResponseMetrics(response),
    ...replayTestWarningsResultMetadata(response.data?.warnings),
    ...replayTestSnapshotDiagnosticsResultMetadata(response.data?.snapshotDiagnostics),
    ...replayTestShardResultMetadata(shard),
    ...(outcome.attemptFailures.length > 0 ? { attemptFailures: outcome.attemptFailures } : {}),
  };
}

function buildReplayTestFailedResult(
  params: ReplayTestCaseParams,
  context: ReplayTestCaseContext,
  outcome: ReplayTestCaseOutcome,
  durationMs: number,
): Extract<ReplaySuiteTestResult, { status: 'failed' }> {
  const { entry, suiteIndex, suiteTotal, shard } = params;
  const error = replayTestFailureError(outcome.finalResponse);
  emitRequestProgress({
    type: 'replay-test',
    file: entry.path,
    title: entry.title,
    status: 'fail',
    index: suiteIndex,
    total: suiteTotal,
    attempt: outcome.attempts,
    maxAttempts: context.maxAttempts,
    durationMs,
    session: outcome.finalSessionName,
    artifactsDir: context.testArtifactsDir,
    message: error.message,
    ...replayTestProgressShardMetadata(shard),
  });
  return {
    file: entry.path,
    title: entry.title,
    session: outcome.finalSessionName,
    status: 'failed',
    durationMs,
    attempts: outcome.attempts,
    artifactsDir: context.testArtifactsDir,
    error,
    ...replayTestSnapshotDiagnosticsResultMetadata(
      readReplayResponseSnapshotDiagnostics(outcome.finalResponse),
    ),
    ...replayTestShardResultMetadata(shard),
  };
}

function replayTestFailureError(
  response: DaemonResponse | undefined,
): Extract<ReplaySuiteTestResult, { status: 'failed' }>['error'] {
  if (response && !response.ok) return response.error;
  return { code: 'COMMAND_FAILED', message: 'Unknown replay test failure' };
}

function replayTestResponseMetrics(
  response: Extract<DaemonResponse, { ok: true }>,
): Pick<Extract<ReplaySuiteTestResult, { status: 'passed' }>, 'replayed' | 'healed'> {
  return {
    replayed: typeof response.data?.replayed === 'number' ? response.data.replayed : 0,
    healed: typeof response.data?.healed === 'number' ? response.data.healed : 0,
  };
}

function replayTestWarningsResultMetadata(
  warnings: unknown,
): Pick<Extract<ReplaySuiteTestResult, { status: 'passed' }>, 'warnings'> {
  if (!Array.isArray(warnings)) return {};
  const filtered = warnings.filter((entry): entry is string => typeof entry === 'string');
  return filtered.length > 0 ? { warnings: filtered } : {};
}

function replayTestSnapshotDiagnosticsResultMetadata(
  value: unknown,
): Pick<ReplayTestCaseResult, 'snapshotDiagnostics'> {
  const snapshotDiagnostics = readSnapshotDiagnosticsSummary(value);
  return snapshotDiagnostics ? { snapshotDiagnostics } : {};
}

function readReplayResponseSnapshotDiagnostics(response: DaemonResponse | undefined): unknown {
  return response?.ok
    ? response.data?.snapshotDiagnostics
    : response?.error.details?.snapshotDiagnostics;
}

function replayTestShardResultMetadata(
  shard: ReplayTestShardContext | undefined,
): Pick<ReplaySuiteTestFailed, 'shardIndex' | 'shardCount' | 'deviceId'> {
  return replayTestProgressShardMetadata(shard);
}

function replayTestProgressShardMetadata(
  shard: ReplayTestShardContext | undefined,
): Pick<ReplaySuiteTestFailed, 'shardIndex' | 'shardCount' | 'deviceId'> {
  return shard
    ? {
        shardIndex: shard.shardIndex,
        shardCount: shard.shardCount,
        deviceId: shard.device.id,
      }
    : {};
}
