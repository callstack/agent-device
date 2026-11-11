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

/**
 * Measured picker offsets by panel. The `primary` panel is the one that stays lit while the
 * device is closed (the outer panel); the other integrated panel is the inner one. A measured
 * offset only saves the calibration dispatch: the caller still confirms every rotation from
 * the panel table and re-derives the offset from what it observes, so a panel that disagrees
 * with this table still converges. An unmeasured panel returns nothing rather than a guess.
 */
export function measuredPanelPickerOffset(panel: {
  primary: boolean;
}): PanelQuarterTurn | undefined {
  // Measured on iPhone Duo: the inner panel lights at rot90 while the picker sits at portrait.
  return panel.primary ? undefined : 90;
}

/**
 * The next picker value to dispatch, in a guest that applies picker events relatively: each
 * event turns the lit panel by (new value - previous picker value), so an absolute dispatch
 * lands a panel offset away from its target. The choice is, in order:
 *
 * - Picker known: the value whose delta from the current picker value is exactly the turn
 *   still needed. Needs the current lit-panel rotation; without it there is no safe dispatch,
 *   so the caller re-reads instead (nothing is returned).
 * - Picker unknown, offset known: the value that leaves the panel at the target once the
 *   offset is added back.
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
