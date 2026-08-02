import type { CommandFlags } from '../../core/dispatch.ts';
import type { ReplayScriptMetadata } from '@agent-device/ad-script';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { runReplayTestSuite } from '@agent-device/replay-test';
import { handleCloseCommand } from './session-close.ts';
import { runReplayScriptFile } from './session-replay-runtime.ts';
import { collectReplayActionArtifactPaths } from './session-replay-runtime-artifacts.ts';
import { errorResponse } from './response.ts';
import { asAppError } from '@agent-device/kernel/errors';
import { emitRequestProgress } from '../../request/progress.ts';
import {
  clearRequestCanceled,
  getRequestSignal,
  isRequestCanceled,
  markRequestCanceled,
  registerRequestAbort,
} from '../../request/cancel.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type {
  ReplayTestBindAttemptCancellation,
  ReplayTestShardContext,
  ReplayTestSuiteRequest,
} from '@agent-device/replay-test';
import { buildReplayTestSourceDiscovery } from './session-test-source-discovery.ts';
import {
  buildReplayTestShardFlags,
  buildReplayTestShardTargetResolver,
  readReplayTestShardSelection,
} from './session-test-shard-devices.ts';
import { toReplayTestAttemptOutcome, toReplayTestFinalizeFailure } from './session-test-outcome.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import {
  buildReplayTestVideoOpenLifecycle,
  finalizeReplayTestVideoRecording,
  startReplayTestVideoRecordingIfReady,
} from './session-replay-video-recording.ts';
import { REPLAY_ONLY_TEST_FLAG_REJECTIONS } from './session-replay-test-policy.ts';

/**
 * Binds one replay-test attempt to daemon request cancellation (#1478 P3b).
 *
 * The scheduler owns timeout policy and says only "cancel this attempt" / "release it". Every
 * registry interaction — registering the abort, relaying the parent request's abort so a
 * canceled suite stops its in-flight attempt, and clearing the entry — is host work and lives
 * here, next to the rest of the daemon adapter.
 */
export const bindReplayTestAttemptCancellation: ReplayTestBindAttemptCancellation = ({
  attemptId,
  parentAttemptId,
}) => {
  registerRequestAbort(attemptId);
  const clearParentRelay = relayReplayTestAbortFromParent(attemptId, parentAttemptId);
  return {
    cancel: () => markRequestCanceled(attemptId),
    release: () => {
      clearParentRelay();
      clearRequestCanceled(attemptId);
    },
  };
};

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

export function buildNestedReplayFlags(params: {
  parentFlags: CommandFlags | undefined;
  platform: ReplayScriptMetadata['platform'] | undefined;
  target: ReplayScriptMetadata['target'] | undefined;
  artifactsDir: string | undefined;
  shard?: ReplayTestShardContext;
}): CommandFlags | undefined {
  const { platform, target, artifactsDir, shard } = params;
  const parentFlags = stripReplayTestHarnessFlags(params.parentFlags);
  if (
    platform === undefined &&
    target === undefined &&
    artifactsDir === undefined &&
    shard === undefined
  ) {
    return parentFlags;
  }
  return buildReplayTestShardFlags(
    {
      ...(parentFlags ?? {}),
      ...(platform !== undefined ? { platform } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(artifactsDir !== undefined ? { artifactsDir } : {}),
    },
    shard,
  );
}

function stripReplayTestHarnessFlags(flags: CommandFlags | undefined): CommandFlags | undefined {
  if (flags?.recordVideo !== true) return flags;
  const nestedFlags = { ...flags };
  delete nestedFlags.recordVideo;
  return Object.keys(nestedFlags).length > 0 ? nestedFlags : undefined;
}

export async function handleSessionReplayCommands(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse | null> {
  const { req, sessionName, logPath, sessionStore, leaseRegistry, invoke } = params;

  if (req.command === 'replay') {
    return await runReplayScriptFile({
      req,
      sessionName,
      logPath,
      sessionStore,
      invoke,
    });
  }

  if (req.command === 'test') {
    // `test` shares replay execution below, but replay-only flags must not fan
    // into every nested suite attempt. Keep the raw-daemon defense declarative
    // and aligned with the command grammar; the CLI rejects these earlier.
    const flags = req.flags ?? {};
    for (const rejection of REPLAY_ONLY_TEST_FLAG_REJECTIONS) {
      if (rejection.requested(flags)) {
        return errorResponse('INVALID_ARGS', rejection.message);
      }
    }
    // Translating flags can reject them (mutually exclusive or non-positive shard counts).
    // That rejection has always surfaced as an INVALID_ARGS response, so it is caught here
    // rather than escaping the handler now that translation happens before the suite runs.
    let suiteRequest: ReplayTestSuiteRequest;
    try {
      suiteRequest = toReplayTestSuiteRequest(req, sessionName);
    } catch (err) {
      const appErr = asAppError(err);
      return errorResponse(appErr.code, appErr.message);
    }
    const outcome = await runReplayTestSuite({
      request: suiteRequest,
      // The host owns the request-global progress sink; the scheduler receives only the
      // narrow emit capability (#1478 P3b).
      emitProgress: emitRequestProgress,
      isCanceled: () => isRequestCanceled(req.meta?.requestId),
      emitDiagnostic,
      bindAttemptCancellation: bindReplayTestAttemptCancellation,
      runReplay: async ({
        filePath,
        sessionName: testSessionName,
        platform,
        target,
        requestId,
        artifactsDir,
        artifactPaths,
        tracePath,
        appendTimingEvent,
        shard,
        onStep,
      }) => {
        const captureArtifacts = (response: DaemonResponse): DaemonResponse => {
          if (!artifactPaths) return response;
          collectReplayActionArtifactPaths(response).forEach((entry) => artifactPaths.add(entry));
          return response;
        };

        const nestedFlags = buildNestedReplayFlags({
          parentFlags: req.flags,
          platform,
          target,
          artifactsDir,
          shard,
        });

        const videoRecordingParams = {
          req,
          sessionName: testSessionName,
          logPath,
          sessionStore,
          artifactsDir,
          tracePath,
          appendTimingEvent,
        };
        const openLifecycle = buildReplayTestVideoOpenLifecycle(videoRecordingParams);
        const replayResponse = await runReplayScriptFile({
          req: {
            ...req,
            command: 'replay',
            session: testSessionName,
            positionals: [filePath],
            flags: nestedFlags,
            meta: {
              ...(req.meta ?? {}),
              ...(requestId ? { requestId } : {}),
            },
            ...(req.internal || openLifecycle
              ? {
                  internal: {
                    ...(req.internal ?? {}),
                    ...(openLifecycle ? { openLifecycle } : {}),
                  },
                }
              : {}),
          },
          sessionName: testSessionName,
          logPath,
          sessionStore,
          tracePath,
          onStep,
          invoke: async (nestedReq) => {
            const startResponse = await startReplayTestVideoRecordingIfReady(videoRecordingParams);
            if (startResponse && !startResponse.ok) return startResponse;
            const response = captureArtifacts(await invoke(nestedReq));
            return response;
          },
        });
        return toReplayTestAttemptOutcome(replayResponse);
      },
      finalizeAttempt: async ({
        sessionName: testSessionName,
        artifactPaths,
        artifactsDir,
        tracePath,
        appendTimingEvent,
      }) =>
        toReplayTestFinalizeFailure(
          await finalizeReplayTestVideoRecording({
            req,
            sessionName: testSessionName,
            logPath,
            sessionStore,
            artifactsDir,
            tracePath,
            appendTimingEvent,
            artifactPaths,
          }),
        ),
      discoverSources: buildReplayTestSourceDiscovery(req.flags?.replayBackend),
      resolveShardTargets: buildReplayTestShardTargetResolver(req.flags),
      cleanupSession: async (testSessionName) => {
        if (!sessionStore.get(testSessionName)) return;
        await handleCloseCommand({
          req: {
            token: req.token,
            session: testSessionName,
            command: 'close',
            positionals: [],
            flags: {},
            meta: req.meta,
          },
          sessionName: testSessionName,
          logPath,
          sessionStore,
          leaseRegistry,
        });
      },
    });
    return outcome.status === 'completed'
      ? { ok: true, data: outcome.data }
      : errorResponse(outcome.error.code, outcome.error.message);
  }

  return null;
}

/**
 * Translates a daemon `test` request into the scheduler's neutral request (#1478 P3b).
 *
 * `replayBackend` is deliberately not carried across: it selects an engine, and it has already
 * been applied here when building the source-discovery and shard-target capabilities.
 */
function toReplayTestSuiteRequest(req: DaemonRequest, sessionName: string): ReplayTestSuiteRequest {
  const flags = req.flags ?? {};
  const cwd = req.meta?.cwd;
  const artifactsDir = stringFlag(flags.artifactsDir);
  return {
    inputs: req.positionals ?? [],
    sessionName,
    cwd,
    requestId: req.meta?.requestId,
    platformFilter: flags.platform,
    artifactsDir:
      artifactsDir === undefined ? undefined : SessionStore.expandHome(artifactsDir, cwd),
    failFast: flags.failFast === true,
    retries: numberFlag(flags.retries),
    timeoutMs: numberFlag(flags.timeoutMs),
    shard: readReplayTestShardSelection(flags),
  };
}

function numberFlag(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function stringFlag(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
