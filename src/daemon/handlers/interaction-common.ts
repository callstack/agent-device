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
import { computeTargetEvidence, type RecordedTargetCapture } from '../session-target-evidence.ts';
import { inferFillText } from '../action-utils.ts';
import { recordedInputPlaceholder } from '../../replay/recorded-input.ts';
import { parameterizeRecordedFillPayload } from '../parameterized-recorded-fill.ts';

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
  actionCommand?: string;
  retryPositionals?: string[];
  flags: CommandFlags | undefined;
  result: Record<string, unknown>;
  responseData: Record<string, unknown>;
  /** ADR 0012 decision 3: record-time input for the `target-v1` annotation. */
  recordedTarget?: RecordedTargetCapture;
  actionStartedAt: number;
  actionFinishedAt: number;
  androidFreshnessBaseline?: SnapshotState | undefined;
}): DaemonResponse {
  const {
    session,
    sessionStore,
    command,
    positionals,
    actionCommand = command,
    retryPositionals,
    flags,
    result,
    responseData,
    recordedTarget,
    actionStartedAt,
    actionFinishedAt,
    androidFreshnessBaseline,
  } = params;
  const actionFlags = stripInternalInteractionFlags(flags);
  const [parameterizedResult, parameterizedResponseData] = parameterizeFillPayloads({
    command,
    positionals,
    flags: actionFlags,
    result,
    responseData,
  });
  const targetEvidence =
    session.recordSession && recordedTarget ? computeTargetEvidence(recordedTarget) : undefined;
  sessionStore.recordAction(session, {
    command,
    positionals,
    flags: actionFlags ?? {},
    result: parameterizedResult,
    ...(targetEvidence ? { targetEvidence } : {}),
  });
  markPendingInteractionOutcome({
    session,
    command,
    positionals: retryPositionals ?? positionals,
    flags,
    preSnapshot: session.snapshot,
  });
  if (isNavigationSensitiveAction(actionCommand)) {
    markAndroidSnapshotFreshness(
      session,
      actionCommand,
      androidFreshnessBaseline ?? session.snapshot,
    );
  }
  markPostGestureStabilization(session, actionCommand, retryPositionals ?? positionals, flags);
  recordTouchVisualizationEvent(
    session,
    actionCommand,
    positionals,
    parameterizedResult,
    (actionFlags ?? {}) as Record<string, unknown>,
    actionStartedAt,
    actionFinishedAt,
  );
  return { ok: true, data: parameterizedResponseData };
}

function parameterizeFillPayloads(params: {
  command: string;
  positionals: string[];
  flags: CommandFlags | undefined;
  result: Record<string, unknown>;
  responseData: Record<string, unknown>;
}): readonly [result: Record<string, unknown>, responseData: Record<string, unknown>] {
  if (params.command !== 'fill' || typeof params.flags?.recordAs !== 'string') {
    return [params.result, params.responseData];
  }
  const literal = inferFillText({
    ts: 0,
    command: 'fill',
    positionals: params.positionals,
    flags: params.flags,
    result: params.result,
  });
  const placeholder = recordedInputPlaceholder(params.flags.recordAs);
  return [
    parameterizeRecordedFillPayload(params.result, literal, placeholder),
    parameterizeRecordedFillPayload(params.responseData, literal, placeholder),
  ];
}
