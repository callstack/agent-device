import { asAppError, normalizeError } from '@agent-device/kernel/errors';
import type {
  ReplaySuiteResult,
  ReplaySuiteTestFailed,
  ReplaySuiteTestResult,
} from '@agent-device/contracts/replay';
import { resolveReplayTestArtifactsDir } from './session-test-artifacts.ts';
import {
  buildReplayTestInvocationId,
  discoverReplayTestEntries,
  type ReplayTestRunEntry,
  resolveReplayTestRetries,
  resolveReplayTestTimeout,
} from './session-test-discovery.ts';
import { runReplayTestCase, type ReplayTestCaseReport } from './session-test-attempt.ts';
import type {
  ReplayTestEmitProgress,
  ReplayTestIsCanceled,
  ReplayTestExecutionDependencies,
  ReplayTestRuntimeDependencies,
  ReplayTestSuiteOutcome,
  ReplayTestSuiteRequest,
  ReplayTestDiscoverSources,
} from './session-test-types.ts';
import {
  buildReplayTestShardPlan,
  type ReplayTestResolveShardTargets,
  type ReplayTestShardContext,
  type ReplayTestShardPlan,
} from './session-test-sharding.ts';
import { mergeSnapshotDiagnostics } from '@agent-device/contracts/capture';

type ReplayTestEntry = ReturnType<typeof discoverReplayTestEntries>[number];
type ReplayTestQueuedEntry = {
  entry: ReplayTestRunEntry;
  suiteIndex: number;
};

type ReplayTestSuitePlan = {
  entries: ReplayTestEntry[];
  runnable: ReplayTestQueuedEntry[];
  shardPlan: ReplayTestShardPlan<ReplayTestQueuedEntry> | undefined;
  suiteArtifactsDir: string;
  suiteInvocationId: string;
  total: number;
};

export async function runReplayTestSuite(
  params: {
    request: ReplayTestSuiteRequest;
  } & ReplayTestRuntimeDependencies,
): Promise<ReplayTestSuiteOutcome> {
  const {
    request,
    runReplay,
    cleanupSession,
    finalizeAttempt,
    emitProgress,
    isCanceled,
    emitDiagnostic,
    bindAttemptCancellation,
    discoverSources,
    resolveShardTargets,
  } = params;
  const sessionName = request.sessionName;
  if (request.inputs.length === 0) {
    return {
      status: 'failed',
      error: { code: 'INVALID_ARGS', message: 'test requires at least one path or glob' },
    };
  }

  try {
    const suiteStartedAt = Date.now();
    const plan = await prepareReplayTestSuitePlan(request, discoverSources, resolveShardTargets);
    emitReplayTestSuiteStart(plan, emitProgress);
    const results: ReplaySuiteTestResult[] = plan.shardPlan
      ? emitSkippedReplayTestResults({
          entries: plan.entries,
          total: plan.total,
          emitProgress,
        })
      : [];

    if (plan.shardPlan) {
      results.push(
        ...(await runReplayTestShards({
          shards: plan.shardPlan.shards,
          sessionName,
          suiteInvocationId: plan.suiteInvocationId,
          cwd: request.cwd,
          requestId: request.requestId,
          request,
          suiteArtifactsDir: plan.suiteArtifactsDir,
          suiteTotal: plan.total,
          runReplay,
          cleanupSession,
          finalizeAttempt,
          emitProgress,
          isCanceled,
          emitDiagnostic,
          bindAttemptCancellation,
        })),
      );
    } else {
      results.push(
        ...(await runReplayTestEntriesInDiscoveryOrder({
          discoveryEntries: plan.entries,
          sessionName,
          suiteInvocationId: plan.suiteInvocationId,
          cwd: request.cwd,
          requestId: request.requestId,
          request,
          suiteArtifactsDir: plan.suiteArtifactsDir,
          suiteTotal: plan.total,
          runReplay,
          cleanupSession,
          finalizeAttempt,
          emitProgress,
          isCanceled,
          emitDiagnostic,
          bindAttemptCancellation,
        })),
      );
    }

    const data = summarizeReplayTestResults(plan.total, results, Date.now() - suiteStartedAt);
    return { status: 'completed', data };
  } catch (err) {
    const appErr = asAppError(err);
    return { status: 'failed', error: { code: appErr.code, message: appErr.message } };
  }
}

async function prepareReplayTestSuitePlan(
  request: ReplayTestSuiteRequest,
  discoverSources: ReplayTestDiscoverSources,
  resolveShardTargets: ReplayTestResolveShardTargets,
): Promise<ReplayTestSuitePlan> {
  const entries = discoverReplayTestSuiteEntries(request, discoverSources);
  const runnable = runnableReplayTestEntries(entries);
  const skippedCount = entries.length - runnable.length;
  const suiteInvocationId = buildReplayTestInvocationId(request.requestId);
  const shardPlan = await buildReplayTestShardPlan(
    request.shard ? { kind: request.shard.mode, count: request.shard.count } : undefined,
    runnable,
    skippedCount,
    resolveShardTargets,
  );
  return {
    entries,
    runnable,
    shardPlan,
    suiteInvocationId,
    suiteArtifactsDir: replayTestSuiteArtifactsDir(request, suiteInvocationId),
    total: shardPlan?.total ?? entries.length,
  };
}

function discoverReplayTestSuiteEntries(
  request: ReplayTestSuiteRequest,
  discoverSources: ReplayTestDiscoverSources,
): ReplayTestEntry[] {
  return discoverReplayTestEntries({
    inputs: [...request.inputs],
    cwd: request.cwd,
    platformFilter: request.platformFilter,
    discoverSources,
  });
}

function runnableReplayTestEntries(entries: ReplayTestEntry[]): ReplayTestQueuedEntry[] {
  return entries.flatMap((entry, entryIndex) =>
    entry.kind === 'run' ? [{ entry, suiteIndex: entryIndex + 1 }] : [],
  );
}

function replayTestSuiteArtifactsDir(
  request: ReplayTestSuiteRequest,
  suiteInvocationId: string,
): string {
  return resolveReplayTestArtifactsDir({
    artifactsDir: typeof request.artifactsDir === 'string' ? request.artifactsDir : undefined,
    cwd: request.cwd,
    suiteInvocationId,
  });
}

function emitReplayTestSuiteStart(
  plan: ReplayTestSuitePlan,
  emitProgress: ReplayTestEmitProgress,
): void {
  emitProgress({
    type: 'replay-test-suite',
    status: 'start',
    total: plan.total,
    runnable: plan.runnable.length,
    skipped: plan.entries.length - plan.runnable.length,
    artifactsDir: plan.suiteArtifactsDir,
    shardMode: plan.shardPlan?.mode,
    shardCount: plan.shardPlan?.shardCount,
  });
}

function emitSkippedReplayTestResults(params: {
  entries: ReplayTestEntry[];
  total: number;
  emitProgress: ReplayTestEmitProgress;
}): ReplaySuiteTestResult[] {
  const { entries, total } = params;
  const results: ReplaySuiteTestResult[] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.kind !== 'skip') continue;
    params.emitProgress({
      type: 'replay-test',
      file: entry.path,
      status: 'skip',
      index: entryIndex + 1,
      total,
      message: entry.message,
    });
    results.push({
      file: entry.path,
      status: 'skipped',
      durationMs: 0,
      reason: entry.reason,
      message: entry.message,
    });
  }
  return results;
}

async function runReplayTestShards(
  params: {
    shards: Array<ReplayTestShardContext & { entries: ReplayTestQueuedEntry[] }>;
    sessionName: string;
    suiteInvocationId: string;
    cwd?: string;
    requestId?: string;
    request: ReplayTestSuiteRequest;
    suiteArtifactsDir: string;
    suiteTotal: number;
  } & ReplayTestExecutionDependencies,
): Promise<ReplaySuiteTestResult[]> {
  const settled = await Promise.allSettled(
    params.shards.map(async (shard) => await runReplayTestShard({ ...params, shard })),
  );
  return settled.flatMap((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const shard = params.shards[index];
    return shard ? [buildUnexpectedShardFailure(shard, params.sessionName, result.reason)] : [];
  });
}

function buildUnexpectedShardFailure(
  shard: ReplayTestShardContext & { entries: ReplayTestQueuedEntry[] },
  sessionName: string,
  reason: unknown,
): ReplaySuiteTestFailed {
  const appErr = normalizeError(reason);
  return {
    file: shard.entries[0]?.entry.path ?? `shard-${shard.shardIndex + 1}`,
    session: formatReplayTestShardSessionName(sessionName, shard),
    status: 'failed',
    durationMs: 0,
    attempts: 1,
    error: {
      code: appErr.code,
      message: appErr.message,
      hint: appErr.hint,
      diagnosticId: appErr.diagnosticId,
      logPath: appErr.logPath,
      details: appErr.details,
    },
    shardIndex: shard.shardIndex,
    shardCount: shard.shardCount,
    deviceId: shard.device.id,
    deviceName: shard.device.name,
  };
}

async function runReplayTestShard(
  params: {
    shard: ReplayTestShardContext & { entries: ReplayTestQueuedEntry[] };
    sessionName: string;
    suiteInvocationId: string;
    cwd?: string;
    requestId?: string;
    request: ReplayTestSuiteRequest;
    suiteArtifactsDir: string;
    suiteTotal: number;
  } & ReplayTestExecutionDependencies,
): Promise<ReplaySuiteTestResult[]> {
  const { shard, sessionName } = params;
  return await runReplayTestEntries({
    ...params,
    entries: shard.entries,
    sessionName: formatReplayTestShardSessionName(sessionName, shard),
    shard,
  });
}

function formatReplayTestShardSessionName(
  sessionName: string,
  shard: ReplayTestShardContext,
): string {
  return `${sessionName}:shard-${shard.shardIndex + 1}`;
}

async function runReplayTestEntriesInDiscoveryOrder(
  params: {
    discoveryEntries: ReplayTestEntry[];
    sessionName: string;
    suiteInvocationId: string;
    cwd?: string;
    requestId?: string;
    request: ReplayTestSuiteRequest;
    suiteArtifactsDir: string;
    suiteTotal: number;
  } & ReplayTestExecutionDependencies,
): Promise<ReplaySuiteTestResult[]> {
  const {
    discoveryEntries,
    sessionName,
    suiteInvocationId,
    cwd,
    requestId,
    request,
    suiteArtifactsDir,
    suiteTotal,
    runReplay,
    cleanupSession,
    finalizeAttempt,
    emitProgress,
    isCanceled,
    emitDiagnostic,
    bindAttemptCancellation,
  } = params;
  const results: ReplaySuiteTestResult[] = [];
  let executed = 0;
  for (const [entryIndex, entry] of discoveryEntries.entries()) {
    if (isCanceled()) break;
    if (entry.kind === 'skip') {
      emitProgress({
        type: 'replay-test',
        file: entry.path,
        status: 'skip',
        index: entryIndex + 1,
        total: suiteTotal,
        message: entry.message,
      });
      results.push({
        file: entry.path,
        status: 'skipped',
        durationMs: 0,
        reason: entry.reason,
        message: entry.message,
      });
      continue;
    }
    executed += 1;
    const report = await runReplayTestCase({
      entry,
      sessionName,
      suiteInvocationId,
      caseIndex: executed - 1,
      cwd,
      requestId,
      retries: resolveReplayTestRetries(request.retries, entry.manifest.attemptDefaults?.retries),
      timeoutMs: resolveReplayTestTimeout(
        request.timeoutMs,
        entry.manifest.attemptDefaults?.timeoutMs,
      ),
      suiteArtifactsDir,
      suiteIndex: entryIndex + 1,
      suiteTotal,
      runReplay,
      cleanupSession,
      finalizeAttempt,
      emitProgress,
      isCanceled,
      emitDiagnostic,
      bindAttemptCancellation,
    });
    results.push(report.result);
    if (shouldStopReplayTestExecution(report, request, isCanceled)) break;
  }
  return results;
}

async function runReplayTestEntries(
  params: {
    entries: ReplayTestQueuedEntry[];
    sessionName: string;
    suiteInvocationId: string;
    cwd?: string;
    requestId?: string;
    request: ReplayTestSuiteRequest;
    suiteArtifactsDir: string;
    suiteTotal: number;
    shard?: ReplayTestShardContext;
  } & ReplayTestExecutionDependencies,
): Promise<ReplaySuiteTestResult[]> {
  const {
    entries,
    sessionName,
    suiteInvocationId,
    cwd,
    requestId,
    request,
    suiteArtifactsDir,
    suiteTotal,
    shard,
    runReplay,
    cleanupSession,
    finalizeAttempt,
    emitProgress,
    isCanceled,
    emitDiagnostic,
    bindAttemptCancellation,
  } = params;
  const results: ReplaySuiteTestResult[] = [];
  for (const [entryIndex, queued] of entries.entries()) {
    if (isCanceled()) break;
    const { entry, suiteIndex } = queued;
    const report = await runReplayTestCase({
      entry,
      sessionName,
      suiteInvocationId,
      caseIndex: entryIndex,
      cwd,
      requestId,
      retries: resolveReplayTestRetries(request.retries, entry.manifest.attemptDefaults?.retries),
      timeoutMs: resolveReplayTestTimeout(
        request.timeoutMs,
        entry.manifest.attemptDefaults?.timeoutMs,
      ),
      suiteArtifactsDir,
      suiteIndex,
      suiteTotal,
      shard,
      runReplay,
      cleanupSession,
      finalizeAttempt,
      emitProgress,
      isCanceled,
      emitDiagnostic,
      bindAttemptCancellation,
    });
    results.push(report.result);
    if (shouldStopReplayTestExecution(report, request, isCanceled)) break;
  }
  return results;
}

function shouldStopReplayTestExecution(
  report: ReplayTestCaseReport,
  request: ReplayTestSuiteRequest,
  isCanceled: ReplayTestIsCanceled,
): boolean {
  return (
    isCanceled() ||
    (request.failFast === true && report.result.status === 'failed') ||
    report.infrastructure
  );
}

function summarizeReplayTestResults(
  total: number,
  results: ReplaySuiteTestResult[],
  durationMs: number,
): ReplaySuiteResult {
  const passed = results.filter((result) => result.status === 'passed').length;
  const failedResults = results.filter(
    (result): result is ReplaySuiteTestFailed => result.status === 'failed',
  );
  const failed = failedResults.length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const executed = passed + failed;
  const snapshotDiagnostics = mergeSnapshotDiagnostics(
    results.map((result) => (result.status === 'skipped' ? undefined : result.snapshotDiagnostics)),
  );
  return {
    total,
    executed,
    passed,
    failed,
    skipped,
    notRun: Math.max(0, total - executed - skipped),
    durationMs,
    failures: failedResults,
    tests: results,
    ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
  };
}
