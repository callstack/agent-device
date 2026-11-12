import type { DeviceRotation } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';

import {
  IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS,
  IOS_FOLDABLE_ORIENTATION_SETTLE_ATTEMPTS,
  IOS_FOLDABLE_ORIENTATION_SETTLE_MS,
} from '../core/config.ts';
import {
  establishedLitPanel,
  panelContentRotation,
  queryAppleDisplayInventory,
  type AppleDeviceDisplay,
  type AppleDisplayInventory,
} from '../core/display-inventory.ts';
import { simulatorAddressFor } from '../core/simctl.ts';
import { createFoldHelper, type FoldHelper, type FoldableRotation } from './fold-helper.ts';
import { appleFoldableFacts } from './runtime.ts';

const UPSIDE_DOWN_UNSUPPORTED_HINT =
  'A foldable simulator accepts portrait, landscape-left, and landscape-right as rotation targets.';

const ORIENTATION_UNVERIFIED_HINT =
  'The lit panel did not show the requested orientation, or the simulator never reported a single lit panel; the app in front may not support that orientation. Take a screenshot to see the screen, then retry.';

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
  const inventory = await queryAppleDisplayInventory(device, {
    signal,
  });
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

/** iPhone Duo (iOS 27.3) renders picker + offset: outer 0 degrees, inner +90. */
const PANEL_PICKERS = {
  outer: {
    portrait: 'portrait',
    'landscape-left': 'landscape-left',
    'landscape-right': 'landscape-right',
  },
  inner: {
    portrait: 'landscape-left',
    'landscape-left': 'portrait-upside-down',
    'landscape-right': 'portrait',
  },
} as const;

type LitPanel = { panel: AppleDeviceDisplay; rotation: DeviceRotation };

/** Dispatches through guest HID and confirms from the lit panel in either simulator set. */
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
  const helper = createFoldHelper(device);
  let dispatchedDisplayId: number | undefined;
  let reading: LitPanel | undefined;
  for (let attempt = 1; attempt <= IOS_FOLDABLE_ORIENTATION_SETTLE_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    reading = await readLitPanel(device, helper, signal);
    if (reading?.rotation === rotation) return { orientation: rotation };
    if (reading && reading.panel.displayId !== dispatchedDisplayId) {
      const mapping = reading.panel.primary ? PANEL_PICKERS.outer : PANEL_PICKERS.inner;
      const value = mapping[rotation];
      await helper.rotate(value, signal);
      dispatchedDisplayId = reading.panel.displayId;
      emitDiagnostic({
        level: 'info',
        phase: 'apple_foldable_orientation_dispatched',
        data: {
          deviceId: device.id,
          orientation: value,
          requestedOrientation: rotation,
          scopedSet: Boolean(simulatorAddressFor(device).simulatorSetPath),
          attempt,
          observedOrientation: reading.rotation,
          litDisplay: reading.panel.name,
        },
      });
    }
    await settleRotation();
  }
  reading = await readLitPanel(device, helper, signal);
  if (reading?.rotation === rotation) return { orientation: rotation };
  throw unverifiedError(device, rotation, reading);
}

/** An undecided final read reports no rotation, even if an earlier read named one. */
function unverifiedError(
  device: DeviceInfo,
  rotation: FoldableRotation,
  reading: LitPanel | undefined,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${device.name} did not confirm rotation to ${rotation}: ${
      reading
        ? `the lit panel shows ${reading.rotation}`
        : 'the last panel table read named no single lit panel'
    }`,
    {
      deviceId: device.id,
      requestedOrientation: rotation,
      ...(reading
        ? {
            observedOrientation: reading.rotation,
            rawPanelOrientation: reading.panel.currentOrientation,
          }
        : {}),
      reason: 'orientation-unverified',
      hint: ORIENTATION_UNVERIFIED_HINT,
    },
  );
}

/**
 * The one lit panel and the rotation it shows, from one fresh panel-table read, selected by the
 * display inventory's {@link establishedLitPanel}. Anything less decided — an unreadable table,
 * an incomplete one, no lit panel or several, a panel of unknown power, an unrecognized `rotN` —
 * is no reading:
 * the rotation loop must not confirm or dispatch from a panel that is not showing.
 * On iPhone Duo the table reports both panels lit for a few seconds after a pose change in either
 * direction, so the first reads after a fold or an unfold are no reading by design.
 */
async function readLitPanel(
  device: DeviceInfo,
  helper: FoldHelper,
  signal: AbortSignal | undefined,
): Promise<LitPanel | undefined> {
  let inventory: AppleDisplayInventory;
  try {
    inventory = await queryAppleDisplayInventory(device, {
      signal,
      source: 'guest',
      foldHelper: helper,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
  const panel = establishedLitPanel(inventory);
  if (!panel) return undefined;
  const rotation = panelContentRotation(panel.currentOrientation);
  return rotation === undefined ? undefined : { panel, rotation };
}

/** The gap a dispatched picker event needs before the panel table shows its effect. */
async function settleRotation(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, IOS_FOLDABLE_ORIENTATION_SETTLE_MS);
  });
}
