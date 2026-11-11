import { expect, test } from 'vitest';
import type { DeviceRotation } from '@agent-device/contracts/device';
import {
  measuredPanelPickerOffset,
  nextPickerValue,
  panelPickerOffset,
  panelRotationForOrientation,
  type PanelQuarterTurn,
} from './picker-delta.ts';

const ROTATIONS: readonly DeviceRotation[] = [
  'portrait',
  'landscape-right',
  'portrait-upside-down',
  'landscape-left',
];
const OFFSETS: readonly PanelQuarterTurn[] = [0, 90, 180, 270];

/** The measured guest model in CADisplay `rotN` angles, stated here independently of the code. */
const ANGLE: Record<DeviceRotation, number> = {
  portrait: 0,
  'landscape-right': 90,
  'portrait-upside-down': 180,
  'landscape-left': 270,
};
const AT_ANGLE: readonly DeviceRotation[] = ROTATIONS;

function atAngle(angle: number): DeviceRotation {
  return AT_ANGLE[(((angle / 90) % 4) + 4) % 4]!;
}

/** Applies one picker event the way the guest does: the panel turns by (new - previous). */
function applyPickerEvent(
  screen: DeviceRotation,
  previousPicker: DeviceRotation,
  nextPicker: DeviceRotation,
): DeviceRotation {
  return atAngle(ANGLE[screen] + ANGLE[nextPicker] - ANGLE[previousPicker]);
}

test('panel table orientations read as panel-frame rotations', () => {
  expect(panelRotationForOrientation('rot0')).toBe('portrait');
  expect(panelRotationForOrientation('rot90')).toBe('landscape-right');
  expect(panelRotationForOrientation('rot180')).toBe('portrait-upside-down');
  expect(panelRotationForOrientation('rot270')).toBe('landscape-left');
  expect(panelRotationForOrientation('unknown')).toBeUndefined();
});

test('with the picker known, one dispatch lands every current/target/offset/picker state', () => {
  for (const current of ROTATIONS) {
    for (const target of ROTATIONS) {
      for (const offset of OFFSETS) {
        for (const picker of ROTATIONS) {
          const next = nextPickerValue({
            currentRotation: current,
            targetRotation: target,
            panelOffset: offset,
            currentPickerValue: picker,
          });
          expect(next, `${current} -> ${target}, K=${offset}, picker=${picker}`).toBeDefined();
          expect(applyPickerEvent(current, picker, next!)).toBe(target);
          expect(panelPickerOffset(target, next!)).toBe(
            ((ANGLE[target] - ANGLE[next!] + 360) % 360) as PanelQuarterTurn,
          );
        }
      }
    }
  }
});

test('with only the offset known, one dispatch lands every consistent state', () => {
  for (const target of ROTATIONS) {
    for (const offset of OFFSETS) {
      for (const picker of ROTATIONS) {
        // A consistent guest state: the panel reads picker + offset.
        const current = atAngle(ANGLE[picker] + offset);
        const next = nextPickerValue({
          currentRotation: current,
          targetRotation: target,
          panelOffset: offset,
          currentPickerValue: undefined,
        });
        expect(next).toBe(atAngle(ANGLE[target] - offset));
        expect(applyPickerEvent(current, picker, next!)).toBe(target);
      }
    }
  }
});

test('with neither known, the calibration dispatch plus one delta dispatch lands every state', () => {
  for (const target of ROTATIONS) {
    for (const offset of OFFSETS) {
      for (const picker of ROTATIONS) {
        const start = atAngle(ANGLE[picker] + offset);
        const calibration = nextPickerValue({
          currentRotation: start,
          targetRotation: target,
          panelOffset: undefined,
          currentPickerValue: undefined,
        });
        expect(calibration).toBe(target);
        const afterCalibration = applyPickerEvent(start, picker, calibration!);
        if (afterCalibration === target) continue;
        const learned = panelPickerOffset(afterCalibration, calibration!);
        expect(learned).toBe(offset);
        const correction = nextPickerValue({
          currentRotation: afterCalibration,
          targetRotation: target,
          panelOffset: learned,
          currentPickerValue: calibration,
        });
        expect(applyPickerEvent(afterCalibration, calibration!, correction!)).toBe(target);
      }
    }
  }
});

test('without a current rotation there is no dispatch once the picker is known', () => {
  for (const target of ROTATIONS) {
    for (const picker of ROTATIONS) {
      expect(
        nextPickerValue({
          currentRotation: undefined,
          targetRotation: target,
          panelOffset: 90,
          currentPickerValue: picker,
        }),
      ).toBeUndefined();
    }
  }
});

test('the measured offsets are 0 on the outer (primary) panel and +90 on the inner panel', () => {
  expect(measuredPanelPickerOffset({ primary: true })).toBe(0);
  expect(measuredPanelPickerOffset({ primary: false })).toBe(90);
});

/**
 * Raw iPhone Duo readings (iOS 27.3, scoped simulator set, Safari in front), in the order they
 * were taken: the picker value the guest held and the lit panel's `currentOrientation` that the
 * panel table reported next. Rows marked `fold` are the first read after a pose change, with
 * the picker value from before it. Every row gives its panel's measured offset, so the picker
 * value survives a fold in both directions and only the panel's offset changes.
 */
const DUO_READINGS: readonly {
  panel: 'inner' | 'outer';
  picker: DeviceRotation;
  reading: string;
  fold?: true;
}[] = [
  { panel: 'inner', picker: 'portrait', reading: 'rot90' },
  { panel: 'inner', picker: 'landscape-left', reading: 'rot0' },
  { panel: 'inner', picker: 'landscape-left', reading: 'rot0' },
  { panel: 'inner', picker: 'portrait-upside-down', reading: 'rot270' },
  { panel: 'inner', picker: 'landscape-right', reading: 'rot180' },
  { panel: 'inner', picker: 'portrait', reading: 'rot90' },
  { panel: 'inner', picker: 'portrait', reading: 'rot90' },
  { panel: 'inner', picker: 'landscape-left', reading: 'rot0' },
  { panel: 'outer', picker: 'landscape-left', reading: 'rot270', fold: true },
  { panel: 'outer', picker: 'portrait', reading: 'rot0' },
  { panel: 'outer', picker: 'landscape-left', reading: 'rot270' },
  { panel: 'outer', picker: 'landscape-right', reading: 'rot90' },
  { panel: 'outer', picker: 'portrait', reading: 'rot0' },
  { panel: 'outer', picker: 'landscape-left', reading: 'rot270' },
  { panel: 'inner', picker: 'landscape-left', reading: 'rot0', fold: true },
  { panel: 'inner', picker: 'landscape-right', reading: 'rot180' },
  { panel: 'inner', picker: 'portrait', reading: 'rot90' },
  { panel: 'inner', picker: 'landscape-left', reading: 'rot0' },
  { panel: 'inner', picker: 'portrait-upside-down', reading: 'rot270' },
  // (fold to closed with the picker at portrait-upside-down: see the next test)
  { panel: 'outer', picker: 'landscape-right', reading: 'rot90' },
  { panel: 'outer', picker: 'portrait', reading: 'rot0' },
  { panel: 'outer', picker: 'landscape-right', reading: 'rot90' },
  { panel: 'inner', picker: 'landscape-right', reading: 'rot180', fold: true },
  { panel: 'inner', picker: 'portrait', reading: 'rot90' },
  { panel: 'inner', picker: 'landscape-left', reading: 'rot0' },
  { panel: 'inner', picker: 'landscape-right', reading: 'rot180' },
  { panel: 'inner', picker: 'portrait', reading: 'rot90' },
  { panel: 'outer', picker: 'portrait', reading: 'rot0', fold: true },
  { panel: 'outer', picker: 'landscape-left', reading: 'rot270' },
  { panel: 'inner', picker: 'landscape-left', reading: 'rot0', fold: true },
  { panel: 'inner', picker: 'landscape-right', reading: 'rot180' },
  { panel: 'inner', picker: 'portrait', reading: 'rot90' },
];

test('every measured Duo reading gives its panel the measured offset, across folds', () => {
  for (const [index, row] of DUO_READINGS.entries()) {
    const reading = panelRotationForOrientation(row.reading);
    expect(reading, `row ${index}`).toBeDefined();
    expect(panelPickerOffset(reading!, row.picker), `row ${index}`).toBe(
      measuredPanelPickerOffset({ primary: row.panel === 'outer' }),
    );
  }
  expect(DUO_READINGS.filter((row) => row.fold)).toHaveLength(5);
});

test('after a fold that left the picker where the outer panel could not follow, the measured offset still lands the target', () => {
  // Measured: picker at portrait-upside-down, outer panel lit showing landscape-left (its UI has
  // no upside-down). One dispatch of landscape-right landed landscape-right. A purely relative
  // guest would have turned the panel by (90 - 180) to portrait-upside-down instead.
  const next = nextPickerValue({
    currentRotation: 'landscape-left',
    targetRotation: 'landscape-right',
    panelOffset: measuredPanelPickerOffset({ primary: true }),
    currentPickerValue: undefined,
  });
  expect(next).toBe('landscape-right');
});
