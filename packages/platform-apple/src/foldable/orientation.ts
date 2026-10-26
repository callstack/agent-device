import type { DeviceRotation } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

import {
  IOS_FOLDABLE_ORIENTATION_READ_TIMEOUT_MS,
  IOS_FOLDABLE_ORIENTATION_SETTLE_ATTEMPTS,
} from '../core/config.ts';
import { readAppleDeviceOrientation } from '../core/device-orientation.ts';
import { queryAppleDisplayInventory } from '../core/display-inventory.ts';
import { simulatorAddressFor } from '../core/simctl.ts';
import { createFoldHelper } from './fold-helper.ts';
import { appleFoldableFacts } from './runtime.ts';

const UPSIDE_DOWN_UNSUPPORTED_HINT =
  'A foldable simulator accepts portrait, landscape-left, and landscape-right. Its device-state control has no upside-down orientation.';

const SCOPED_SET_UNSUPPORTED_HINT =
  'CoreDevice resolves only simulators in the default device set, so the rotation of a foldable simulator in a scoped set cannot be verified. Rotate it in the default device set.';

const ORIENTATION_UNVERIFIED_HINT =
  'The simulator HID command completed, but CoreDevice did not report the new orientation. Read it with xcrun devicectl device orientation get --device <udid>, then retry.';

/** Resolved panel counts are hardware facts, so each simulator is probed once per daemon. */
const multiPanelByDevice = new Map<string, boolean>();

/**
 * Whether a rotation must go through guest HID: a simulator the `fold` fact admits that has more
 * than one integrated panel. XCUIDevice rotation has no effect there, and its readback repeats
 * the requested value.
 */
export async function isAppleFoldableSimulator(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!appleFoldableFacts(device).setFoldPose.available) return false;
  const known = multiPanelByDevice.get(device.id);
  if (known !== undefined) return known;
  const inventory = await queryAppleDisplayInventory(device, { signal });
  if (inventory.unresolved) return false;
  multiPanelByDevice.set(device.id, inventory.multiScreen);
  return inventory.multiScreen;
}

/** Rotates a foldable simulator through guest HID and verifies the rotation through CoreDevice. */
export async function setAppleFoldableOrientation(
  device: DeviceInfo,
  rotation: DeviceRotation,
  options: { signal?: AbortSignal } = {},
): Promise<{ orientation: DeviceRotation }> {
  const { signal } = options;
  if (rotation === 'portrait-upside-down') {
    throw new AppError('UNSUPPORTED_OPERATION', `${device.name} cannot rotate to ${rotation}`, {
      deviceId: device.id,
      requestedOrientation: rotation,
      reason: 'unsupported-foldable-orientation',
      hint: UPSIDE_DOWN_UNSUPPORTED_HINT,
    });
  }
  if (simulatorAddressFor(device).simulatorSetPath) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `${device.name} cannot rotate in a scoped simulator set`,
      {
        deviceId: device.id,
        reason: 'unsupported-device-scope',
        hint: SCOPED_SET_UNSUPPORTED_HINT,
      },
    );
  }
  await createFoldHelper(device).rotate(rotation, signal);
  emitDiagnostic({
    level: 'info',
    phase: 'apple_foldable_orientation_dispatched',
    data: { deviceId: device.id, orientation: rotation },
  });
  const read = { signal, timeoutMs: IOS_FOLDABLE_ORIENTATION_READ_TIMEOUT_MS };
  // This read can return the orientation CoreDevice sampled before the dispatch.
  await readAppleDeviceOrientation(device, read);
  let observed: DeviceRotation | undefined;
  for (let attempt = 1; attempt <= IOS_FOLDABLE_ORIENTATION_SETTLE_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    observed = await readAppleDeviceOrientation(device, read);
    if (observed === rotation) return { orientation: rotation };
  }
  throw new AppError(
    'COMMAND_FAILED',
    `${device.name} did not rotate to ${rotation}: CoreDevice reports ${observed ?? 'no orientation'}`,
    {
      deviceId: device.id,
      requestedOrientation: rotation,
      ...(observed === undefined ? {} : { observedOrientation: observed }),
      reason: 'orientation-unverified',
      hint: ORIENTATION_UNVERIFIED_HINT,
    },
  );
}
