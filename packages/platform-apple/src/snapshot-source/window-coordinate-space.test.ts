import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Point, Rect } from '@agent-device/kernel/snapshot';
import {
  isQuarterTurnedWindowFrame,
  WINDOW_QUARTER_TURN_TOLERANCE,
} from './window-coordinate-space.ts';

// ADR 0011 Layer 2 golden parity table (#2612): the SAME JSON is asserted against the Swift twin
// (SnapshotGeometrySpace and CoordinateSpaceRotation in
// apple/snapshot-presentation/Sources/AgentDeviceSnapshotPresentation/SnapshotCoordinateSpace.swift,
// replayed by that package's CoordinateSpaceTests), so drift between the host's decoder and the
// runner's capture turns CI red on whichever side changed.

type FixtureFrame =
  | {
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | { infinite: true };

type QuarterTurnCase = {
  name: string;
  window: FixtureFrame;
  app: FixtureFrame;
  quarterTurned: boolean;
};

type RotationCase = {
  name: string;
  interfaceOrientation: number;
  app: FixtureFrame;
  native: FixtureFrame;
  oriented: FixtureFrame;
};

type Fixture = {
  constants: { quarterTurnTolerance: number };
  quarterTurnCases: QuarterTurnCase[];
  rotationCases: RotationCase[];
};

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'window-coordinate-space.json',
);

function loadTable(): Fixture {
  return JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as Fixture;
}

/**
 * The box a platform hands back when it resolved none — the table's spelling of `CGRect.infinite`,
 * which JSON has no literal for.
 */
const INFINITE_RECT: Rect = {
  x: Number.NEGATIVE_INFINITY,
  y: Number.NEGATIVE_INFINITY,
  width: Number.POSITIVE_INFINITY,
  height: Number.POSITIVE_INFINITY,
};

function toRect(frame: FixtureFrame): Rect {
  return 'infinite' in frame ? INFINITE_RECT : frame;
}

function assertUniqueNames(names: readonly string[], scope: string): void {
  assert.equal(new Set(names).size, names.length, `${scope} case names must be unique`);
}

test('the quarter-turn window rule agrees with every golden parity table case', () => {
  const table = loadTable();
  assert.ok(table.quarterTurnCases.length > 0, 'parity table must not be empty');
  assert.ok(table.rotationCases.length > 0, 'parity table must not be empty');
  assertUniqueNames(
    [...table.quarterTurnCases, ...table.rotationCases].map((fixture) => fixture.name),
    'parity table',
  );
  for (const fixture of table.quarterTurnCases) {
    assert.equal(
      isQuarterTurnedWindowFrame(toRect(fixture.window), toRect(fixture.app)),
      fixture.quarterTurned,
      fixture.name,
    );
  }
});

test('the quarter-turn tolerance belongs to the table, not this file', () => {
  assert.equal(loadTable().constants.quarterTurnTolerance, WINDOW_QUARTER_TURN_TOLERANCE);
});

const PORTRAIT_UPSIDE_DOWN = 2;
const LANDSCAPE_RIGHT = 3;
const LANDSCAPE_LEFT = 4;

/**
 * The dispatch direction — an app-space point in the native space a synthesized event is performed in
 * — as the runner's own `CoordinateSpaceRotation.native(point:in:interfaceOrientation:)` computes it.
 *
 * The capture's inverse is NOT implemented here: it lives in Swift alone, and a TypeScript copy of it
 * would prove nothing about the code that runs. What this proves is that the table cannot be edited
 * into an `oriented` box that is not the exact inverse of its own `native` box, in either direction of
 * the quarter turn. The other half of that proof is the Swift XCTest replaying these same rows through
 * `CoordinateSpaceRotation.oriented(rect:in:interfaceOrientation:)` and round-tripping that against the
 * forward map it ships with.
 */
function nativePoint(point: Point, app: Rect, interfaceOrientation: number): Point {
  const localX = point.x - app.x;
  const localY = point.y - app.y;
  switch (interfaceOrientation) {
    case LANDSCAPE_RIGHT:
      return { x: app.height - localY, y: localX };
    case LANDSCAPE_LEFT:
      return { x: localY, y: app.width - localX };
    case PORTRAIT_UPSIDE_DOWN:
      return { x: app.width - localX, y: app.height - localY };
    default:
      return { x: localX, y: localY };
  }
}

/** The same opposite-corner turn the capture's rect helper runs, so both halves order corners alike. */
function nativeRect(rect: Rect, app: Rect, interfaceOrientation: number): Rect {
  const leading = nativePoint({ x: rect.x, y: rect.y }, app, interfaceOrientation);
  const trailing = nativePoint(
    { x: rect.x + rect.width, y: rect.y + rect.height },
    app,
    interfaceOrientation,
  );
  return {
    x: Math.min(leading.x, trailing.x),
    y: Math.min(leading.y, trailing.y),
    width: Math.abs(trailing.x - leading.x),
    height: Math.abs(trailing.y - leading.y),
  };
}

test('every rotation row is the exact inverse of the box it was measured as', () => {
  for (const fixture of loadTable().rotationCases) {
    const app = toRect(fixture.app);
    assert.deepEqual(
      nativeRect(toRect(fixture.oriented), app, fixture.interfaceOrientation),
      toRect(fixture.native),
      fixture.name,
    );
  }
});
