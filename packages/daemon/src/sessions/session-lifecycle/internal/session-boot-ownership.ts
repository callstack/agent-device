import type { DeviceBootPerformance } from '@agent-device/contracts/device-boot';
import type { CloseBootOwnership } from '../../../core/session-state.ts';

/**
 * Decides what a session's `open` owns stopping, from the two answers it has.
 *
 * #4791: a boot the platform's own boot step reports performing is positive proof, so it owns the
 * boot whatever the snapshot said — the device can even have gone down between the two, which makes
 * the reported boot real while the inference answers nothing. A device-selection snapshot only says
 * the device was STOPPED when the open looked at it, which proves nothing about the boot that
 * followed: anything else could have booted it in the meantime, and nothing about booting a
 * simulator claims the device. So when the platform answers that its own boot step did NOT boot the
 * device, the session owns no stop and reports the inference it refused (`disproved`). An owner
 * that boots through a step of its own outside the preparation that reports — the daemon's Android
 * emulator launch — answers nothing, which leaves the snapshot inference in charge for that family.
 */
export function resolveSessionBootOwnership(
  input: Readonly<{
    /** Device selection's inference: the pre-open snapshot said this stopped local device needed a boot. */
    inferredFromSnapshot: boolean;
    /** What the platform's own boot step reported about its call, when that owner reports at all. */
    bootPerformance: DeviceBootPerformance | undefined;
  }>,
): CloseBootOwnership {
  if (input.bootPerformance?.performed === true) return 'proved';
  if (input.bootPerformance?.performed === false)
    return input.inferredFromSnapshot ? 'disproved' : 'none';
  return input.inferredFromSnapshot ? 'inferred' : 'none';
}
