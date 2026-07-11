import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { normalizeError } from '../../kernel/errors.ts';
import {
  clearRequestCanceled,
  getRequestSignal,
  markRequestCanceled,
  registerRequestAbort,
} from '../../request/cancel.ts';
import {
  type ReplayTestActionProgressContext,
  withReplayTestActionProgress,
} from '../../request/progress.ts';
import type { DaemonResponse } from '../types.ts';
import type { ReplayScriptMetadata } from '../../replay/script.ts';
import type {
  ReplayTestRunReplayParams,
  ReplayTestRuntimeDependencies,
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
    platform?: ReplayScriptMetadata['platform'];
    target?: ReplayScriptMetadata['target'];
    artifactsDir?: string;
    shard?: ReplayTestRunReplayParams['shard'];
    progress?: ReplayTestActionProgressContext;
  } & ReplayTestRuntimeDependencies,
): Promise<DaemonResponse> {
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
    progress,
    runReplay,
    cleanupSession,
    finalizeAttempt,
  } = params;
  registerRequestAbort(requestId);
  const clearParentAbortRelay = relayReplayTestAbortFromParent(requestId, parentRequestId);
  const artifactPaths = new Set<string>();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let response: DaemonResponse | undefined;
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
  const replayPromise = withReplayTestActionProgress(
    progress,
    async () =>
      await runReplay({
        filePath,
        sessionName,
        platform,
        target,
        requestId,
        artifactsDir,
        artifactPaths,
        tracePath,
        shard,
      }),
  )
    .catch((error) => {
      const appErr = normalizeError(error);
      return {
        ok: false,
        error: appErr,
      } satisfies DaemonResponse;
    })
    .finally(() => {
      clearParentAbortRelay();
      clearRequestCanceled(requestId);
    });

  try {
    response =
      typeof timeoutMs === 'number'
        ? await Promise.race([
            replayPromise,
            new Promise<DaemonResponse>((resolve) => {
              timeoutHandle = setTimeout(() => {
                timedOut = true;
                markRequestCanceled(requestId);
                resolve(createReplayTestTimeoutResponse(timeoutMs, [...artifactPaths]));
              }, timeoutMs);
            }),
          ])
        : await replayPromise;
    appendReplayTestTimingEvent(tracePath, {
      type: 'replay_test_attempt_stop',
      ts: new Date().toISOString(),
      session: sessionName,
      ok: response.ok,
      timedOut,
      durationMs: Date.now() - attemptStartedAt,
      errorCode: response.ok ? undefined : response.error.code,
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (timedOut) {
      const settled = await waitForReplayAfterTimeout(replayPromise);
      if (!settled) {
        markReplayTimeoutCleanupPending(response);
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
        });
      }
    }
    const finalizedResponse = await finalizeReplayTestAttempt({
      finalizeAttempt,
      sessionName,
      artifactPaths,
      artifactsDir,
      tracePath,
    });
    if (response?.ok && finalizedResponse && !finalizedResponse.ok) {
      appendReplayTestWarning(
        response,
        `Replay test finalization failed: ${finalizedResponse.error.message}`,
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
    response ?? {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'Unknown replay test failure',
      },
    }
  );
}

function relayReplayTestAbortFromParent(
  requestId: string,
  parentRequestId: string | undefined,
): () => void {
  if (!parentRequestId || parentRequestId === requestId) return () => {};
  const parentSignal = getRequestSignal(parentRequestId);
  if (!parentSignal) return () => {};

  const cancelRequest = () => {
    markRequestCanceled(requestId);
  };
  if (parentSignal.aborted) {
    cancelRequest();
    return () => {};
  }
  parentSignal.addEventListener('abort', cancelRequest, { once: true });
  return () => {
    parentSignal.removeEventListener('abort', cancelRequest);
  };
}

async function waitForReplayAfterTimeout(replayPromise: Promise<DaemonResponse>): Promise<boolean> {
  return await Promise.race([
    replayPromise.then(() => true),
    sleep(REPLAY_TIMEOUT_CLEANUP_GRACE_MS).then(() => false),
  ]);
}

async function cleanupSessionAfterLateReplay(params: {
  replayPromise: Promise<DaemonResponse>;
  cleanupSession: ReplayTestRuntimeDependencies['cleanupSession'];
  sessionName: string;
  requestId: string;
}): Promise<void> {
  const { replayPromise, cleanupSession, sessionName, requestId } = params;
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
}): Promise<DaemonResponse | undefined> {
  const { finalizeAttempt, sessionName, artifactPaths, artifactsDir, tracePath } = params;
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
    });
    appendReplayTestTimingEvent(tracePath, {
      type: 'replay_test_finalize_stop',
      ts: new Date().toISOString(),
      session: sessionName,
      ok: finalized?.ok ?? true,
      durationMs: Date.now() - finalizeStartedAt,
      errorCode: finalized?.ok === false ? finalized.error.code : undefined,
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
    return { ok: false, error: appErr };
  }
}

function markReplayTimeoutCleanupPending(response: DaemonResponse | undefined): void {
  if (!response || response.ok) return;
  response.error.details = {
    ...(response.error.details ?? {}),
    reason: REPLAY_TIMEOUT_CLEANUP_PENDING_REASON,
    timeoutCleanupPending: true,
  };
}

function appendReplayTestWarning(
  response: Extract<DaemonResponse, { ok: true }>,
  warning: string,
): void {
  const data = (response.data ??= {});
  const warnings = Array.isArray(data.warnings)
    ? data.warnings.filter((entry): entry is string => typeof entry === 'string')
    : [];
  data.warnings = [...warnings, warning];
}

function prepareReplayTestTimingTrace(params: {
  artifactsDir?: string;
  artifactPaths: Set<string>;
  filePath: string;
  sessionName: string;
  requestId: string;
  timeoutMs?: number;
  platform?: ReplayScriptMetadata['platform'];
  target?: ReplayScriptMetadata['target'];
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

function createReplayTestTimeoutResponse(
  timeoutMs: number,
  artifactPaths: string[] = [],
): DaemonResponse {
  return {
    ok: false,
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
  };
}
