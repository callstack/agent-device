/**
 * The `test` command's own orchestration: harness-flag admission, suite translation, and the
 * scheduler run whose every attempt is a nested `replay`. Extracted from
 * `handleSessionReplayCommands` (`session-replay.ts`), which is now the routing decision alone —
 * this is the half that grew every time the suite gained a capability (video recording, shards,
 * per-attempt step sinks, and #1802's per-source script bundles).
 */

import type { CommandFlags } from '@agent-device/contracts/command';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import { REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE } from '../replay-script-source.ts';
import type { ReplayScriptMetadata } from '@agent-device/ad-script';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import {
  runReplayTestSuite,
  type ReplayTestBindAttemptCancellation,
  type ReplayTestShardContext,
  type ReplayTestSuiteRequest,
} from '@agent-device/replay-test';
import { handleCloseCommand } from './session-close.ts';
import { runReplayScriptSource } from './session-replay-runtime.ts';
import { collectReplayActionArtifactPaths } from './session-replay-runtime-artifacts.ts';
import { errorResponse } from './response.ts';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import {
  emitRequestProgress,
  clearRequestCanceled,
  getRequestSignal,
  isRequestCanceled,
  markRequestCanceled,
  registerRequestAbort,
} from '@agent-device/host-kit/request';

import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { buildReplayTestSourceDiscovery } from './session-test-source-discovery.ts';
import {
  buildReplayTestShardFlags,
  buildReplayTestShardTargetResolver,
  readReplayTestShardSelection,
} from './session-test-shard-devices.ts';
import { toReplayTestAttemptOutcome, toReplayTestFinalizeFailure } from './session-test-outcome.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import type {
  BindDeviceRuntime,
  BindExactDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../request-runtime-binding.ts';
import type { ScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import {
  buildReplayTestVideoOpenLifecycle,
  finalizeReplayTestVideoRecording,
  startReplayTestVideoRecordingIfReady,
} from './session-replay-video-recording.ts';
import { REPLAY_ONLY_TEST_FLAG_REJECTIONS } from './session-replay-test-policy.ts';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';

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
  /** The one source bundle this attempt replays; `test`'s own multi-source list never fans in. */
  sourceBundle?: ReplayScriptSourceBundle;
}): CommandFlags | undefined {
  const { platform, target, artifactsDir, shard, sourceBundle } = params;
  const parentFlags = stripReplayTestHarnessFlags(params.parentFlags);
  if (
    platform === undefined &&
    target === undefined &&
    artifactsDir === undefined &&
    shard === undefined &&
    sourceBundle === undefined
  ) {
    return parentFlags;
  }
  return buildReplayTestShardFlags(
    {
      ...(parentFlags ?? {}),
      ...(platform !== undefined ? { platform } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(artifactsDir !== undefined ? { artifactsDir } : {}),
      ...(sourceBundle !== undefined ? { replayScriptSource: sourceBundle } : {}),
    },
    shard,
  );
}

/**
 * Strips what belongs to the SUITE rather than to one attempt: the harness's own
 * `--record-video`, and (#1802) `replayScriptSources` — the suite's whole discovery result, which
 * `buildNestedReplayFlags` replaces with the single `replayScriptSource` this attempt runs.
 */
function stripReplayTestHarnessFlags(flags: CommandFlags | undefined): CommandFlags | undefined {
  if (!flags) return flags;
  if (flags.recordVideo !== true && flags.replayScriptSources === undefined) return flags;
  const nestedFlags = { ...flags };
  delete nestedFlags.recordVideo;
  delete nestedFlags.replayScriptSources;
  return Object.keys(nestedFlags).length > 0 ? nestedFlags : undefined;
}

export type ReplayTestSuiteCommandParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  invoke: DaemonInvokeFn;
  bindDevice?: BindDeviceRuntime;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindExactDevice?: BindExactDeviceRuntime;
  screenRecordingAdmissionLedger?: ScreenRecordingAdmissionLedger;
  requestScope?: PlatformRequestScope;
  retainDeviceExecutionLock?: (deviceId: string) => Promise<void>;
  throwIfCanceled?: () => void;
  platformResourceCleanup?: PlatformResourceCleanup;
};

export async function runReplayTestSuiteCommand(
  params: ReplayTestSuiteCommandParams,
): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, leaseRegistry, invoke } = params;
  if (!params.platformResourceCleanup) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Platform resource cleanup was not supplied by root runtime composition',
    );
  }
  const platformResourceCleanup = params.platformResourceCleanup;
  const replayVideoRuntime = resolveReplayVideoRuntime(params);
  if (req.flags?.recordVideo === true && replayVideoRuntime === undefined) {
    return errorResponse(
      'COMMAND_FAILED',
      'Screen-recording runtime is not configured for replay video capture',
    );
  }
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
  // #1802: the caller expanded its own paths/globs and sent one script source bundle per
  // discovered source. `sourceBundles` is that list, keyed below by entry path so each nested
  // replay attempt executes exactly the text the caller read for that file.
  let sourceBundles: readonly ReplayScriptSourceBundle[];
  try {
    suiteRequest = toReplayTestSuiteRequest(req, sessionName);
    sourceBundles = requireReplayTestScriptSources(req);
  } catch (error) {
    const appErr = asAppError(error);
    return errorResponse(appErr.code, appErr.message);
  }
  const sourceBundlesByPath = new Map(sourceBundles.map((bundle) => [bundle.entry, bundle]));
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
        sourceBundle: sourceBundlesByPath.get(filePath),
      });

      const videoRecordingParams = replayVideoRuntime
        ? {
            req,
            sessionName: testSessionName,
            sessionStore,
            artifactsDir,
            appendTimingEvent,
            ...replayVideoRuntime,
          }
        : undefined;
      const openLifecycle = videoRecordingParams
        ? buildReplayTestVideoOpenLifecycle(videoRecordingParams)
        : undefined;
      const replayResponse = await runReplayScriptSource({
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
          const startResponse = videoRecordingParams
            ? await startReplayTestVideoRecordingIfReady(videoRecordingParams)
            : undefined;
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
      appendTimingEvent,
    }) => {
      if (!replayVideoRuntime) return undefined;
      return toReplayTestFinalizeFailure(
        await finalizeReplayTestVideoRecording({
          req,
          sessionName: testSessionName,
          sessionStore,
          artifactsDir,
          appendTimingEvent,
          artifactPaths,
          ...replayVideoRuntime,
        }),
      );
    },
    discoverSources: buildReplayTestSourceDiscovery(sourceBundles, req.flags?.replayBackend),
    resolveShardTargets: buildReplayTestShardTargetResolver(req.flags),
    cleanupSession: async (testSessionName) => {
      if (!sessionStore.get(testSessionName)) return;
      const closeResponse = await handleCloseCommand({
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
        inspectFacts: params.inspectFacts,
        bindDevice: params.bindDevice,
        platformResourceCleanup,
      });
      if (!closeResponse.ok) {
        throw new AppError(closeResponse.error.code, closeResponse.error.message, {
          ...(closeResponse.error.details ?? {}),
          ...(closeResponse.error.hint ? { hint: closeResponse.error.hint } : {}),
        });
      }
    },
  });
  return outcome.status === 'completed'
    ? { ok: true, data: outcome.data }
    : errorResponse(outcome.error.code, outcome.error.message);
}

type ReplayVideoRuntime = Readonly<{
  bindDevice: BindDeviceRuntime;
  bindExactDevice: BindExactDeviceRuntime;
  screenRecordingAdmissionLedger: ScreenRecordingAdmissionLedger;
  requestScope: PlatformRequestScope;
  retainDeviceExecutionLock(deviceId: string): Promise<void>;
  throwIfCanceled(): void;
}>;

function resolveReplayVideoRuntime(params: {
  bindDevice?: BindDeviceRuntime;
  bindExactDevice?: BindExactDeviceRuntime;
  screenRecordingAdmissionLedger?: ScreenRecordingAdmissionLedger;
  requestScope?: PlatformRequestScope;
  retainDeviceExecutionLock?: (deviceId: string) => Promise<void>;
  throwIfCanceled?: () => void;
}): ReplayVideoRuntime | undefined {
  if (
    !params.bindDevice ||
    !params.bindExactDevice ||
    !params.screenRecordingAdmissionLedger ||
    !params.requestScope ||
    !params.retainDeviceExecutionLock ||
    !params.throwIfCanceled
  ) {
    return undefined;
  }
  return {
    bindDevice: params.bindDevice,
    bindExactDevice: params.bindExactDevice,
    screenRecordingAdmissionLedger: params.screenRecordingAdmissionLedger,
    requestScope: params.requestScope,
    retainDeviceExecutionLock: params.retainDeviceExecutionLock,
    throwIfCanceled: params.throwIfCanceled,
  };
}

/**
 * Translates a daemon `test` request into the scheduler's neutral request (#1478 P3b).
 *
 * `replayBackend` is deliberately not carried across: it selects an engine, and it has already
 * been applied here when building the source-discovery and shard-target capabilities.
 */
/**
 * #1802: a `test` request states the script sources its suite runs, because the daemon opens no
 * caller path. Absent entirely means a client too old to send them; it is rejected as a typed
 * `AppError` so it travels the same translation-failure path the shard/flag rejections already
 * take, rather than adding a second refusal shape to the handler.
 */
function requireReplayTestScriptSources(req: DaemonRequest): readonly ReplayScriptSourceBundle[] {
  const sources = req.flags?.replayScriptSources;
  if (!sources) throw new AppError('INVALID_ARGS', REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE);
  return sources;
}

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
