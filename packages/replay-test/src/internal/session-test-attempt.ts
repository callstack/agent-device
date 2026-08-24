import path from 'node:path';
import type { ReplaySuiteTestFailed, ReplaySuiteTestResult } from '@agent-device/contracts/replay';
import type { ReplayTestProgressEvent } from '@agent-device/contracts/progress';
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
import { runReplayTestAttempt } from './session-test-runtime.ts';
import type {
  ReplayTestAttemptOutcome,
  ReplayTestExecutionDependencies,
} from './session-test-types.ts';
import type { ReplayTestShardContext } from './session-test-sharding.ts';

type ReplayTestCaseResult = Extract<ReplaySuiteTestResult, { status: 'passed' | 'failed' }>;
type ReplayTestAttemptFailure = NonNullable<
  Extract<ReplaySuiteTestResult, { status: 'passed' }>['attemptFailures']
>[number];

/**
 * A finished test case plus the one scheduling fact the public result cannot carry: whether the
 * final attempt failed for environmental reasons, which stops the suite instead of continuing.
 */
export type ReplayTestCaseReport = {
  result: ReplayTestCaseResult;
  infrastructure: boolean;
};

export async function runReplayTestCase(
  params: ReplayTestCaseParams,
): Promise<ReplayTestCaseReport> {
  const context = buildReplayTestCaseContext(params);
  const outcome = await runReplayTestCaseAttempts(params, context);
  return {
    result: buildReplayTestCaseResult(params, context, outcome),
    infrastructure:
      outcome.finalOutcome?.status === 'failed' && outcome.finalOutcome.infrastructure,
  };
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
} & ReplayTestExecutionDependencies;

type ReplayTestCaseContext = {
  testStartedAt: number;
  testArtifactsDir: string;
  maxAttempts: number;
};

type ReplayTestAttemptResult = {
  outcome: ReplayTestAttemptOutcome;
  sessionName: string;
  attempt: number;
  durationMs: number;
};

type ReplayTestCaseOutcome = {
  finalOutcome?: ReplayTestAttemptOutcome;
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
    if (params.isCanceled()) break;
    const attempt = await runSingleReplayTestAttempt(params, context, attemptIndex);
    updateReplayTestCaseOutcome(outcome, attempt);
    if (shouldStopReplayTestAttempts(params, attempt.outcome, attemptIndex)) break;
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
  const attemptProgress: ReplayTestAttemptProgressContext = {
    file: entry.path,
    title: entry.title,
    index: suiteIndex,
    total: suiteTotal,
    attempt,
    maxAttempts: context.maxAttempts,
    session: testSessionName,
    artifactsDir: context.testArtifactsDir,
    ...replayTestProgressShardMetadata(shard),
  };

  const outcome = await runReplayTestAttempt({
    filePath: entry.path,
    sessionName: testSessionName,
    requestId: attemptRequestId,
    parentRequestId: requestId,
    timeoutMs,
    // The scheduler only ever names a declared platform; caller-bound and unspecified both
    // mean "do not pin one on the nested request" (#1478 P3b).
    platform:
      entry.manifest.device.platform.kind === 'declared'
        ? entry.manifest.device.platform.value
        : undefined,
    target: entry.manifest.device.target,
    artifactsDir: attemptArtifactsDir,
    shard,
    onStep: (step) => {
      params.emitProgress({
        type: 'replay-test',
        ...attemptProgress,
        status: 'progress',
        stepIndex: step.index,
        stepTotal: step.total,
        ...(step.command !== undefined ? { stepCommand: step.command } : {}),
        ...(step.value !== undefined ? { stepValue: step.value } : {}),
      });
    },
    runReplay: params.runReplay,
    cleanupSession: params.cleanupSession,
    finalizeAttempt: params.finalizeAttempt,
    emitDiagnostic: params.emitDiagnostic,
    bindAttemptCancellation: params.bindAttemptCancellation,
  });
  const durationMs = Date.now() - startedAt;
  materializeReplayTestAttemptArtifacts({
    outcome,
    filePath: entry.path,
    sessionName: testSessionName,
    attempts: attempt,
    maxAttempts: context.maxAttempts,
    attemptArtifactsDir,
  });
  return { outcome, sessionName: testSessionName, attempt, durationMs };
}

/** The per-attempt reporter context every progress event for that attempt shares. */
type ReplayTestAttemptProgressContext = Omit<
  ReplayTestProgressEvent,
  | 'type'
  | 'status'
  | 'stepIndex'
  | 'stepTotal'
  | 'stepCommand'
  | 'stepValue'
  | 'durationMs'
  | 'retrying'
  | 'message'
  | 'hint'
>;

function emitReplayTestStartProgress(
  params: ReplayTestCaseParams,
  context: ReplayTestCaseContext,
): void {
  const { entry, sessionName, suiteInvocationId, caseIndex, suiteIndex, suiteTotal, shard } =
    params;
  params.emitProgress({
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
  outcome.finalOutcome = attempt.outcome;
  outcome.finalSessionName = attempt.sessionName;
  outcome.attempts = attempt.attempt;
  outcome.finalAttemptDurationMs = attempt.durationMs;
  if (attempt.outcome.status === 'passed') return;
  outcome.attemptFailures.push({
    attempt: attempt.attempt,
    message: attempt.outcome.error.message,
    durationMs: attempt.durationMs,
  });
}

function shouldStopReplayTestAttempts(
  params: ReplayTestCaseParams,
  outcome: ReplayTestAttemptOutcome,
  attemptIndex: number,
): boolean {
  return (
    outcome.status === 'passed' ||
    params.isCanceled() ||
    outcome.infrastructure ||
    attemptIndex >= params.retries
  );
}

function emitReplayTestRetryProgress(
  params: ReplayTestCaseParams,
  context: ReplayTestCaseContext,
  attempt: ReplayTestAttemptResult,
): void {
  if (attempt.outcome.status === 'passed') return;
  params.emitProgress({
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
    message: attempt.outcome.error.message,
    hint: attempt.outcome.error.hint,
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
  if (outcome.finalOutcome?.status === 'passed') {
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
  const attemptOutcome = outcome.finalOutcome;
  if (attemptOutcome?.status !== 'passed') throw new Error('Expected passing replay test outcome.');
  params.emitProgress({
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
    replayed: attemptOutcome.replayed,
    healed: attemptOutcome.healed,
    ...(attemptOutcome.warnings.length > 0 ? { warnings: [...attemptOutcome.warnings] } : {}),
    ...(attemptOutcome.snapshotDiagnostics
      ? { snapshotDiagnostics: attemptOutcome.snapshotDiagnostics }
      : {}),
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
  const attemptOutcome = outcome.finalOutcome;
  const error =
    attemptOutcome?.status === 'failed'
      ? attemptOutcome.error
      : { code: 'COMMAND_FAILED', message: 'Unknown replay test failure' };
  params.emitProgress({
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
    hint: error.hint,
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
    ...(attemptOutcome?.status === 'failed' && attemptOutcome.infrastructure
      ? { infrastructure: true as const }
      : {}),
    ...(attemptOutcome?.snapshotDiagnostics
      ? { snapshotDiagnostics: attemptOutcome.snapshotDiagnostics }
      : {}),
    ...replayTestShardResultMetadata(shard),
  };
}

function replayTestShardResultMetadata(
  shard: ReplayTestShardContext | undefined,
): Pick<ReplaySuiteTestFailed, 'shardIndex' | 'shardCount' | 'deviceId' | 'deviceName'> {
  return replayTestProgressShardMetadata(shard);
}

function replayTestProgressShardMetadata(
  shard: ReplayTestShardContext | undefined,
): Pick<ReplaySuiteTestFailed, 'shardIndex' | 'shardCount' | 'deviceId' | 'deviceName'> {
  return shard
    ? {
        shardIndex: shard.shardIndex,
        shardCount: shard.shardCount,
        deviceId: shard.device.id,
        deviceName: shard.device.name,
      }
    : {};
}
