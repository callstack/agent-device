import {
  type SetFoldPoseInput,
  parseFoldPose,
  parseFoldInput,
  parseFoldKeyframesJson,
  type FoldPose,
} from '@agent-device/contracts/device';
import { foldRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { errorResponse } from '@agent-device/kernel/contracts';
import { successText } from '@agent-device/kernel/success-text';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';

/** `fold <pose>`, parsed with the same aliases the CLI reader accepts. */
export function readRequestedFoldPose(positionals: readonly string[]): FoldPose {
  return parseFoldPose(positionals[0]);
}

/**
 * The one place `fold` reaches a device (ADR 0019). Admission inspects the exact owner's
 * `setFoldPose` fact and binds once, before the dispatcher runs, so an owner that cannot pose a
 * hinge is refused rather than discovered mid-execution.
 */
export async function resolveBoundFoldRuntime(
  params: {
    device: DeviceInfo;
    positionals: readonly string[];
    keyframes?: string;
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  const input =
    params.keyframes === undefined
      ? { pose: readRequestedFoldPose(params.positionals) }
      : parseFoldInput({
          pose: params.positionals[0],
          keyframes: parseFoldKeyframesJson(params.keyframes),
        });
  return await resolveBoundGenericRuntime(
    {
      command: 'fold',
      device: params.device,
      use: foldRuntimeUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
      // Derive the refusal from the same `setFoldPose` fact that gates admission, so the command
      // response keeps the fact's typed reason (e.g. `unsupported-device-scope`) and hint rather
      // than the shared hint-only wording; capability and response never diverge.
      unavailableResponse: (unavailable) =>
        errorResponse(
          'UNSUPPORTED_OPERATION',
          'fold is not supported on this device',
          { reason: unavailable.reason },
          unavailable.hint ? { hint: unavailable.hint } : undefined,
        ),
    },
    (runtime) => executeSetFoldPose(runtime, input),
  );
}

/**
 * The ONE place a bound `setFoldPose` executes. The owner reports the pose it read back from the
 * device, so the response carries that reading rather than the request: an owner that could not
 * verify the pose throws instead of answering.
 */
async function executeSetFoldPose(
  runtime: BoundDeviceRuntime<typeof foldRuntimeUse>,
  input: SetFoldPoseInput,
): Promise<Record<string, unknown>> {
  const result = await runtime.operations.setFoldPose(input);
  const screen = result.screen;
  return {
    action: 'fold',
    pose: result.pose,
    hingeAngleDegrees: result.hingeAngleDegrees,
    ...(screen ? { screen } : {}),
    ...successText(
      screen
        ? `Folded to ${result.pose} (hinge ${result.hingeAngleDegrees}°, ${screen.display} native panel ${screen.widthPt}x${screen.heightPt}pt, not snapshot coordinates); refs from before the pose change are stale`
        : `Folded to ${result.pose} (hinge ${result.hingeAngleDegrees}°); refs from before the pose change are stale`,
    ),
  };
}
