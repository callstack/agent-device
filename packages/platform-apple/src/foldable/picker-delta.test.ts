import { expect, test } from 'vitest';
import type { DeviceRotation } from '@agent-device/contracts/device';
import { panelContentRotation } from '../core/display-inventory.ts';
import {
  measuredPanelPickerOffset,
  panelPickerOffset,
  pickerValueForTarget,
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

function atAngle(angle: number): DeviceRotation {
  return ROTATIONS[(((angle / 90) % 4) + 4) % 4]!;
}

/** The lit panel after one picker event, as measured: the picker value plus the panel offset. */
function litPanelFor(picker: DeviceRotation, offset: number): DeviceRotation {
  return atAngle(ANGLE[picker] + offset);
}

test('the target minus the offset lands every target at every offset in one dispatch', () => {
  for (const target of ROTATIONS) {
    for (const offset of OFFSETS) {
      const value = pickerValueForTarget(target, offset);
      expect(litPanelFor(value, offset), `${target}, K=${offset}`).toBe(target);
    }
  }
});

test('a panel whose offset differs from the measured one lands on the dispatch its reading calibrates', () => {
  for (const target of ROTATIONS) {
    for (const actual of OFFSETS) {
      for (const measured of OFFSETS) {
        const first = pickerValueForTarget(target, measured);
        const reading = litPanelFor(first, actual);
        if (reading === target) continue;
        const learned = panelPickerOffset(reading, first);
        expect(learned).toBe(actual);
        expect(litPanelFor(pickerValueForTarget(target, learned), actual)).toBe(target);
      }
    }
  }
});

test('the inner panel reaches landscape-left only through the upside-down picker value', () => {
  expect(pickerValueForTarget('landscape-left', 90)).toBe('portrait-upside-down');
  expect(pickerValueForTarget('portrait', 90)).toBe('landscape-left');
  expect(pickerValueForTarget('landscape-right', 90)).toBe('portrait');
});

test('the measured offsets are 0 on the outer (primary) panel and +90 on the inner panel', () => {
  expect(measuredPanelPickerOffset({ primary: true })).toBe(0);
  expect(measuredPanelPickerOffset({ primary: false })).toBe(90);
});

/**
 * Every iPhone Duo reading taken for the measurement (iOS 27.3, scoped simulator set, Safari in
 * front), in order: the picker value the guest held and the lit panel's `currentOrientation`
 * that the panel table reported next. Rows marked `fold` are the first read after a pose change,
 * with the picker value from before it. One row contradicts the outer panel's offset and is kept
 * with its `exception`: a fold left the picker at the upside-down value, which the outer panel's
 * foreground app cannot show, so that panel kept the rotation it last showed.
 */
const DUO_READINGS: readonly {
  panel: 'inner' | 'outer';
  picker: DeviceRotation;
  reading: string;
  fold?: true;
  exception?: string;
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
  {
    panel: 'outer',
    picker: 'portrait-upside-down',
    reading: 'rot270',
    fold: true,
    exception: 'the outer panel app has no upside-down; the panel kept landscape-left',
  },
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

test('every measured Duo reading but the marked exception gives its panel the measured offset', () => {
  for (const [index, row] of DUO_READINGS.entries()) {
    const reading = panelContentRotation(row.reading);
    expect(reading, `row ${index}`).toBeDefined();
    const offset = panelPickerOffset(reading!, row.picker);
    const measured = measuredPanelPickerOffset({ primary: row.panel === 'outer' });
    if (row.exception) expect(offset, `row ${index}`).not.toBe(measured);
    else expect(offset, `row ${index}`).toBe(measured);
  }
  expect(DUO_READINGS).toHaveLength(33);
  expect(DUO_READINGS.filter((row) => row.fold)).toHaveLength(6);
  expect(DUO_READINGS.filter((row) => row.exception)).toHaveLength(1);
});

test('after the exception, the measured outer offset still lands the next target in one dispatch', () => {
  // Measured: picker at portrait-upside-down, outer panel lit showing landscape-left. One
  // dispatch of landscape-right landed landscape-right (the row after the exception). A purely
  // relative guest would have turned the panel by (90 - 180) to portrait-upside-down instead.
  expect(
    pickerValueForTarget('landscape-right', measuredPanelPickerOffset({ primary: true })),
  ).toBe('landscape-right');
});
