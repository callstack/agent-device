import { dispatchSnapshotRuntimeCommand } from './snapshot-command-runtime.ts';
import type { SnapshotRuntimeRouteParams } from './snapshot-runtime-binding.ts';
import type { DaemonResponse } from './types.ts';

/** Canonical `diff snapshot` route over one facts-first, request-bound capture runtime. */
export async function dispatchSnapshotDiffViaRuntime(
  params: SnapshotRuntimeRouteParams,
): Promise<DaemonResponse> {
  return await dispatchSnapshotRuntimeCommand({
    ...params,
    command: 'diff',
    execute: async ({ runtime: agentRuntime, sessionName, req, snapshotScope }) => {
      const result = await agentRuntime.capture.diffSnapshot({
        session: sessionName,
        interactiveOnly: req.flags?.snapshotInteractiveOnly,
        depth: req.flags?.snapshotDepth,
        scope: snapshotScope,
        raw: req.flags?.snapshotRaw,
      });
      return {
        data: result,
        record: {
          kind: 'diff',
          mode: 'snapshot',
          baselineInitialized: result.baselineInitialized,
          summary: result.summary,
        },
      };
    },
  });
}
