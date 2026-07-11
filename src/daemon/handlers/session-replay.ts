import type { CommandFlags } from '../../core/dispatch.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { runReplayTestSuite } from './session-test.ts';
import { handleCloseCommand } from './session-close.ts';
import { runReplayScriptFile } from './session-replay-runtime.ts';
import { collectReplayActionArtifactPaths } from './session-replay-runtime-artifacts.ts';
import { errorResponse } from './response.ts';
import type { ReplayScriptMetadata } from '../../replay/script.ts';
import { buildReplayTestShardFlags, type ReplayTestShardContext } from './session-test-sharding.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import {
  buildReplayTestVideoOpenLifecycle,
  finalizeReplayTestVideoRecording,
  startReplayTestVideoRecordingIfReady,
} from './session-replay-video-recording.ts';

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
    // ADR 0012 decision 4 / migration step 5: `--from` is replay-only. `test`
    // shares replay execution (below, via a nested `command: 'replay'`
    // request per matched file) but must remain a full, deterministic suite
    // run, so this is the one place that still knows the ORIGINAL command.
    if (req.flags?.replayFrom !== undefined || req.flags?.replayPlanDigest !== undefined) {
      return errorResponse(
        'INVALID_ARGS',
        'test does not support --from/--plan-digest; resume is replay-only. Run the failing script directly with replay --from.',
      );
    }
    return await runReplayTestSuite({
      req,
      sessionName,
      runReplay: async ({
        filePath,
        sessionName: testSessionName,
        platform,
        target,
        requestId,
        artifactsDir,
        artifactPaths,
        tracePath,
        shard,
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
          invoke: async (nestedReq) => {
            const startResponse = await startReplayTestVideoRecordingIfReady(videoRecordingParams);
            if (startResponse && !startResponse.ok) return startResponse;
            const response = captureArtifacts(await invoke(nestedReq));
            return response;
          },
        });
        return replayResponse;
      },
      finalizeAttempt: async ({
        sessionName: testSessionName,
        artifactPaths,
        artifactsDir,
        tracePath,
      }) =>
        await finalizeReplayTestVideoRecording({
          req,
          sessionName: testSessionName,
          logPath,
          sessionStore,
          artifactsDir,
          tracePath,
          artifactPaths,
        }),
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
  }

  return null;
}
