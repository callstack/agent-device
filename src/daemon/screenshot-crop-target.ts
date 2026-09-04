import {
  SCREENSHOT_CROP_REASONS,
  type ScreenshotCropReason,
} from '@agent-device/contracts/capture';
import type { SessionSurface } from '@agent-device/contracts/session';
import { resolveDeviceAppleOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { validateSelectorExpression } from '@agent-device/selectors';

/**
 * The `--crop-on` target policy: which device capture frame the crop is accepted on, and the
 * argument policy answered before any device work. The crop leaf (screenshot-crop.ts) runs the
 * crop; this module decides whether it may run at all.
 */

type CropTarget =
  | 'ios-simulator'
  | 'android-emulator'
  | 'android-device'
  | 'macos-app-window'
  | 'ios-physical'
  | 'macos-helper'
  | 'web'
  | 'linux'
  | 'tvos'
  | 'harmonyos'
  | 'vega';

type CropTargetCell =
  | Readonly<{ target: CropTarget; status: 'accepted' }>
  | Readonly<{
      target: CropTarget;
      status: 'rejected';
      rejectionReason: ScreenshotCropReason;
    }>;

/**
 * The machine-readable support policy. A cell is accepted only once the live pixel-identity
 * cross-check against an independent capture has been collected; until then the target is
 * rejected with the pending-evidence reason, and the evidence itself lives in the completeness
 * gate, the geometry fixtures, and the PR history — never in this table.
 */
const PENDING = SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence;
export const SCREENSHOT_CROP_TARGET_CELLS: readonly CropTargetCell[] = [
  { target: 'ios-simulator', status: 'accepted' },
  { target: 'android-emulator', status: 'accepted' },
  { target: 'android-device', status: 'rejected', rejectionReason: PENDING },
  { target: 'macos-app-window', status: 'rejected', rejectionReason: PENDING },
  { target: 'ios-physical', status: 'rejected', rejectionReason: PENDING },
  { target: 'macos-helper', status: 'rejected', rejectionReason: PENDING },
  { target: 'web', status: 'rejected', rejectionReason: PENDING },
  { target: 'linux', status: 'rejected', rejectionReason: PENDING },
  { target: 'tvos', status: 'rejected', rejectionReason: PENDING },
  { target: 'harmonyos', status: 'rejected', rejectionReason: PENDING },
  { target: 'vega', status: 'rejected', rejectionReason: PENDING },
];

/** The one target cell a device's capture frame falls into. */
export function classifyScreenshotCropTarget(
  device: DeviceInfo,
  surface: SessionSurface | undefined,
): CropTarget {
  switch (device.platform) {
    case 'apple':
      return classifyAppleCropTarget(device, surface);
    case 'android':
      return device.kind === 'device' ? 'android-device' : 'android-emulator';
    case 'harmonyos':
      return 'harmonyos';
    case 'vega':
      return 'vega';
    case 'linux':
      return 'linux';
    case 'web':
      return 'web';
  }
}

function classifyAppleCropTarget(
  device: DeviceInfo,
  surface: SessionSurface | undefined,
): CropTarget {
  const appleOs = resolveDeviceAppleOs(device);
  switch (appleOs) {
    case 'ios':
    case 'ipados':
      return device.kind === 'device' ? 'ios-physical' : 'ios-simulator';
    case 'tvos':
      return 'tvos';
    case 'macos':
      return classifyMacOsCropTarget(surface);
    case 'watchos':
    case 'visionos':
      // Stored records carry the reserved OSes although discovery never populates them; a
      // session device on one has no acceptance cell to fall into, so it is a typed refusal,
      // not a guess.
      throw cropRefusal(appleOs);
  }
}

function classifyMacOsCropTarget(surface: SessionSurface | undefined): CropTarget {
  return surface === 'app' || surface === 'frontmost-app' ? 'macos-app-window' : 'macos-helper';
}

function cropRefusal(target: string, rejectionReason?: ScreenshotCropReason): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `screenshot --crop-on is not accepted on ${target} targets`,
    {
      reason: SCREENSHOT_CROP_REASONS.targetNotAccepted,
      ...(rejectionReason ? { rejectionReason } : {}),
    },
  );
}

/**
 * The crop argument policy, answered before any device work: combination refusals, the
 * selector expression, and the acceptance matrix.
 */
export function assertScreenshotCropPolicy(params: {
  device: DeviceInfo;
  surface: SessionSurface | undefined;
  cropOn: string;
  overlayRefs: boolean;
  fullscreen: boolean;
}): void {
  if (params.overlayRefs || params.fullscreen) {
    throw new AppError(
      'INVALID_ARGS',
      '--crop-on cannot be combined with --overlay-refs or --fullscreen: both move the captured frame away from the snapshot viewport the crop is measured against',
      { reason: SCREENSHOT_CROP_REASONS.frameMismatch },
    );
  }
  try {
    validateSelectorExpression(params.cropOn);
  } catch {
    throw new AppError(
      'INVALID_ARGS',
      'screenshot --crop-on requires a valid selector expression',
      { reason: SCREENSHOT_CROP_REASONS.selectorInvalid },
    );
  }
  const target = classifyScreenshotCropTarget(params.device, params.surface);
  const cell = SCREENSHOT_CROP_TARGET_CELLS.find((candidate) => candidate.target === target);
  if (!cell || cell.status === 'rejected') {
    throw cropRefusal(target, cell?.status === 'rejected' ? cell.rejectionReason : undefined);
  }
}
