import type { DeviceRotation } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';

import {
  IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS,
  IOS_FOLDABLE_ORIENTATION_READ_TIMEOUT_MS,
  IOS_FOLDABLE_ORIENTATION_SETTLE_ATTEMPTS,
} from '../core/config.ts';
import { readAppleDeviceOrientation } from '../core/device-orientation.ts';
import {
  queryAppleDisplayInventory,
  type AppleDisplayInventory,
} from '../core/display-inventory.ts';
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

// A device whose panel count was never read routes as single-panel. A full-budget read that failed
// for it is not repeated for a few seconds, because every surface command would pay it again.
const unansweredPanelTables = createTtlMemo<string, true>({ ttlMs: 5_000 });
// Reads overlap, so a failure may finish after a read that started later and already resolved.
// Each read takes a sequence number, and a failure never overrides a newer resolved read.
let panelTableReads = 0;
const latestResolvedRead = new Map<string, number>();

function recordPanelTable(
  device: DeviceInfo,
  inventory: AppleDisplayInventory,
  read: number,
): void {
  multiPanelByDevice.set(device.id, inventory.multiScreen);
  unansweredPanelTables.delete(device.id);
  latestResolvedRead.set(device.id, Math.max(read, latestResolvedRead.get(device.id) ?? 0));
}

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
  const read = ++panelTableReads;
  const inventory = await queryAppleDisplayInventory(device, { signal });
  if (inventory.unresolved) return false;
  recordPanelTable(device, inventory, read);
  return inventory.multiScreen;
}

export type FoldablePanelTableRead =
  | { kind: 'multi-panel'; inventory: AppleDisplayInventory }
  /** A device the `fold` fact refuses, one with one panel, or one whose panel count is unknown. */
  | { kind: 'single-panel' }
  /** A device known to have more than one panel whose table did not answer this time. */
  | { kind: 'unreadable' };

/**
 * One panel-table read for a surface request. It records the panel count it reads, so a
 * single-panel simulator pays one read per daemon.
 */
export async function readFoldablePanelTable(
  device: DeviceInfo,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<FoldablePanelTableRead> {
  if (!appleFoldableFacts(device).setFoldPose.available) return { kind: 'single-panel' };
  const known = multiPanelByDevice.get(device.id);
  if (known === false) return { kind: 'single-panel' };
  if (known === undefined && unansweredPanelTables.get(device.id)) return { kind: 'single-panel' };
  const read = ++panelTableReads;
  const inventory = await queryAppleDisplayInventory(device, options);
  if (inventory.unresolved) {
    if (known) return { kind: 'unreadable' };
    const newerReadResolved = (latestResolvedRead.get(device.id) ?? 0) > read;
    const fullBudget = options.timeoutMs >= IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS;
    if (fullBudget && !options.signal?.aborted && !newerReadResolved) {
      unansweredPanelTables.set(device.id, true);
    }
    return { kind: 'single-panel' };
  }
  recordPanelTable(device, inventory, read);
  return inventory.multiScreen ? { kind: 'multi-panel', inventory } : { kind: 'single-panel' };
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
