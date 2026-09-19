import { AppError } from '@agent-device/kernel/errors';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { resolveIosPhysicalDeviceControl, type IosDeviceRunnerReadiness } from './host.ts';
import type { RunnerDeviceReadinessFailureReason } from './runner-contract.ts';

const DEVICE_MODE_OFF_MESSAGE = 'The iOS device reports that Developer Mode is turned off';
const DISK_IMAGE_SERVICES_MESSAGE =
  'The iOS device reports that developer disk image services are unavailable';

/**
 * The remedy for each state an iPhone can name about itself (#2683). These are not worded here: the
 * device fact arrives carrying them, because `core/devicectl.ts` is the one owner that answers a
 * Developer Mode or developer disk image complaint — whether it reaches us as a device state or as
 * that tool's own output — and a second wording of one fix is a second fix people go looking for.
 *
 * `runner-dev-tools-security.ts` carries its own hint and says something different on purpose: that
 * one is about the Mac's `DevToolsSecurity -status`, which no iPhone setting can change.
 */
function readinessHint(
  remedies: ReadableIosDeviceReadiness['remedies'],
  reason: RunnerDeviceReadinessFailureReason,
): string {
  return reason === 'device_developer_mode_disabled'
    ? remedies.developerModeOff
    : remedies.developerDiskImageUnavailable;
}

/**
 * The device half of "can this iPhone run the runner at all", asked before the runner builds.
 *
 * `xcodebuild` and the runner's own connect attempt both fail opaquely when a device refuses to
 * host development tooling: the build cannot install, and the runner never reaches its port. The
 * device states the reason directly, so this asks it once, up front, and publishes the reason with
 * the hint that answers it instead of leaving a caller to read a build log for a phone problem.
 *
 * A device that could not answer is left alone. `available: false` carries no verdict, and inventing
 * one from a missing read is how a temporarily unplugged cable turns into a claim about someone's
 * Settings (#2683).
 */
export async function assertDeviceReadinessForIosRunner(
  device: DeviceInfo,
  budget: Readonly<{ budgetMs: number; signal?: AbortSignal }>,
): Promise<void> {
  if (!isIosFamily(device) || device.kind !== 'device') return;
  const readiness = await resolveIosPhysicalDeviceControl(device).readDeviceReadiness(
    device,
    budget.budgetMs,
    budget.signal,
  );
  // A read that returned just as the startup budget ran out is still not permission to keep going:
  // the caller that cancelled is not waiting for a build that cannot be delivered (#2683).
  budget.signal?.throwIfAborted();
  if (!readiness.available) return;
  const obstacle = nameIosDeviceReadinessObstacle(readiness);
  if (!obstacle) return;
  throw new AppError('COMMAND_FAILED', obstacle.message, {
    reason: obstacle.reason,
    hint: obstacle.hint,
    deviceId: device.id,
    developerMode: readiness.developerMode,
    developerDiskImage: readiness.developerDiskImage,
  });
}

/** The device report once it is known to have arrived, which is the only shape with states to weigh. */
type ReadableIosDeviceReadiness = Extract<IosDeviceRunnerReadiness, { available: true }>;

/**
 * Which of the device's own states names the obstacle, in the order the states explain each other.
 *
 * The toggle is asked first because a device with Developer Mode off cannot serve developer disk
 * image services either, so the toggle explains the image and is the claim worth making. The reverse
 * never holds: an image that is down on a device whose toggle is on — or unread — is its own failure
 * and is never restated as a toggle problem. That one-way direction is what #2683 adds; tool output
 * has always had one line covering both states and always named the wrong one first.
 */
export function nameIosDeviceReadinessObstacle(
  readiness: ReadableIosDeviceReadiness,
):
  | Readonly<{ reason: RunnerDeviceReadinessFailureReason; message: string; hint: string }>
  | undefined {
  if (readiness.developerMode === 'disabled') {
    const reason: RunnerDeviceReadinessFailureReason = 'device_developer_mode_disabled';
    return {
      reason,
      message: DEVICE_MODE_OFF_MESSAGE,
      hint: readinessHint(readiness.remedies, reason),
    };
  }
  if (readiness.developerDiskImage === 'unavailable') {
    const reason: RunnerDeviceReadinessFailureReason = 'device_developer_disk_image_unavailable';
    return {
      reason,
      message: DISK_IMAGE_SERVICES_MESSAGE,
      hint: readinessHint(readiness.remedies, reason),
    };
  }
  return undefined;
}
