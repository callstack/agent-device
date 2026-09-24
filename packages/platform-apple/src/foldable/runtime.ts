import type { SetFoldPoseInput } from '@agent-device/contracts/device';
import { foldRuntimeOperationFacts } from '@agent-device/contracts/fold-runtime';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { whenAdmitted } from '@agent-device/contracts/platform-runtime';
import { resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';

import { setAppleFoldPose } from './pose.ts';

const available = Object.freeze({ available: true } as const);

const foldKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'fold is supported on foldable iPhone simulators controlled through simulator HID; a physical device is folded by hand.',
} as const);
const foldOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'fold poses the hinge of a foldable iPhone; tvOS, macOS, watchOS and visionOS simulators have no hinge.',
} as const);

/**
 * A fold inside a scoped simulator set cannot verify its pose: the HID send honours `--set`, but
 * `devicectl device info displays` and `devicectl device motion hinge-angle` take only `--device`
 * and resolve a scoped simulator as `not found`, so ADR 0025's post-dispatch readback is impossible.
 * The refusal is the owning fact, before any display probe or HID effect; the default set is unaffected.
 */
function foldScopeUnavailable(simulatorSetPath: string) {
  return {
    available: false,
    reason: 'unsupported-device-scope',
    hint: `fold cannot resolve a simulator scoped to the set at "${simulatorSetPath}": CoreDevice's display inventory and hinge-angle readback need a simulator in the default set, so the pose could not be verified. Run fold without --ios-simulator-device-set.`,
  } as const;
}

/**
 * The simulator leaf that can carry a hinge: iPhone and iPad. Which *model* inside it actually
 * folds is not in `DeviceInfo`, so the operation answers that from CoreDevice's display table and
 * refuses a single-panel simulator with a typed `UNSUPPORTED_OPERATION`, the way the runner
 * answers for the Action Button hardware. A simulator scoped to a non-default set is refused here
 * too: its pose cannot be read back through CoreDevice, so no display probe or HID effect runs.
 */
function appleFoldFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator') return foldKindUnavailable;
  const os = resolveDeviceAppleOs(device);
  if (os !== 'ios' && os !== 'ipados') return foldOsUnavailable;
  if (device.simulatorSetPath) return foldScopeUnavailable(device.simulatorSetPath);
  return available;
}

/** The foldable cell: `setFoldPose`. */
export function appleFoldableFacts(device: DeviceInfo) {
  return foldRuntimeOperationFacts({ fold: appleFoldFact(device) });
}

/** Binds `setFoldPose` when {@link appleFoldableFacts} admitted it. */
export function createAppleFoldableOperations(params: { device: DeviceInfo; signal: AbortSignal }) {
  const { device, signal } = params;
  return whenAdmitted(appleFoldableFacts(device).setFoldPose, () => ({
    setFoldPose: async (input: SetFoldPoseInput) => {
      signal.throwIfAborted();
      return await setAppleFoldPose(device, input, { signal });
    },
  }));
}
