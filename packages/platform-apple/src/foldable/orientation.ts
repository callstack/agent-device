import type { DeviceRotation } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { createTtlMemo } from '@agent-device/kernel/ttl-memo';

import {
  IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS,
  IOS_FOLDABLE_ORIENTATION_READ_TIMEOUT_MS,
  IOS_FOLDABLE_ORIENTATION_SETTLE_ATTEMPTS,
  IOS_FOLDABLE_SCOPED_ORIENTATION_ATTEMPTS,
  IOS_FOLDABLE_SCOPED_ORIENTATION_SETTLE_MS,
} from '../core/config.ts';
import { readAppleDeviceOrientation } from '../core/device-orientation.ts';
import {
  queryAppleDisplayInventory,
  type AppleDeviceDisplay,
  type AppleDisplayInventory,
} from '../core/display-inventory.ts';
import { simulatorAddressFor } from '../core/simctl.ts';
import { createFoldHelper, type FoldHelper, type FoldableRotation } from './fold-helper.ts';
import {
  measuredPanelPickerOffset,
  nextPickerValue,
  panelPickerOffset,
  panelRotationForOrientation,
  type PanelQuarterTurn,
} from './picker-delta.ts';
import { appleFoldableFacts } from './runtime.ts';

const UPSIDE_DOWN_UNSUPPORTED_HINT =
  'A foldable simulator accepts portrait, landscape-left, and landscape-right as rotation targets.';

const ORIENTATION_UNVERIFIED_HINT =
  'The simulator HID command completed, but CoreDevice did not report the new orientation. Read it with xcrun devicectl device orientation get --device <udid>, then retry.';

const SCOPED_ORIENTATION_UNVERIFIED_HINT =
  'Rotation was dispatched through the fold helper, which needs relative-picker compensation in a scoped simulator set where CoreDevice cannot read orientation, and the lit panel did not settle on the requested orientation. Take a screenshot to see the screen, then retry.';

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

/**
 * Rotates a foldable simulator through guest HID. The default device set verifies the rotation
 * through CoreDevice; a scoped set, which CoreDevice cannot resolve, verifies it from the
 * fold helper's panel table instead (see {@link setScopedFoldableOrientation}).
 */
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
    return await setScopedFoldableOrientation(device, rotation, signal);
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

/**
 * Rotates a foldable simulator in a scoped set, where only the fold helper can dispatch and
 * only its panel table can confirm. Measured on iPhone Duo, the lit panel reads the
 * `orientation-picker-control` value plus a fixed per-panel offset (outer panel 0, inner
 * panel +90), so one absolute dispatch of the target lands a quarter-turn away on the inner
 * panel and looks one command late. This loop reads the lit panel, dispatches the picker
 * value {@link nextPickerValue} chooses, and re-reads until the panel table reports the
 * target: one dispatch when the lit panel's offset is the measured one, at most two when the
 * first dispatch has to calibrate it. A repeat of the showing orientation is a read-only
 * success. The picker state is deliberately not kept between commands: a fold in between can
 * light the other panel, whose offset differs, and the measured offset covers that case.
 */
async function setScopedFoldableOrientation(
  device: DeviceInfo,
  rotation: FoldableRotation,
  signal: AbortSignal | undefined,
): Promise<{ orientation: DeviceRotation }> {
  const helper = createFoldHelper(device);
  const state: ScopedRotationState = {
    pickerValue: undefined,
    panelOffset: undefined,
    litDisplayId: undefined,
    observed: undefined,
    rawPanelOrientation: undefined,
  };
  for (let attempt = 1; attempt <= IOS_FOLDABLE_SCOPED_ORIENTATION_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const lit = await readLitPanel(device, helper, signal);
    if (lit) {
      noteLitPanel(state, lit);
      if (state.observed === rotation) return { orientation: rotation };
    }
    const next = nextPickerValue({
      currentRotation: lit?.rotation,
      targetRotation: rotation,
      panelOffset: state.panelOffset,
      currentPickerValue: state.pickerValue,
    });
    if (next !== undefined) {
      await dispatchScopedPicker(device, helper, state, next, rotation, attempt, signal);
    }
    await settleScopedRotation();
  }
  // The last dispatch gets its confirming read too: the loop only reads before dispatching.
  const settled = await readLitPanel(device, helper, signal);
  if (settled) noteLitPanel(state, settled);
  if (state.observed === rotation) return { orientation: rotation };
  throw scopedUnverifiedError(device, rotation, state);
}

type ScopedRotationState = {
  pickerValue: DeviceRotation | undefined;
  panelOffset: PanelQuarterTurn | undefined;
  litDisplayId: number | undefined;
  observed: DeviceRotation | undefined;
  rawPanelOrientation: string | undefined;
};

type LitPanel = { panel: AppleDeviceDisplay; rotation: DeviceRotation };

/**
 * Folds one lit-panel reading into the rotation state. A different panel lit up mid-command:
 * the picker state and offset were calibrated against the previous panel, so start that
 * panel's calibration over. Otherwise the reading fixes the panel's offset — from the picker
 * value this command dispatched when there is one, else from the measured table.
 */
function noteLitPanel(state: ScopedRotationState, lit: LitPanel): void {
  if (state.litDisplayId !== undefined && lit.panel.displayId !== state.litDisplayId) {
    state.pickerValue = undefined;
    state.panelOffset = undefined;
  }
  state.litDisplayId = lit.panel.displayId;
  state.observed = lit.rotation;
  state.rawPanelOrientation = lit.panel.currentOrientation;
  state.panelOffset =
    state.pickerValue === undefined
      ? (state.panelOffset ?? measuredPanelPickerOffset(lit.panel))
      : panelPickerOffset(lit.rotation, state.pickerValue);
}

/** Dispatches one picker value and records it as the guest's picker state for this command. */
async function dispatchScopedPicker(
  device: DeviceInfo,
  helper: FoldHelper,
  state: ScopedRotationState,
  next: DeviceRotation,
  rotation: FoldableRotation,
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  await helper.rotate(next, signal);
  state.pickerValue = next;
  emitDiagnostic({
    level: 'info',
    phase: 'apple_foldable_orientation_dispatched',
    data: {
      deviceId: device.id,
      orientation: next,
      requestedOrientation: rotation,
      scopedSet: true,
      attempt,
      ...(state.observed === undefined ? {} : { observedOrientation: state.observed }),
    },
  });
}

function scopedUnverifiedError(
  device: DeviceInfo,
  rotation: FoldableRotation,
  state: ScopedRotationState,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${device.name} did not confirm rotation to ${rotation}: the panel table reports ${state.observed ?? 'no orientation'}`,
    {
      deviceId: device.id,
      requestedOrientation: rotation,
      ...(state.observed === undefined ? {} : { observedOrientation: state.observed }),
      ...(state.rawPanelOrientation === undefined
        ? {}
        : { rawPanelOrientation: state.rawPanelOrientation }),
      reason: 'orientation-unverified-scoped-set',
      hint: SCOPED_ORIENTATION_UNVERIFIED_HINT,
    },
  );
}

/**
 * The one lit panel and the rotation it shows, from one fresh panel-table read. Anything
 * less decided — an unreadable table, no lit panel, an unrecognized `rotN` — is no reading:
 * the rotation loop must not confirm or compensate from a panel that is not showing. On
 * iPhone Duo the table reports both panels lit for a few seconds after a fold to closed, so
 * the first reads after that fold are no reading by design.
 */
async function readLitPanel(
  device: DeviceInfo,
  helper: FoldHelper,
  signal: AbortSignal | undefined,
): Promise<LitPanel | undefined> {
  let inventory: AppleDisplayInventory;
  try {
    inventory = await queryAppleDisplayInventory(device, { signal, foldHelper: helper });
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
  if (inventory.unresolved || !inventory.multiScreen) return undefined;
  const litPanels = inventory.displays.filter((display) => display.power === 'lit');
  const panel = litPanels.length === 1 ? litPanels[0]! : undefined;
  if (!panel) return undefined;
  const rotation = panelRotationForOrientation(panel.currentOrientation);
  return rotation === undefined ? undefined : { panel, rotation };
}

/** The gap a dispatched picker event needs before the panel table shows its effect. */
async function settleScopedRotation(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, IOS_FOLDABLE_SCOPED_ORIENTATION_SETTLE_MS);
  });
}
