import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { SettleObservation, SurfaceScopedNodes } from '@agent-device/contracts/interaction';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { stripInternalInteractionFlags } from '../../../core/deferred-interaction-outcome.ts';
import {
  computeTargetEvidence,
  type RecordedTargetCapture,
} from '@agent-device/selectors/target-evidence';
import type { MultiTargetAnnotationV1 } from '@agent-device/contracts/replay';
import {
  inferFillText,
  isSensitiveFillText,
  sensitiveFillPlaceholder,
} from '@agent-device/ad-script';
import { parameterizeRecordedFillPayload } from '@agent-device/selectors/parameterized-recorded-fill';
import type { InteractionFinalizationOperations } from '../../../core/interaction/internal/types.ts';

export function finalizeTouchInteraction(params: {
  operations: InteractionFinalizationOperations;
  command: string;
  positionals: string[];
  actionCommand?: string;
  flags: CommandFlags | undefined;
  result: Record<string, unknown>;
  responseData: Record<string, unknown>;
  recordedTarget?: RecordedTargetCapture;
  recordedTargets?: { source: RecordedTargetCapture; destination: RecordedTargetCapture };
  actionStartedAt: number;
  actionFinishedAt: number;
  androidFreshnessBaseline?: SnapshotState | undefined;
  /**
   * The tree this action resolved its target against, plus its own `--settle` observation when it ran
   * one — both forwarded to the deferred-outcome marker, which reads the settled-tree signal from the
   * second (#3471). Absent for the dispatches that acted without a daemon tree.
   */
  preActionTree?: SurfaceScopedNodes | undefined;
  settle?: SettleObservation | undefined;
}): DaemonResponse {
  const {
    operations,
    command,
    positionals,
    actionCommand = command,
    flags,
    result,
    responseData,
    recordedTarget,
    recordedTargets,
    actionStartedAt,
    actionFinishedAt,
    androidFreshnessBaseline,
    preActionTree,
    settle,
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
    positionals,
    flags,
    androidFreshnessBaseline,
    preActionTree,
    settle,
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
  if (params.command !== 'fill' || !isSensitiveFillText(params.flags)) {
    return [params.result, params.responseData];
  }
  const literal = inferFillText({
    ts: 0,
    command: 'fill',
    positionals: params.positionals,
    flags: params.flags,
    result: params.result,
  });
  const placeholder = sensitiveFillPlaceholder(params.flags);
  return [
    parameterizeRecordedFillPayload(params.result, literal, placeholder),
    parameterizeRecordedFillPayload(params.responseData, literal, placeholder),
  ];
}
