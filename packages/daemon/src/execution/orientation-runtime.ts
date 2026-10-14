import type {
  SetOrientationInput,
  UnlockOrientationInput,
} from '@agent-device/contracts/orientation-runtime';
import {
  ORIENTATION_AUTO,
  parseOrientationRequest,
  type DeviceRotation,
  type OrientationRequest,
} from '@agent-device/contracts/device';
import {
  orientationRuntimeUse,
  orientationUnlockRuntimeUse,
} from '@agent-device/contracts/platform-runtime-operations';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { successText } from '@agent-device/kernel/success-text';
import type { DaemonCommandContext } from '../core/context.ts';
import type { ResolvedGenericExecution } from '../core/generic-leaf-execution.ts';
import {
  resolveBoundGenericRuntime,
  type RuntimeAdmissionBindings,
} from '../core/runtime-admission.ts';
import { runtimeExecutionFromContext } from '../core/snapshot-runtime-capture-input.ts';

/** `orientation <rotation|auto>`: the retired leaf's rotation parse, plus the sensor hand-back. */
export function readRequestedOrientation(positionals: readonly string[]): OrientationRequest {
  return parseOrientationRequest(positionals[0]);
}

/** The runner metadata both orientation operations carry, projected from a resolved command context. */
function unlockOrientationInput(context: DaemonCommandContext): UnlockOrientationInput {
  return {
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/** The neutral intent one orientation change carries: the rotation beside that metadata. */
function setOrientationInput(
  rotation: DeviceRotation,
  context: DaemonCommandContext,
): SetOrientationInput {
  return { rotation, ...unlockOrientationInput(context) };
}

/**
 * The one place `orientation` reaches a device (ADR 0019). Exactly one argument-selected use is
 * admitted and bound: a rotation inspects the exact owner's `setOrientation` fact, `auto` its
 * `unlockOrientation` fact. Either binds once, before the dispatcher runs, so an owner that cannot
 * serve the request is refused rather than discovered mid-execution.
 */
export async function resolveBoundOrientationRuntime(
  params: {
    device: DeviceInfo;
    positionals: readonly string[];
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  const requested = readRequestedOrientation(params.positionals);
  if (requested === ORIENTATION_AUTO) {
    return await resolveBoundGenericRuntime(
      {
        command: 'orientation auto',
        device: params.device,
        use: orientationUnlockRuntimeUse,
        inspectFacts: params.inspectFacts,
        platformServices: params.platformServices,
        bindDevice: params.bindDevice,
      },
      executeUnlockOrientation,
    );
  }
  return await resolveBoundGenericRuntime(
    {
      command: 'orientation',
      device: params.device,
      use: orientationRuntimeUse,
      inspectFacts: params.inspectFacts,
      platformServices: params.platformServices,
      bindDevice: params.bindDevice,
    },
    (runtime, context) => executeSetOrientation(runtime, requested, context),
  );
}

/**
 * The ONE place a bound `unlockOrientation` executes. The display follows the sensor from here,
 * so there is no rotation to confirm and none is reported: the result names the mode.
 */
async function executeUnlockOrientation(
  runtime: BoundDeviceRuntime<typeof orientationUnlockRuntimeUse>,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  await runtime.operations.unlockOrientation(unlockOrientationInput(context));
  return {
    action: 'orientation',
    orientation: ORIENTATION_AUTO,
    ...successText('Rotation follows the device sensor'),
  };
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
  const reported = result?.orientation;
  if (reported) {
    return {
      action: 'orientation',
      orientation: reported,
      ...successText(`Rotated to ${reported}`),
    };
  }
  // An owner that reports no resulting rotation is not evidence the device rotated: keep the
  // requested rotation for compatibility, but disclose the unconfirmed claim instead of asserting it.
  return {
    action: 'orientation',
    orientation: requestedRotation,
    confirmed: false,
    warning: `Requested ${requestedRotation}; the device owner reported no resulting orientation, so the rotation is unconfirmed.`,
    ...successText(`Rotation requested: ${requestedRotation} (unconfirmed)`),
  };
}
