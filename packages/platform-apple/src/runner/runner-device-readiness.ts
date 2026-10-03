import { AppError } from '@agent-device/kernel/errors';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { resolveIosPhysicalDeviceControl, type IosDeviceReadiness } from './host.ts';
import {
  type IosRunnerDeviceStates,
  type RunnerDeviceReadinessFailureReason,
} from './runner-error-classification.ts';

const DEVICE_MODE_OFF_MESSAGE = 'The iOS device reports that Developer Mode is turned off';

/**
 * The device half of "can this iPhone run the runner at all", asked before the runner builds. Returns
 * the states worth carrying forward, and refuses only what no later step can clear.
 *
 * It refuses for exactly one state: Developer Mode off, which no build, install, or launch step can
 * change and which `xcodebuild` reports only as a signing or install failure with no mention of the
 * setting. The developer disk image is deliberately NOT a refusal: since iOS 17 CoreDevice mounts the
 * personalized image on demand during build and launch, a phone that has just been rebooted reports
 * `ddiServicesAvailable: false` while the very next build clears it, and refusing there would turn a
 * self-clearing state into a failed run (#2683 review). Its state travels on the returned facts
 * instead, and lands on whatever failure the build actually produces.
 *
 * A device that could not answer is left alone. `available: false` carries no verdict, and inventing
 * one from a missing read is how a temporarily unplugged cable turns into a claim about someone's
 * Settings (#2683).
 */
export async function preflightIosRunnerDeviceReadiness(
  device: DeviceInfo,
  budget: Readonly<{ budgetMs: number; signal?: AbortSignal }>,
): Promise<IosRunnerDeviceStates | undefined> {
  if (!isIosFamily(device) || device.kind !== 'device') return undefined;
  const readiness = await resolveIosPhysicalDeviceControl(device).readDeviceReadiness(
    device,
    budget.budgetMs,
    budget.signal,
  );
  // A read that returned just as the startup budget ran out is still not permission to keep going:
  // the caller that cancelled is not waiting for a build that cannot be delivered (#2683).
  budget.signal?.throwIfAborted();
  if (!readiness.available) return undefined;
  const obstacle = namePreBuildDeviceObstacle(readiness);
  if (obstacle) {
    throw new AppError('COMMAND_FAILED', obstacle.message, {
      reason: obstacle.reason,
      hint: obstacle.hint,
      deviceId: device.id,
      developerMode: readiness.developerMode,
      developerDiskImage: readiness.developerDiskImage,
    });
  }
  return {
    developerMode: readiness.developerMode,
    developerDiskImage: readiness.developerDiskImage,
    developerDiskImageHint: readiness.remedies.developerDiskImageUnavailable,
  };
}

/** The device report once it is known to have arrived, which is the only shape with states to weigh. */
type ReadableIosDeviceReadiness = Extract<IosDeviceReadiness, { available: true }>;

/**
 * The one device state that stops a run before the build: the owner's Developer Mode toggle, which
 * no later step turns on and which no build log names. A disabled toggle also explains an
 * unavailable developer disk image, so naming it leaves the reader one thing to fix (#2683).
 */
function namePreBuildDeviceObstacle(
  readiness: ReadableIosDeviceReadiness,
):
  | Readonly<{ reason: RunnerDeviceReadinessFailureReason; message: string; hint: string }>
  | undefined {
  if (readiness.developerMode !== 'disabled') return undefined;
  return {
    reason: 'device_developer_mode_disabled',
    message: DEVICE_MODE_OFF_MESSAGE,
    hint: readiness.remedies.developerModeOff,
  };
}
