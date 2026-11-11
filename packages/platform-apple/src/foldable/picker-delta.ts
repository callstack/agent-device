import type { DeviceRotation } from '@agent-device/contracts/device';

/**
 * Panel-frame quarter turns, following CADisplay `rotN`: portrait 0, landscape-right 90,
 * portrait-upside-down 180, landscape-left 270. This frame is a panel-table fact, not the
 * Android `Surface.ROTATION_*` frame in `DEVICE_ROTATION_SURFACE_INDEX` (which turns the
 * other way), so the two tables must not be shared. Parsing a panel's `currentOrientation`
 * into a rotation is `panelContentRotation` in the display inventory; this module only does
 * the picker arithmetic on rotations already parsed.
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

/** The panel-frame angle of one rotation. */
function panelRotationAngle(rotation: DeviceRotation): PanelQuarterTurn {
  return PANEL_ROTATION_ANGLE[rotation];
}

/** The rotation at one panel-frame angle. The angle is normalized into one full turn. */
function rotationAtPanelAngle(angle: number): DeviceRotation {
  const quarter = (((Math.round(angle / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return ROTATION_BY_QUARTER[quarter]!;
}

/**
 * The offset between the orientation picker and the lit panel it drives: the panel reads
 * `picker + offset`. The picker value is the one this command last dispatched, and the
 * rotation is a fresh reading of the same panel taken after it.
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
 * Measured picker offsets by panel, used only before a command has calibrated the lit panel
 * with a dispatch of its own. The `primary` panel is the one that stays lit while the device
 * is closed (the outer panel); the other integrated panel is the inner one (lit open and
 * half-open). Measured on iPhone Duo (iOS 27.3) against the lit panel's `currentOrientation`:
 * the outer panel reads `picker + 0` and the inner panel `picker + 90`, across fold and unfold
 * in both directions. The guest keeps one picker value through a fold, so the panel that
 * lights afterwards reads that same value plus its own offset — unless its foreground app
 * cannot show that orientation, in which case it keeps the rotation it last showed.
 */
export function measuredPanelPickerOffset(panel: { primary: boolean }): PanelQuarterTurn {
  return panel.primary ? OUTER_PANEL_PICKER_OFFSET : INNER_PANEL_PICKER_OFFSET;
}

/**
 * The picker value that leaves the lit panel at `targetRotation` once the panel's offset is
 * added back: `target - offset`. The guest shows `picker + offset`, so dispatching the target
 * itself lands an offset away from it, which is what made a rotation look one command late.
 */
export function pickerValueForTarget(
  targetRotation: DeviceRotation,
  panelOffset: PanelQuarterTurn,
): DeviceRotation {
  return rotationAtPanelAngle(panelRotationAngle(targetRotation) - panelOffset);
}
