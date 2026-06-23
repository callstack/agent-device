import type { CommandFlags } from '../../core/dispatch.ts';
import type { SnapshotState } from '../../utils/snapshot.ts';
import type { GestureReferenceFrame } from '../../core/scroll-gesture.ts';
import type { DaemonCommandContext } from '../context.ts';
import { recordTouchVisualizationEvent } from '../recording-gestures.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { successText } from '../../utils/success-text.ts';
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

export function buildTouchVisualizationResult(params: {
  data: Record<string, unknown> | undefined;
  fallbackX?: number;
  fallbackY?: number;
  referenceFrame?: GestureReferenceFrame;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const { data, fallbackX, fallbackY, referenceFrame, extra } = params;
  const message =
    buildTouchMessage(extra, fallbackX, fallbackY) ??
    (typeof data?.message === 'string' ? data.message : undefined);
  return {
    ...(fallbackX === undefined || fallbackY === undefined ? {} : { x: fallbackX, y: fallbackY }),
    ...(referenceFrame ?? {}),
    ...(extra ?? {}),
    ...(data ?? {}),
    ...successText(message),
  };
}

function buildTouchMessage(
  extra: Record<string, unknown> | undefined,
  x: number | undefined,
  y: number | undefined,
): string | undefined {
  const ref = typeof extra?.ref === 'string' ? extra.ref : undefined;
  const button = typeof extra?.button === 'string' ? extra.button : undefined;
  const gesture = typeof extra?.gesture === 'string' ? extra.gesture : undefined;
  const pointSuffix = x === undefined || y === undefined ? '' : ` (${x}, ${y})`;
  if (typeof extra?.text === 'string') {
    return `Filled ${Array.from(extra.text).length} chars`;
  }
  if (ref) {
    if (gesture === 'longpress') {
      return `Long pressed @${ref}${pointSuffix}`;
    }
    if (button && button !== 'primary') {
      return `Clicked ${button} @${ref}${pointSuffix}`;
    }
    return `Tapped @${ref}${pointSuffix}`;
  }
  return undefined;
}

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
