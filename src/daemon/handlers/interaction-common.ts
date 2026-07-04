import type { CommandFlags } from '../../core/dispatch.ts';
import type { SnapshotState } from '../../kernel/snapshot.ts';
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
  sessionStore.recordAction(session, {
    command,
    positionals,
    flags: actionFlags ?? {},
    result,
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
    result,
    (actionFlags ?? {}) as Record<string, unknown>,
    actionStartedAt,
    actionFinishedAt,
  );
  return { ok: true, data: responseData };
}
