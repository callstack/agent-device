import { asAppError, normalizeError } from '../../kernel/errors.ts';
import { errorResponse } from './response.ts';
import type {
  DaemonRequest,
  DaemonResponse,
  ReplaySuiteResult,
  ReplaySuiteTestFailed,
  ReplaySuiteTestResult,
} from '../types.ts';
import { resolveReplayTestArtifactsDir } from './session-test-artifacts.ts';
import { emitRequestProgress } from '../../request/progress.ts';
import {
  buildReplayTestInvocationId,
  discoverReplayTestEntries,
  type ReplayTestRunEntry,
  resolveReplayTestRetries,
  resolveReplayTestTimeout,
} from './session-test-discovery.ts';
import { isReplayInfrastructureFailure } from './session-test-infrastructure.ts';
import { runReplayTestCase } from './session-test-attempt.ts';
import type { ReplayTestRuntimeDependencies } from './session-test-types.ts';
import {
  buildReplayTestShardPlan,
  type ReplayTestShardContext,
  type ReplayTestShardPlan,
} from './session-test-sharding.ts';
import { isRequestCanceled } from '../../request/cancel.ts';
import { mergeSnapshotDiagnostics } from '../../snapshot-diagnostics.ts';

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
    req: DaemonRequest;
    sessionName: string;
  } & ReplayTestRuntimeDependencies,
): Promise<DaemonResponse> {
  const { req, sessionName, runReplay, cleanupSession, finalizeAttempt } = params;
  if ((req.positionals?.length ?? 0) === 0) {
    return errorResponse('INVALID_ARGS', 'test requires at least one path or glob');
  }

  try {
    const suiteStartedAt = Date.now();
    const plan = await prepareReplayTestSuitePlan(req);
    emitReplayTestSuiteStart(plan);
    const results: ReplaySuiteTestResult[] = plan.shardPlan
      ? emitSkippedReplayTestResults({
          entries: plan.entries,
          total: plan.total,
        })
      : [];

    if (plan.shardPlan) {
      results.push(
        ...(await runReplayTestShards({
          shards: plan.shardPlan.shards,
          sessionName,
          suiteInvocationId: plan.suiteInvocationId,
          cwd: req.meta?.cwd,
          requestId: req.meta?.requestId,
          flags: req.flags,
          suiteArtifactsDir: plan.suiteArtifactsDir,
          suiteTotal: plan.total,
          runReplay,
          cleanupSession,
          finalizeAttempt,
        })),
      );
    } else {
      results.push(
        ...(await runReplayTestEntriesInDiscoveryOrder({
          discoveryEntries: plan.entries,
          sessionName,
          suiteInvocationId: plan.suiteInvocationId,
          cwd: req.meta?.cwd,
          requestId: req.meta?.requestId,
          flags: req.flags,
          suiteArtifactsDir: plan.suiteArtifactsDir,
          suiteTotal: plan.total,
          runReplay,
          cleanupSession,
          finalizeAttempt,
        })),
      );
    }

    const data = summarizeReplayTestResults(plan.total, results, Date.now() - suiteStartedAt);
    return { ok: true, data };
  } catch (err) {
    const appErr = asAppError(err);
    return errorResponse(appErr.code, appErr.message);
  }
}

async function prepareReplayTestSuitePlan(req: DaemonRequest): Promise<ReplayTestSuitePlan> {
  const entries = discoverReplayTestSuiteEntries(req);
  const runnable = runnableReplayTestEntries(entries);
  const skippedCount = entries.length - runnable.length;
  const suiteInvocationId = buildReplayTestInvocationId(req.meta?.requestId);
  const shardPlan = await buildReplayTestShardPlan(req.flags, runnable, skippedCount);
  return {
    entries,
    runnable,
    shardPlan,
    suiteInvocationId,
    suiteArtifactsDir: replayTestSuiteArtifactsDir(req, suiteInvocationId),
    total: shardPlan?.total ?? entries.length,
  };
}

function discoverReplayTestSuiteEntries(req: DaemonRequest): ReplayTestEntry[] {
  return discoverReplayTestEntries({
    inputs: req.positionals ?? [],
    cwd: req.meta?.cwd,
    platformFilter: req.flags?.platform,
    replayBackend: req.flags?.replayBackend,
  });
}

function runnableReplayTestEntries(entries: ReplayTestEntry[]): ReplayTestQueuedEntry[] {
  return entries.flatMap((entry, entryIndex) =>
    entry.kind === 'run' ? [{ entry, suiteIndex: entryIndex + 1 }] : [],
  );
}

function replayTestSuiteArtifactsDir(req: DaemonRequest, suiteInvocationId: string): string {
  return resolveReplayTestArtifactsDir({
    artifactsDir: typeof req.flags?.artifactsDir === 'string' ? req.flags.artifactsDir : undefined,
    cwd: req.meta?.cwd,
    suiteInvocationId,
  });
}

function emitReplayTestSuiteStart(plan: ReplayTestSuitePlan): void {
  emitRequestProgress({
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
}): ReplaySuiteTestResult[] {
  const { entries, total } = params;
  const results: ReplaySuiteTestResult[] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    if (entry.kind !== 'skip') continue;
    emitRequestProgress({
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
    flags: DaemonRequest['flags'];
    suiteArtifactsDir: string;
    suiteTotal: number;
  } & ReplayTestRuntimeDependencies,
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
    flags: DaemonRequest['flags'];
    suiteArtifactsDir: string;
    suiteTotal: number;
  } & ReplayTestRuntimeDependencies,
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
    flags: DaemonRequest['flags'];
    suiteArtifactsDir: string;
    suiteTotal: number;
  } & ReplayTestRuntimeDependencies,
): Promise<ReplaySuiteTestResult[]> {
  const {
    discoveryEntries,
    sessionName,
    suiteInvocationId,
    cwd,
    requestId,
    flags,
    suiteArtifactsDir,
    suiteTotal,
    runReplay,
    cleanupSession,
    finalizeAttempt,
  } = params;
  const results: ReplaySuiteTestResult[] = [];
  let executed = 0;
  for (const [entryIndex, entry] of discoveryEntries.entries()) {
    if (isRequestCanceled(requestId)) break;
    if (entry.kind === 'skip') {
      emitRequestProgress({
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
    const result = await runReplayTestCase({
      entry,
      sessionName,
      suiteInvocationId,
      caseIndex: executed - 1,
      cwd,
      requestId,
      retries: resolveReplayTestRetries(flags?.retries, entry.metadata.retries),
      timeoutMs: resolveReplayTestTimeout(flags?.timeoutMs, entry.metadata.timeoutMs),
      suiteArtifactsDir,
      suiteIndex: entryIndex + 1,
      suiteTotal,
      runReplay,
      cleanupSession,
      finalizeAttempt,
    });
    results.push(result);
    if (shouldStopReplayTestExecution(result, flags, requestId)) break;
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
    flags: DaemonRequest['flags'];
    suiteArtifactsDir: string;
    suiteTotal: number;
    shard?: ReplayTestShardContext;
  } & ReplayTestRuntimeDependencies,
): Promise<ReplaySuiteTestResult[]> {
  const {
    entries,
    sessionName,
    suiteInvocationId,
    cwd,
    requestId,
    flags,
    suiteArtifactsDir,
    suiteTotal,
    shard,
    runReplay,
    cleanupSession,
    finalizeAttempt,
  } = params;
  const results: ReplaySuiteTestResult[] = [];
  for (const [entryIndex, queued] of entries.entries()) {
    if (isRequestCanceled(requestId)) break;
    const { entry, suiteIndex } = queued;
    const result = await runReplayTestCase({
      entry,
      sessionName,
      suiteInvocationId,
      caseIndex: entryIndex,
      cwd,
      requestId,
      retries: resolveReplayTestRetries(flags?.retries, entry.metadata.retries),
      timeoutMs: resolveReplayTestTimeout(flags?.timeoutMs, entry.metadata.timeoutMs),
      suiteArtifactsDir,
      suiteIndex,
      suiteTotal,
      shard,
      runReplay,
      cleanupSession,
      finalizeAttempt,
    });
    results.push(result);
    if (shouldStopReplayTestExecution(result, flags, requestId)) break;
  }
  return results;
}

function shouldStopReplayTestExecution(
  result: ReplaySuiteTestResult,
  flags: DaemonRequest['flags'],
  requestId: string | undefined,
): boolean {
  return (
    isRequestCanceled(requestId) ||
    (flags?.failFast === true && result.status === 'failed') ||
    isReplayInfrastructureFailure(result)
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
