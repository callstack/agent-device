import type { FindLocator } from '@agent-device/selectors';
import type { BoundSelectorCapture } from '../../selector-capture-binding.ts';
import type { SnapshotQualityVerdict, SnapshotState } from '@agent-device/kernel/snapshot';
import { createSelectorCaptureRuntime } from '../../selector-capture-runtime.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../../types.ts';
import { errorResponse } from '../../response.ts';

/** The tree a mutating find resolves its target against, plus what the capture disclosed. */
export type FindTargetTree = {
  nodes: SnapshotState['nodes'];
  snapshotQuality?: SnapshotQualityVerdict;
  systemSurfaceOnly?: boolean;
};

/**
 * Find's target capture. A mutating find (click/fill/focus/type) resolves its target from its
 * own capture rather than the read-only selector runtime's, with find's two sparse-recovery
 * policies and none of the selector read cache tiers — one question, kept out of the route.
 */
export function createFindTargetCapture(
  params: Readonly<{
    device: SessionState['device'];
    session: SessionState;
    req: DaemonRequest;
    logPath: string;
    locator: FindLocator;
    query: string;
    sessionStore: SessionStore;
    sessionName: string;
    capture: BoundSelectorCapture;
  }>,
): () => Promise<FindTargetTree> {
  const { device, session, req, logPath, locator, query, sessionStore, sessionName } = params;
  const captureRuntime = createSelectorCaptureRuntime({
    device,
    session,
    sessionStore,
    sessionName,
    req,
    logPath,
    capture: params.capture,
  });
  return async () => {
    // Interaction targets need the full interactive tree so duplicate labels can
    // be resolved against viewport visibility before an off-screen subtree wins.
    const { snapshot } = await captureRuntime.capture({
      flags: {
        ...req.flags,
        snapshotInteractiveOnly: true,
      },
      recovery: {
        legacyIosSparse: {
          query,
          shouldScope: shouldScopeFind(locator),
        },
        sparseVerdictQueryScope: {
          query,
          shouldScope: shouldScopeFind(locator),
        },
      },
    });
    return {
      nodes: snapshot.nodes,
      snapshotQuality: snapshot.snapshotQuality,
      systemSurfaceOnly: snapshot.systemSurfaceOnly,
    };
  };
}

export function sparseFindSnapshotResponse(verdict: SnapshotQualityVerdict): DaemonResponse {
  return errorResponse('COMMAND_FAILED', 'find could not read the current accessibility tree', {
    reason: verdict.reason,
    hint: 'The snapshot quality verdict is sparse. Use screenshot as visual truth, navigate with coordinates if needed, then retry find after reaching a readable screen.',
  });
}

function shouldScopeFind(locator: FindLocator): boolean {
  return locator !== 'role';
}
