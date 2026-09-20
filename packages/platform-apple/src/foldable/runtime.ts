import {
  foldRuntimeOperationFacts,
  type SetFoldPoseInput,
} from '@agent-device/contracts/fold-runtime';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { whenAdmitted } from '@agent-device/contracts/platform-runtime';
import { resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';

import { setAppleFoldPose } from './pose.ts';

const available = Object.freeze({ available: true } as const);

const foldKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'fold is supported on foldable iPhone simulators driven by Xcode Device Hub; a physical device is folded by hand.',
} as const);
const foldOsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'fold poses the hinge of a foldable iPhone; tvOS, macOS, watchOS and visionOS simulators have no hinge.',
} as const);

/**
 * The simulator leaf that can carry a hinge: iPhone and iPad. Which *model* inside it actually
 * folds is not in `DeviceInfo`, so the operation answers that from CoreDevice's display table and
 * refuses a single-panel simulator with a typed `UNSUPPORTED_OPERATION`, the way the runner
 * answers for the Action Button hardware.
 */
function appleFoldFact(device: DeviceInfo): RuntimeOperationFact {
  if (device.kind !== 'simulator') return foldKindUnavailable;
  const os = resolveDeviceAppleOs(device);
  return os === 'ios' || os === 'ipados' ? available : foldOsUnavailable;
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
      return await setAppleFoldPose(device, input.pose, { signal });
    },
  }));
}
