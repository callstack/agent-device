import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeError } from '@agent-device/kernel/errors';
import {
  replayTestAttemptFailure,
  type ReplayTestAttemptFailed,
  type ReplayTestAttemptOutcome,
  type ReplayTestAttemptStepSink,
  type ReplayTestEmitDiagnostic,
  type ReplayTestPlatform,
  type ReplayTestRunReplayParams,
  type ReplayTestTarget,
  type ReplayTestRuntimeDependencies,
} from './session-test-types.ts';

const REPLAY_TIMEOUT_CLEANUP_GRACE_MS = 2_000;
const REPLAY_TEST_TIMEOUT_HINT =
  'Replay test timeouts are cooperative; the active command may take a short grace period to stop.';
const REPLAY_TIMEOUT_CLEANUP_PENDING_REASON = 'timeout_cleanup_pending';

export async function runReplayTestAttempt(
  params: {
    filePath: string;
    sessionName: string;
    requestId: string;
    parentRequestId?: string;
    timeoutMs?: number;
    platform?: ReplayTestPlatform;
    target?: ReplayTestTarget;
    artifactsDir?: string;
    shard?: ReplayTestRunReplayParams['shard'];
    onStep?: ReplayTestAttemptStepSink;
    // Only the capabilities this attempt actually exercises. It never publishes progress, so
    // it is not handed `emitProgress` — authority narrows across every hop (#1478 P3b).
  } & Pick<
    ReplayTestRuntimeDependencies,
    | 'runReplay'
    | 'cleanupSession'
    | 'finalizeAttempt'
    | 'emitDiagnostic'
    | 'bindAttemptCancellation'
  >,
): Promise<ReplayTestAttemptOutcome> {
  const {
    filePath,
    sessionName,
    requestId,
    parentRequestId,
    timeoutMs,
    platform,
    target,
    artifactsDir,
    shard,
    onStep,
    runReplay,
    cleanupSession,
    finalizeAttempt,
    emitDiagnostic,
    bindAttemptCancellation,
  } = params;
  const cancellation = bindAttemptCancellation({
    attemptId: requestId,
    parentAttemptId: parentRequestId,
  });
  const artifactPaths = new Set<string>();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let outcome: ReplayTestAttemptOutcome | undefined;
  const attemptStartedAt = Date.now();
  const tracePath = prepareReplayTestTimingTrace({
    artifactsDir,
    artifactPaths,
    filePath,
    sessionName,
    requestId,
    timeoutMs,
    platform,
    target,
  });
  const replayPromise = runReplay({
    filePath,
    sessionName,
    platform,
    target,
    requestId,
    artifactsDir,
    artifactPaths,
    tracePath,
    appendTimingEvent: (event) => appendReplayTestTimingEvent(tracePath, event),
    shard,
    onStep,
  })
    .catch((error) => replayTestAttemptFailure({ error: normalizeError(error) }))
    .finally(() => {
      cancellation.release();
    });

  try {
    outcome =
      typeof timeoutMs === 'number'
        ? await Promise.race([
            replayPromise,
            new Promise<ReplayTestAttemptOutcome>((resolve) => {
              timeoutHandle = setTimeout(() => {
                timedOut = true;
                cancellation.cancel();
                resolve(createReplayTestTimeoutOutcome(timeoutMs, [...artifactPaths]));
              }, timeoutMs);
            }),
          ])
        : await replayPromise;
    appendReplayTestTimingEvent(tracePath, {
      type: 'replay_test_attempt_stop',
      ts: new Date().toISOString(),
      session: sessionName,
      ok: outcome.status === 'passed',
      timedOut,
      durationMs: Date.now() - attemptStartedAt,
      errorCode: outcome.status === 'passed' ? undefined : outcome.error.code,
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timedOut) {
      const settled = await waitForReplayAfterTimeout(replayPromise);
      if (!settled) {
        outcome = markReplayTimeoutCleanupPending(outcome);
        emitDiagnostic({
          level: 'warn',
          phase: 'test_timeout_cleanup_race',
          data: {
            session: sessionName,
            requestId,
            graceMs: REPLAY_TIMEOUT_CLEANUP_GRACE_MS,
          },
        });
        void cleanupSessionAfterLateReplay({
          replayPromise,
          cleanupSession,
          sessionName,
          requestId,
          emitDiagnostic,
        });
      }
    }
    const finalizeFailure = await finalizeReplayTestAttempt({
      finalizeAttempt,
      sessionName,
      artifactPaths,
      artifactsDir,
      tracePath,
      emitDiagnostic,
    });
    if (outcome?.status === 'passed' && finalizeFailure) {
      outcome = appendReplayTestWarning(
        outcome,
        `Replay test finalization failed: ${finalizeFailure.error.message}`,
      );
    }
    const cleanupStartedAt = Date.now();
    try {
      appendReplayTestTimingEvent(tracePath, {
        type: 'replay_test_cleanup_start',
        ts: new Date().toISOString(),
        session: sessionName,
      });
      await cleanupSession(sessionName);
      appendReplayTestTimingEvent(tracePath, {
        type: 'replay_test_cleanup_stop',
        ts: new Date().toISOString(),
        session: sessionName,
        ok: true,
        durationMs: Date.now() - cleanupStartedAt,
      });
    } catch (error) {
      const appErr = normalizeError(error);
      appendReplayTestTimingEvent(tracePath, {
        type: 'replay_test_cleanup_stop',
        ts: new Date().toISOString(),
        session: sessionName,
        ok: false,
        durationMs: Date.now() - cleanupStartedAt,
        errorCode: appErr.code,
      });
      emitDiagnostic({
        level: 'warn',
        phase: 'test_cleanup_failed',
        data: {
          session: sessionName,
          error: appErr.message,
        },
      });
    }
  }
  return (
    outcome ??
    replayTestAttemptFailure({
      error: { code: 'COMMAND_FAILED', message: 'Unknown replay test failure' },
    })
  );
}

async function waitForReplayAfterTimeout(
  replayPromise: Promise<ReplayTestAttemptOutcome>,
): Promise<boolean> {
  return await Promise.race([
    replayPromise.then(() => true),
    sleep(REPLAY_TIMEOUT_CLEANUP_GRACE_MS).then(() => false),
  ]);
}

async function cleanupSessionAfterLateReplay(params: {
  replayPromise: Promise<ReplayTestAttemptOutcome>;
  cleanupSession: ReplayTestRuntimeDependencies['cleanupSession'];
  sessionName: string;
  requestId: string;
  emitDiagnostic: ReplayTestEmitDiagnostic;
}): Promise<void> {
  const { replayPromise, cleanupSession, sessionName, requestId, emitDiagnostic } = params;
  try {
    await replayPromise;
  } finally {
    try {
      await cleanupSession(sessionName);
    } catch (error) {
      const appErr = normalizeError(error);
      emitDiagnostic({
        level: 'warn',
        phase: 'test_late_cleanup_failed',
        data: {
          session: sessionName,
          requestId,
          error: appErr.message,
        },
      });
    }
  }
}

async function finalizeReplayTestAttempt(params: {
  finalizeAttempt: ReplayTestRuntimeDependencies['finalizeAttempt'];
  sessionName: string;
  artifactPaths: Set<string>;
  artifactsDir?: string;
  tracePath?: string;
  emitDiagnostic: ReplayTestEmitDiagnostic;
}): Promise<ReplayTestAttemptFailed | undefined> {
  const { finalizeAttempt, sessionName, artifactPaths, artifactsDir, tracePath, emitDiagnostic } =
    params;
  if (!finalizeAttempt) return undefined;
  const finalizeStartedAt = Date.now();
  appendReplayTestTimingEvent(tracePath, {
    type: 'replay_test_finalize_start',
    ts: new Date().toISOString(),
    session: sessionName,
  });
  try {
    const finalized = await finalizeAttempt({
      sessionName,
      artifactPaths,
      artifactsDir,
      tracePath,
      appendTimingEvent: (event) => appendReplayTestTimingEvent(tracePath, event),
    });
    appendReplayTestTimingEvent(tracePath, {
      type: 'replay_test_finalize_stop',
      ts: new Date().toISOString(),
      session: sessionName,
      ok: finalized === undefined,
      durationMs: Date.now() - finalizeStartedAt,
      errorCode: finalized?.error.code,
    });
    return finalized;
  } catch (error) {
    const appErr = normalizeError(error);
    appendReplayTestTimingEvent(tracePath, {
      type: 'replay_test_finalize_stop',
      ts: new Date().toISOString(),
      session: sessionName,
      ok: false,
      durationMs: Date.now() - finalizeStartedAt,
      errorCode: appErr.code,
    });
    emitDiagnostic({
      level: 'warn',
      phase: 'test_finalize_failed',
      data: {
        session: sessionName,
        error: appErr.message,
      },
    });
    return replayTestAttemptFailure({ error: appErr });
  }
}

function markReplayTimeoutCleanupPending(
  outcome: ReplayTestAttemptOutcome | undefined,
): ReplayTestAttemptOutcome | undefined {
  if (!outcome || outcome.status === 'passed') return outcome;
  return {
    ...outcome,
    // The abandoned replay is still running against the device, so the attempt is an
    // environmental failure rather than a test failure: the suite must stop rather than retry.
    infrastructure: true,
    error: {
      ...outcome.error,
      details: {
        ...(outcome.error.details ?? {}),
        reason: REPLAY_TIMEOUT_CLEANUP_PENDING_REASON,
        timeoutCleanupPending: true,
      },
    },
  };
}

function appendReplayTestWarning(
  outcome: Extract<ReplayTestAttemptOutcome, { status: 'passed' }>,
  warning: string,
): ReplayTestAttemptOutcome {
  return { ...outcome, warnings: [...outcome.warnings, warning] };
}

function prepareReplayTestTimingTrace(params: {
  artifactsDir?: string;
  artifactPaths: Set<string>;
  filePath: string;
  sessionName: string;
  requestId: string;
  timeoutMs?: number;
  platform?: ReplayTestPlatform;
  target?: ReplayTestTarget;
}): string | undefined {
  const {
    artifactsDir,
    artifactPaths,
    filePath,
    sessionName,
    requestId,
    timeoutMs,
    platform,
    target,
  } = params;
  if (!artifactsDir) return undefined;
  const tracePath = path.join(artifactsDir, 'replay-timing.ndjson');
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  fs.writeFileSync(tracePath, '');
  artifactPaths.add(tracePath);
  appendReplayTestTimingEvent(tracePath, {
    type: 'replay_test_attempt_start',
    ts: new Date().toISOString(),
    replayPath: filePath,
    session: sessionName,
    requestId,
    timeoutMs,
    platform,
    target,
  });
  return tracePath;
}

export function appendReplayTestTimingEvent(
  tracePath: string | undefined,
  event: Record<string, unknown>,
): void {
  if (!tracePath) return;
  fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`);
}

function createReplayTestTimeoutOutcome(
  timeoutMs: number,
  artifactPaths: string[] = [],
): ReplayTestAttemptOutcome {
  return replayTestAttemptFailure({
    artifactPaths,
    error: {
      code: 'COMMAND_FAILED',
      message: `TIMEOUT after ${timeoutMs}ms`,
      hint: REPLAY_TEST_TIMEOUT_HINT,
      details: {
        reason: 'timeout',
        timeoutMs,
        timeoutMode: 'cooperative',
        artifactPaths,
      },
    },
  });
}
