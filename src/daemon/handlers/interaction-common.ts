import type { CommandFlags } from '@agent-device/contracts/command';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { DaemonCommandContext } from '../context.ts';
import { recordTouchVisualizationEvent } from '../recording-gestures.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { markDeferredInteractionOutcome } from '../deferred-interaction-outcome.ts';
import { stripInternalInteractionFlags } from '../interaction-outcome-policy.ts';
import { computeTargetEvidence, type RecordedTargetCapture } from '../session-target-evidence.ts';
import type { MultiTargetAnnotationV1 } from '@agent-device/contracts/replay';
import { inferFillText } from '../action-utils.ts';
import { recordedInputPlaceholder } from '../../replay/recorded-input.ts';
import { parameterizeRecordedFillPayload } from '../parameterized-recorded-fill.ts';
import { isSessionRecording } from '../session-script-publication-capability.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import type { PlatformResourceCleanup } from '@agent-device/contracts/platform-resource-cleanup';

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
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  androidObservation?: AndroidObservationAdapter;
  platformResourceCleanup?: PlatformResourceCleanup;
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
  recordedTargets?: { source: RecordedTargetCapture; destination: RecordedTargetCapture };
  /** False when a post-action observation already proved the interaction landed. */
  scheduleInteractionOutcomeRetry?: boolean;
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
    recordedTargets,
    scheduleInteractionOutcomeRetry = true,
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
    isSessionRecording(session) && recordedTarget
      ? computeTargetEvidence(recordedTarget)
      : undefined;
  const targetEvidences =
    isSessionRecording(session) && recordedTargets
      ? computeMultiTargetEvidence(recordedTargets)
      : undefined;
  sessionStore.recordAction(session, {
    command,
    positionals,
    flags: actionFlags ?? {},
    result: parameterizedResult,
    ...(targetEvidence ? { targetEvidence } : {}),
    ...(targetEvidences ? { targetEvidences } : {}),
  });
  markDeferredInteractionOutcome({
    session,
    command,
    action: actionCommand,
    positionals: retryPositionals ?? positionals,
    flags,
    scheduleOutcomeRetry: scheduleInteractionOutcomeRetry,
    androidFreshnessBaseline,
  });
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

function computeMultiTargetEvidence(recordedTargets: {
  source: RecordedTargetCapture;
  destination: RecordedTargetCapture;
}): MultiTargetAnnotationV1 | undefined {
  const source = computeTargetEvidence(recordedTargets.source);
  const destination = computeTargetEvidence(recordedTargets.destination);
  return source && destination ? { source, destination } : undefined;
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
