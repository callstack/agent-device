import { stripAndroidSystemChromeProvenance } from '@agent-device/contracts/android-system-chrome';
import { copySnapshotClickabilityEvidence } from '@agent-device/contracts/capture';
import {
  SNAPSHOT_COMMAND_OPTION_KEYS,
  snapshotOptionsFromFlags,
} from '@agent-device/kernel/snapshot';
import type { RequestActivationProof } from './capture-disclosure.ts';
import { withTargetActivationDisclosure } from './capture-disclosure.ts';
import { dispatchSnapshotRuntimeCommand } from './snapshot-command-runtime.ts';
import { captureSparseFallbackScreenshot } from './sparse-fallback-screenshot.ts';
import type { SnapshotRuntimeRouteParams } from './snapshot-runtime-binding.ts';
import type { DaemonRequest, DaemonResponse } from './daemon-request.ts';
import type { SessionState } from './session-state.ts';

export async function dispatchSnapshotViaRuntime(
  params: SnapshotRuntimeRouteParams,
): Promise<DaemonResponse> {
  const activationProof: RequestActivationProof = {};
  const response = await dispatchSnapshotRuntimeCommand({
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
        ...snapshotOptionsFromFlags(request.flags, SNAPSHOT_COMMAND_OPTION_KEYS),
        // The session-resolved scope wins over the raw flag.
        scope: snapshotScope,
      });
      // This request's own capture, read here rather than off the stored snapshot: a snapshot that
      // failed before capturing must not inherit the previous command's repair (#2682).
      if (result.targetActivation && !activationProof.state) {
        activationProof.state = { targetActivation: result.targetActivation };
      }
      const refsGeneration = publishedSnapshotGeneration(
        request,
        params.sessionStore.get(resolvedSessionName),
      );
      const publicNodes = stripAndroidSystemChromeProvenance(result.nodes);
      const publicResult = copySnapshotClickabilityEvidence(
        result,
        publicNodes === result.nodes ? result : { ...result, nodes: publicNodes },
      );
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
      const published = copySnapshotClickabilityEvidence(
        publicResult,
        fallbackScreenshot
          ? {
              ...publicResult,
              fallbackScreenshotPath: fallbackScreenshot.path,
              artifacts: [fallbackScreenshot.artifact],
            }
          : publicResult,
      );
      const data =
        refsGeneration === undefined
          ? published
          : copySnapshotClickabilityEvidence(published, { ...published, refsGeneration });
      return {
        data,
        record: {
          kind: 'snapshot',
          nodes: result.nodes.length,
          truncated: result.truncated,
        },
      };
    },
  });
  // Only this request's capture speaks here. The #2438 surface sentence already rides the capture's
  // own annotations, so re-deriving it from the stored snapshot would copy a sentence the response
  // already carries — and on a snapshot that failed before capturing, would credit it with a surface
  // it never observed (#2682).
  return withTargetActivationDisclosure(response, activationProof.state);
}

function publishedSnapshotGeneration(
  req: DaemonRequest,
  session: SessionState | undefined,
): number | undefined {
  return req.internal?.observationOnly === true ? undefined : session?.snapshotGeneration;
}
