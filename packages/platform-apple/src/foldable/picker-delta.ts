import type { DeviceRotation } from '@agent-device/contracts/device';

/**
 * Panel-frame quarter turns, following CADisplay `rotN`: portrait 0, landscape-right 90,
 * portrait-upside-down 180, landscape-left 270. This frame is a panel-table fact, not the
 * Android `Surface.ROTATION_*` frame in `DEVICE_ROTATION_SURFACE_INDEX` (which turns the
 * other way), so the two tables must not be shared.
 */
export type PanelQuarterTurn = 0 | 90 | 180 | 270;

const PANEL_ROTATION_ANGLE: Readonly<Record<DeviceRotation, PanelQuarterTurn>> = {
  portrait: 0,
  'landscape-right': 90,
  'portrait-upside-down': 180,
  'landscape-left': 270,
};

const ROTATION_BY_QUARTER: readonly DeviceRotation[] = [
  'portrait',
  'landscape-right',
  'portrait-upside-down',
  'landscape-left',
];

const PANEL_ORIENTATIONS: ReadonlyMap<string, DeviceRotation> = new Map([
  ['rot0', 'portrait'],
  ['rot90', 'landscape-right'],
  ['rot180', 'portrait-upside-down'],
  ['rot270', 'landscape-left'],
]);

/** The panel-frame angle of one rotation. */
function panelRotationAngle(rotation: DeviceRotation): PanelQuarterTurn {
  return PANEL_ROTATION_ANGLE[rotation];
}

/** The rotation at one panel-frame angle. The angle is normalized into one full turn. */
function rotationAtPanelAngle(angle: number): DeviceRotation {
  const quarter = (((Math.round(angle / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return ROTATION_BY_QUARTER[quarter]!;
}

/** The lit-panel rotation a panel table `currentOrientation` names, or nothing when unread. */
export function panelRotationForOrientation(
  currentOrientation: string,
): DeviceRotation | undefined {
  return PANEL_ORIENTATIONS.get(currentOrientation);
}

/**
 * The offset between the orientation picker and the lit panel it drives: the panel reads
 * `picker + offset`. Learning it from one dispatched picker value and the panel rotation
 * that followed it is what calibrates a panel whose offset was never measured.
 */
export function panelPickerOffset(
  currentRotation: DeviceRotation,
  pickerValue: DeviceRotation,
): PanelQuarterTurn {
  const angle = (panelRotationAngle(currentRotation) - panelRotationAngle(pickerValue) + 360) % 360;
  return angle as PanelQuarterTurn;
}

/** Outer-panel offset, measured on iPhone Duo: the outer panel reads the picker value itself. */
const OUTER_PANEL_PICKER_OFFSET: PanelQuarterTurn = 0;
/** Inner-panel offset, measured on iPhone Duo: it lights at rot90 while the picker sits at portrait. */
const INNER_PANEL_PICKER_OFFSET: PanelQuarterTurn = 90;

/**
 * Measured picker offsets by panel. The `primary` panel is the one that stays lit while the
 * device is closed (the outer panel); the other integrated panel is the inner one (lit open
 * and half-open). Measured on iPhone Duo (iOS 27.3) against the panel table's lit-panel
 * `currentOrientation`: the outer panel reads `picker + 0` and the inner panel `picker + 90`,
 * across fold/unfold in both directions. The guest keeps one picker value through a fold, so
 * the panel that lights afterwards reads that same value plus its own offset.
 *
 * A measured offset only saves the calibration dispatch: the caller still confirms every
 * rotation from the panel table and re-derives the offset from what it observes after each
 * dispatch, so a panel or runtime that disagrees with this table still converges.
 */
export function measuredPanelPickerOffset(panel: { primary: boolean }): PanelQuarterTurn {
  return panel.primary ? OUTER_PANEL_PICKER_OFFSET : INNER_PANEL_PICKER_OFFSET;
}

/**
 * The next picker value to dispatch. The guest shows `picker + offset` on the lit panel, with
 * a fixed offset per panel, so an absolute dispatch of the target lands an offset away from
 * it, and successive events look as if each one turned the panel by (new value - previous
 * picker value). The choice is, in order:
 *
 * - Picker known: the value whose delta from the current picker value is exactly the turn
 *   still needed. Needs the current lit-panel rotation; without it there is no safe dispatch,
 *   so the caller re-reads instead (nothing is returned).
 * - Picker unknown, offset known: the value that leaves the panel at the target once the
 *   offset is added back. This holds even when the lit panel is not showing `picker + offset`
 *   yet, for example after a fold left the picker at a value the newly lit panel's
 *   foreground UI does not show.
 * - Both unknown: the target itself, as a calibration dispatch. Wherever it lands, one panel
 *   read afterwards fixes the offset through {@link panelPickerOffset}, and the next dispatch
 *   is exact.
 */
export function nextPickerValue(input: {
  currentRotation: DeviceRotation | undefined;
  targetRotation: DeviceRotation;
  panelOffset: PanelQuarterTurn | undefined;
  currentPickerValue: DeviceRotation | undefined;
}): DeviceRotation | undefined {
  const { currentRotation, targetRotation, panelOffset, currentPickerValue } = input;
  if (currentPickerValue !== undefined) {
    if (currentRotation === undefined) return undefined;
    return rotationAtPanelAngle(
      panelRotationAngle(currentPickerValue) +
        panelRotationAngle(targetRotation) -
        panelRotationAngle(currentRotation),
    );
  }
  if (panelOffset !== undefined) {
    return rotationAtPanelAngle(panelRotationAngle(targetRotation) - panelOffset);
  }
  return targetRotation;
}
