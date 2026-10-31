import type { DeviceRotation } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';

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

// A panel table the runtime would not answer is retried, but not once per command: every runner
// request that resolves a surface asks this question, and an unbounded retry pays the probe cost on
// each of them. A few seconds absorbs one command burst; it is short enough that the next request
// minutes after a transient CoreDevice failure asks the panel table again. `apple_panel_table_retry_
// pending` names the window during which a foldable is treated as single-panel.
const PANEL_TABLE_RETRY_MS = 5_000;
const panelTableRetriesAt = createTtlMemo<string, true>({
  ttlMs: PANEL_TABLE_RETRY_MS,
  scheduleExpiry: true,
});

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
  if (panelTableRetriesAt.get(device.id)) {
    // The caller cannot tell this answer from a device it proved single-panel, so the reason has to
    // be in the log: a runner request that follows takes its historic first-window surface route.
    emitDiagnostic({
      level: 'debug',
      phase: 'apple_panel_table_retry_pending',
      data: {
        deviceId: device.id,
        retryInMs: PANEL_TABLE_RETRY_MS,
        hint: 'The panel table would not answer, so until it is asked again this device is treated as single-panel: a runner request carries no lit panel and rotation uses the historic route.',
      },
    });
    return false;
  }
  const inventory = await queryAppleDisplayInventory(device, { signal });
  if (inventory.unresolved) {
    panelTableRetriesAt.set(device.id, true);
    return false;
  }
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
