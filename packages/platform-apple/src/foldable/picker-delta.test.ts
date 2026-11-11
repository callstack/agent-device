import { expect, test } from 'vitest';
import type { DeviceRotation } from '@agent-device/contracts/device';
import {
  measuredPanelPickerOffset,
  nextPickerValue,
  panelPickerOffset,
  panelRotationAngle,
  panelRotationForOrientation,
  rotationAtPanelAngle,
  type PanelQuarterTurn,
} from './picker-delta.ts';

const ROTATIONS: readonly DeviceRotation[] = [
  'portrait',
  'landscape-right',
  'portrait-upside-down',
  'landscape-left',
];
const OFFSETS: readonly PanelQuarterTurn[] = [0, 90, 180, 270];

/** Applies one picker event the way the guest does: the panel turns by (new - previous). */
function applyPickerEvent(
  screen: DeviceRotation,
  previousPicker: DeviceRotation,
  nextPicker: DeviceRotation,
): DeviceRotation {
  return rotationAtPanelAngle(
    panelRotationAngle(screen) +
      panelRotationAngle(nextPicker) -
      panelRotationAngle(previousPicker),
  );
}

test('panel angles follow CADisplay rotN in both directions', () => {
  expect(ROTATIONS.map(panelRotationAngle)).toEqual([0, 90, 180, 270]);
  for (const rotation of ROTATIONS) {
    expect(rotationAtPanelAngle(panelRotationAngle(rotation))).toBe(rotation);
    expect(rotationAtPanelAngle(panelRotationAngle(rotation) + 360)).toBe(rotation);
    expect(rotationAtPanelAngle(panelRotationAngle(rotation) - 360)).toBe(rotation);
  }
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
          // The offset observed after the dispatch is still the guest's own relation:
          // re-deriving it from the landed state must give a consistent quarter turn.
          expect(panelPickerOffset(target, next!)).toBe(
            ((panelRotationAngle(target) - panelRotationAngle(next!) + 360) %
              360) as PanelQuarterTurn,
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
        const current = rotationAtPanelAngle(panelRotationAngle(picker) + offset);
        const next = nextPickerValue({
          currentRotation: current,
          targetRotation: target,
          panelOffset: offset,
          currentPickerValue: undefined,
        });
        expect(next).toBe(rotationAtPanelAngle(panelRotationAngle(target) - offset));
        expect(applyPickerEvent(current, picker, next!)).toBe(target);
      }
    }
  }
});

test('with neither known, the calibration dispatch plus one delta dispatch lands every state', () => {
  for (const target of ROTATIONS) {
    for (const offset of OFFSETS) {
      for (const picker of ROTATIONS) {
        const start = rotationAtPanelAngle(panelRotationAngle(picker) + offset);
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
