import type { SetOrientationInput } from '@agent-device/contracts/orientation-runtime';
import { parseDeviceRotation, type DeviceRotation } from '@agent-device/contracts/device';
import { orientationRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { successText } from '../utils/success-text.ts';
import type { DaemonCommandContext } from './context.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

/** `orientation <rotation>`, on the same parse the retired leaf used. */
export function readRequestedOrientation(positionals: readonly string[]): DeviceRotation {
  return parseDeviceRotation(positionals[0]);
}

/** The neutral intent one orientation change carries, projected from a resolved command context. */
function setOrientationInput(
  rotation: DeviceRotation,
  context: DaemonCommandContext,
): SetOrientationInput {
  return {
    rotation,
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * The one place `orientation` reaches a device (ADR 0019). Admission inspects the exact owner's
 * `setOrientation` fact and binds once, before the dispatcher runs, so an owner that cannot rotate
 * is refused rather than discovered mid-execution.
 */
export async function resolveBoundOrientationRuntime(
  params: {
    device: DeviceInfo;
    positionals: readonly string[];
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  const rotation = readRequestedOrientation(params.positionals);
  return await resolveBoundGenericRuntime(
    {
      command: 'orientation',
      device: params.device,
      use: orientationRuntimeUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    },
    (runtime, context) => executeSetOrientation(runtime, rotation, context),
  );
}

/**
 * The ONE place a bound `setOrientation` executes (R44). Typed off `typeof orientationRuntimeUse`
 * rather than a hand-restated operations shape, so a change to what `setOrientation` binds can't
 * silently drift here.
 */
async function executeSetOrientation(
  runtime: BoundDeviceRuntime<typeof orientationRuntimeUse>,
  requestedRotation: DeviceRotation,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  const result = await runtime.operations.setOrientation(
    setOrientationInput(requestedRotation, context),
  );
  const orientation = result?.orientation ?? requestedRotation;
  return { action: 'orientation', orientation, ...successText(`Rotated to ${orientation}`) };
}
