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

test('the measured inner-panel offset is +90 and the outer panel is never guessed', () => {
  expect(measuredPanelPickerOffset({ primary: false })).toBe(90);
  expect(measuredPanelPickerOffset({ primary: true })).toBeUndefined();
});
