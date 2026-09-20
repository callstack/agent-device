import { foldPoseForHingeAngle, type FoldPose } from '@agent-device/contracts/device';
import type { FoldScreenReport, SetFoldPoseResult } from '@agent-device/contracts/fold-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

import { IOS_FOLD_POSE_SETTLE_ATTEMPTS, IOS_FOLD_POSE_STABLE_DEGREES } from '../core/config.ts';
import {
  queryAppleDisplayInventory,
  type AppleDeviceDisplay,
  type AppleDisplayInventory,
} from '../core/display-inventory.ts';
import { readAppleHingeAngle } from '../core/hinge-angle.ts';
import { openIosSimulatorApp, requireSimulatorDevice } from '../core/simulator.ts';
import { runMacOsDeviceHubPoseAction, type MacOsDeviceHubPose } from '../os/macos/helper.ts';

/**
 * The Device Hub action-bar control each pose maps to. Device Hub labels its presets after the
 * shape of the device (Closed, Book, Open); the command names them after what the app sees.
 */
const DEVICE_HUB_POSE_CONTROLS = {
  closed: 'closed',
  'half-open': 'book',
  open: 'open',
} as const satisfies Record<FoldPose, MacOsDeviceHubPose>;

const FOLDABLE_REQUIRED_HINT =
  'fold drives the pose controls Xcode Device Hub shows for a foldable simulator such as iPhone Duo; this simulator reports one integrated panel, so it has no hinge to pose.';

const INVENTORY_REQUIRED_HINT =
  "fold needs 'devicectl device info displays' to tell a foldable from a single-panel simulator; update Xcode to a version that ships the display-information feature.";

/**
 * Puts a foldable simulator into `pose` and verifies it did get there.
 *
 * No official host API sets a hinge pose (ADR 0025): Device Hub sends it to the simulator through
 * a private CoreDevice channel, and the only public seam onto that channel is the pose control in
 * Device Hub's own window. The press is therefore a macOS accessibility action on that control,
 * and the truth of the outcome comes from CoreDevice, not from the press: the hinge angle is read
 * back until it agrees with the request, and the pose is refused if it never does.
 */
export async function setAppleFoldPose(
  device: DeviceInfo,
  pose: FoldPose,
  options: { signal?: AbortSignal } = {},
): Promise<SetFoldPoseResult> {
  requireSimulatorDevice(device, 'fold');
  const inventory = await queryAppleDisplayInventory(device, { signal: options.signal });
  requireFoldableInventory(device, inventory);

  // A headless boot leaves Device Hub unlaunched; the same launch `open` performs brings it up
  // in the background, and the helper then drives whichever window it shows.
  await openIosSimulatorApp({ deviceHub: true, background: true, signal: options.signal });
  const pressed = await runMacOsDeviceHubPoseAction({
    udid: device.id,
    deviceName: device.name,
    pose: DEVICE_HUB_POSE_CONTROLS[pose],
    signal: options.signal,
  });
  emitDiagnostic({
    level: 'info',
    phase: 'apple_fold_pose_pressed',
    data: {
      deviceId: device.id,
      pose,
      control: pressed.control,
      windowTitle: pressed.windowTitle,
      reopened: pressed.reopened,
      selected: pressed.selected,
    },
  });

  const hingeAngleDegrees = await awaitHingePose(device, pose, options.signal);
  const litPanel = await readLitPanel(device, options.signal);
  return {
    pose,
    hingeAngleDegrees,
    ...(litPanel ? { screen: screenReport(litPanel) } : {}),
  };
}

function requireFoldableInventory(device: DeviceInfo, inventory: AppleDisplayInventory): void {
  if (inventory.unresolved) {
    throw new AppError(
      'COMMAND_FAILED',
      'CoreDevice reported no display table for this simulator',
      {
        deviceId: device.id,
        hint: INVENTORY_REQUIRED_HINT,
      },
    );
  }
  if (!inventory.multiScreen) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `${device.name} is not a foldable simulator: fold requires more than one integrated panel`,
      { deviceId: device.id, reason: 'single-panel-device', hint: FOLDABLE_REQUIRED_HINT },
    );
  }
}

/**
 * Reads the hinge until it reports the requested pose. Each read costs one bounded devicectl
 * stream, so the attempt count is the whole settle budget: the Device Hub press animates the
 * hinge, and a press that landed on some other device's window never moves this one.
 *
 * `closed` and `open` are the hinge's two end stops, so one read at the stop is the pose. Every
 * other angle is `half-open`, including the ones a hinge sweeps through on its way somewhere
 * else, so that pose is reported once two consecutive reads agree the hinge has stopped. The rule
 * a refusal obeys is that it never names the pose that was asked for: when the budget ends while
 * the hinge still reads `half-open`, that is the pose, settled or not, and it is reported.
 */
async function awaitHingePose(
  device: DeviceInfo,
  pose: FoldPose,
  signal: AbortSignal | undefined,
): Promise<number> {
  let observed: number | undefined;
  let previous: number | undefined;
  for (let attempt = 1; attempt <= IOS_FOLD_POSE_SETTLE_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    previous = observed;
    observed = await readAppleHingeAngle(device, { signal });
    if (foldPoseForHingeAngle(observed) !== pose) continue;
    if (pose !== 'half-open') return observed;
    if (previous !== undefined && Math.abs(observed - previous) <= IOS_FOLD_POSE_STABLE_DEGREES) {
      return observed;
    }
  }
  if (observed !== undefined && foldPoseForHingeAngle(observed) === pose) return observed;
  throw new AppError(
    'COMMAND_FAILED',
    `${device.name} did not reach the ${pose} pose: CoreDevice still reports a hinge angle of ${observed}°`,
    {
      deviceId: device.id,
      reason: 'fold-pose-unverified',
      requestedPose: pose,
      observedPose: observed === undefined ? undefined : foldPoseForHingeAngle(observed),
      hingeAngleDegrees: observed,
      hint: 'The Device Hub pose control was pressed, but the hinge did not follow. If several Device Hub windows are titled with this device name, close the ones for other simulators so the press reaches this one, then retry.',
    },
  );
}

async function readLitPanel(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<AppleDeviceDisplay | undefined> {
  const inventory = await queryAppleDisplayInventory(device, { signal });
  if (inventory.unresolved || inventory.ambiguous) return undefined;
  return inventory.activeDisplay;
}

function screenReport(display: AppleDeviceDisplay): FoldScreenReport {
  return {
    display: display.name,
    widthPt: Math.round(display.widthPx / display.pointScale),
    heightPt: Math.round(display.heightPx / display.pointScale),
  };
}
