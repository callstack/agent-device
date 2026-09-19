import { AppError } from '@agent-device/kernel/errors';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { resolveIosPhysicalDeviceControl, type IosDeviceRunnerReadiness } from './host.ts';
import type { RunnerDeviceReadinessFailureReason } from './runner-contract.ts';

const DEVICE_MODE_OFF_MESSAGE = 'The iOS device reports that Developer Mode is turned off';
const DISK_IMAGE_SERVICES_MESSAGE =
  'The iOS device reports that developer disk image services are unavailable';

/**
 * The remedy for each state an iPhone can name about itself (#2683), kept beside the states it
 * answers because a hint that outlives its detector turns into advice nobody can check.
 *
 * These answer what the DEVICE reported. Two other sites carry the same vocabulary about different
 * evidence and deliberately say something else: the Mac's `DevToolsSecurity -status` setting is
 * answered in `runner-dev-tools-security.ts`, and a `devicectl` complaint about the image or the
 * toggle is answered from that tool's own output in `core/devicectl.ts`.
 */
const DEVICE_READINESS_HINTS: Record<RunnerDeviceReadinessFailureReason, string> = {
  device_developer_mode_disabled:
    "Turn Developer Mode on on the iPhone itself: Settings > Privacy & Security > Developer Mode, restart it when prompted, unlock it, then retry. The Mac's developer-tools setting is separate and enabling it does not change this one.",
  device_developer_disk_image_unavailable:
    'Let Xcode finish preparing this device: keep it unlocked and connected by cable, open Xcode > Settings > Platforms (or Window > Devices and Simulators), wait for device support to install, then retry. This is the developer disk image, not the Developer Mode toggle, which the device answers separately.',
};

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
export async function assertDeviceReadinessForIosRunner(device: DeviceInfo): Promise<void> {
  if (!isIosFamily(device) || device.kind !== 'device') return;
  const readiness = await resolveIosPhysicalDeviceControl(device).readDeviceReadiness(device);
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
    return {
      reason: 'device_developer_mode_disabled',
      message: DEVICE_MODE_OFF_MESSAGE,
      hint: DEVICE_READINESS_HINTS.device_developer_mode_disabled,
    };
  }
  if (readiness.developerDiskImage === 'unavailable') {
    return {
      reason: 'device_developer_disk_image_unavailable',
      message: DISK_IMAGE_SERVICES_MESSAGE,
      hint: DEVICE_READINESS_HINTS.device_developer_disk_image_unavailable,
    };
  }
  return undefined;
}
