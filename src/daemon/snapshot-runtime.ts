import { stripAndroidSystemChromeProvenance } from '@agent-device/contracts/platform';
import { dispatchSnapshotRuntimeCommand } from './snapshot-command-runtime.ts';
import { captureSparseFallbackScreenshot } from './sparse-fallback-screenshot.ts';
import type { SnapshotRuntimeRouteParams } from './snapshot-runtime-binding.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';

export async function dispatchSnapshotViaRuntime(
  params: SnapshotRuntimeRouteParams,
): Promise<DaemonResponse> {
  return await dispatchSnapshotRuntimeCommand({
    ...params,
    command: 'snapshot',
    execute: async ({
      runtime: agentRuntime,
      sessionName: resolvedSessionName,
      req: request,
      snapshotScope,
    }) => {
      const result = await agentRuntime.capture.snapshot({
        session: resolvedSessionName,
        interactiveOnly: request.flags?.snapshotInteractiveOnly,
        depth: request.flags?.snapshotDepth,
        scope: snapshotScope,
        raw: request.flags?.snapshotRaw,
        customActions: request.flags?.snapshotCustomActions,
        forceFull: request.flags?.snapshotForceFull,
      });
      const refsGeneration = publishedSnapshotGeneration(
        request,
        params.sessionStore.get(resolvedSessionName),
      );
      const publicNodes = stripAndroidSystemChromeProvenance(result.nodes);
      const publicResult =
        publicNodes === result.nodes ? result : { ...result, nodes: publicNodes };
      const session = params.sessionStore.get(resolvedSessionName);
      const fallbackScreenshot = await captureSparseFallbackScreenshot({
        req: request,
        session,
        sessionName: resolvedSessionName,
        logPath: params.logPath,
        verdict: result.snapshotQuality,
        inspectFacts: params.inspectFacts,
        bindDevice: params.bindDevice,
      });
      const published = fallbackScreenshot
        ? {
            ...publicResult,
            fallbackScreenshotPath: fallbackScreenshot.path,
            artifacts: [fallbackScreenshot.artifact],
          }
        : publicResult;
      return {
        data: refsGeneration === undefined ? published : { ...published, refsGeneration },
        record: {
          kind: 'snapshot',
          nodes: result.nodes.length,
          truncated: result.truncated,
        },
      };
    },
  });
}

function publishedSnapshotGeneration(
  req: DaemonRequest,
  session: SessionState | undefined,
): number | undefined {
  return req.internal?.observationOnly === true ? undefined : session?.snapshotGeneration;
}
