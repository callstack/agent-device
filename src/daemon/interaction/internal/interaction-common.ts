import type { CommandFlags } from '@agent-device/contracts/command';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { DaemonResponse } from '../../types.ts';
import { stripInternalInteractionFlags } from '../../interaction-outcome-policy.ts';
import {
  computeTargetEvidence,
  type RecordedTargetCapture,
} from '../../session-target-evidence.ts';
import type { MultiTargetAnnotationV1 } from '@agent-device/contracts/replay';
import { inferFillText } from '../../action-utils.ts';
import { recordedInputPlaceholder } from '@agent-device/ad-script';
import { parameterizeRecordedFillPayload } from '../../parameterized-recorded-fill.ts';
import type { InteractionFinalizationOperations } from './types.ts';

export function finalizeTouchInteraction(params: {
  operations: InteractionFinalizationOperations;
  command: string;
  positionals: string[];
  actionCommand?: string;
  retryPositionals?: string[];
  flags: CommandFlags | undefined;
  result: Record<string, unknown>;
  responseData: Record<string, unknown>;
  recordedTarget?: RecordedTargetCapture;
  recordedTargets?: { source: RecordedTargetCapture; destination: RecordedTargetCapture };
  scheduleInteractionOutcomeRetry?: boolean;
  actionStartedAt: number;
  actionFinishedAt: number;
  androidFreshnessBaseline?: SnapshotState | undefined;
}): DaemonResponse {
  const {
    operations,
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
    operations.isSessionRecording() && recordedTarget
      ? computeTargetEvidence(recordedTarget)
      : undefined;
  const targetEvidences =
    operations.isSessionRecording() && recordedTargets
      ? computeMultiTargetEvidence(recordedTargets)
      : undefined;
  operations.recordAction({
    command,
    positionals,
    flags: actionFlags ?? {},
    result: parameterizedResult,
    ...(targetEvidence ? { targetEvidence } : {}),
    ...(targetEvidences ? { targetEvidences } : {}),
  });
  operations.markDeferredOutcome({
    command,
    action: actionCommand,
    positionals: retryPositionals ?? positionals,
    flags,
    scheduleOutcomeRetry: scheduleInteractionOutcomeRetry,
    androidFreshnessBaseline,
  });
  operations.recordGestureVisualization(
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
