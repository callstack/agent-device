import type { CommandFlags } from '../../core/dispatch.ts';
import type { SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import type { DaemonCommandContext } from '../context.ts';
import { recordTouchVisualizationEvent } from '../recording-gestures.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import {
  isNavigationSensitiveAction,
  markAndroidSnapshotFreshness,
} from '../android-snapshot-freshness.ts';
import {
  markPendingInteractionOutcome,
  stripInternalInteractionFlags,
} from '../interaction-outcome-policy.ts';
import { markPostGestureStabilization } from '../post-gesture-stabilization.ts';
import { computeTargetEvidence } from '../session-target-evidence.ts';

export type ContextFromFlags = (
  flags: CommandFlags | undefined,
  appBundleId?: string,
  traceLogPath?: string,
) => DaemonCommandContext;

export type InteractionHandlerParams = {
  req: DaemonRequest;
  sessionName: string;
  logPath?: string;
  sessionStore: SessionStore;
  contextFromFlags: ContextFromFlags;
};

export function finalizeTouchInteraction(params: {
  session: SessionState;
  sessionStore: SessionStore;
  command: string;
  positionals: string[];
  retryPositionals?: string[];
  flags: CommandFlags | undefined;
  result: Record<string, unknown>;
  responseData: Record<string, unknown>;
  actionStartedAt: number;
  actionFinishedAt: number;
  androidFreshnessBaseline?: SnapshotState | undefined;
}): DaemonResponse {
  const {
    session,
    sessionStore,
    command,
    positionals,
    retryPositionals,
    flags,
    result,
    responseData,
    actionStartedAt,
    actionFinishedAt,
    androidFreshnessBaseline,
  } = params;
  const actionFlags = stripInternalInteractionFlags(flags);
  const { result: recordedResult, targetEvidence } = extractTargetEvidenceForRecording(
    session,
    result,
  );
  sessionStore.recordAction(session, {
    command,
    positionals,
    flags: actionFlags ?? {},
    result: recordedResult,
    ...(targetEvidence ? { targetEvidence } : {}),
  });
  markPendingInteractionOutcome({
    session,
    command,
    positionals: retryPositionals ?? positionals,
    flags,
    preSnapshot: session.snapshot,
  });
  if (isNavigationSensitiveAction(command)) {
    markAndroidSnapshotFreshness(session, command, androidFreshnessBaseline ?? session.snapshot);
  }
  markPostGestureStabilization(session, command, retryPositionals ?? positionals, flags);
  recordTouchVisualizationEvent(
    session,
    command,
    positionals,
    recordedResult,
    (actionFlags ?? {}) as Record<string, unknown>,
    actionStartedAt,
    actionFinishedAt,
  );
  return { ok: true, data: responseData };
}

/**
 * ADR 0012 decision 3: `result.node`/`result.preActionNodes` (attached only
 * to the internal visualization/session payload, see
 * `interaction-touch-response.ts`) are the record-time winner and tree. When
 * the session is being recorded (`--save-script`), turn them into the
 * compact `target-v1` evidence the script writer emits; either way, strip the
 * raw node/tree back out so no downstream consumer (session history, touch
 * visualization telemetry) ever holds a full AX subtree per action.
 */
function extractTargetEvidenceForRecording(
  session: SessionState,
  result: Record<string, unknown>,
): { result: Record<string, unknown>; targetEvidence: ReturnType<typeof computeTargetEvidence> } {
  if (!('node' in result) && !('preActionNodes' in result)) {
    return { result, targetEvidence: undefined };
  }
  const { node, preActionNodes, ...rest } = result as Record<string, unknown> & {
    node?: SnapshotNode;
    preActionNodes?: SnapshotNode[];
  };
  if (!session.recordSession || !node || !preActionNodes) {
    return { result: rest, targetEvidence: undefined };
  }
  return { result: rest, targetEvidence: computeTargetEvidence({ node, nodes: preActionNodes }) };
}
