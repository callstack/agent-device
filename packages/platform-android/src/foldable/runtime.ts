import type { SetFoldPoseInput } from '@agent-device/contracts/device';
import { foldRuntimeOperationFacts } from '@agent-device/contracts/fold-runtime';
import type { RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import { whenAdmitted } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

import { setAndroidFoldPose } from './pose.ts';

const available = Object.freeze({ available: true } as const);

const foldKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'fold poses the hinge of a foldable Android emulator through the emulator console; a physical device is folded by hand.',
} as const);

/**
 * The emulator console is the only Android posture control, so the kind is the whole admission.
 * Whether the emulator *profile* carries a hinge is not in `DeviceInfo`; the operation answers
 * that from the device states the guest lists and refuses a phone profile with a typed
 * `UNSUPPORTED_OPERATION`, the way the Apple owner answers from CoreDevice's display table.
 */
function androidFoldFact(device: DeviceInfo): RuntimeOperationFact {
  return device.kind === 'emulator' ? available : foldKindUnavailable;
}

/** The foldable cell: `setFoldPose`. */
export function androidFoldableFacts(device: DeviceInfo) {
  return foldRuntimeOperationFacts({ fold: androidFoldFact(device) });
}

/** Binds `setFoldPose` when {@link androidFoldableFacts} admitted it. */
export function createAndroidFoldableOperations(params: {
  device: DeviceInfo;
  signal: AbortSignal;
}) {
  const { device, signal } = params;
  return whenAdmitted(androidFoldableFacts(device).setFoldPose, () => ({
    setFoldPose: async (input: SetFoldPoseInput) => {
      signal.throwIfAborted();
      return await setAndroidFoldPose(device, input, { signal });
    },
  }));
}
