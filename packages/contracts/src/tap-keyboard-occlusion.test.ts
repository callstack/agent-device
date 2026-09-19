import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type {
  RawSnapshotNode,
  Rect,
  SnapshotKeyboardBandFact,
} from '@agent-device/kernel/snapshot';
import {
  resolveKeyboardTapOcclusion,
  TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS,
  TAP_KEYBOARD_OCCLUDES_TARGET_REASON,
} from './tap-keyboard-occlusion.ts';
import { resolveRectCenter } from '@agent-device/kernel/rect-center';

type FixtureNode = {
  index: number;
  type?: string;
  role?: string;
  label?: string;
  identifier?: string;
  bundleId?: string;
  parentIndex?: number;
  rect?: Rect;
};

type FixtureCase = {
  name: string;
  viewport: Rect | null;
  nodes: FixtureNode[];
  target: { index: number } | { point: { x: number; y: number } };
  expected: { kind: string; frame?: Rect; controlRects?: readonly Rect[] };
};

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'tap-keyboard-occlusion-policy.json',
);

function loadTable(): { constants: { occlusionReason: string }; cases: FixtureCase[] } {
  return JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as {
    constants: { occlusionReason: string };
    cases: FixtureCase[];
  };
}

function resolveCenter(node: FixtureNode | undefined): { x: number; y: number } {
  const center = node ? resolveRectCenter(node.rect) : null;
  assert.ok(center, 'fixture target node must carry a usable rect');
  return center;
}

test('keyboard tap occlusion agrees with every golden parity table case', () => {
  const table = loadTable();
  assert.ok(table.cases.length > 0, 'parity table must not be empty');
  const names = new Set(table.cases.map((fixture) => fixture.name));
  assert.equal(names.size, table.cases.length, 'parity table case names must be unique');
  for (const fixture of table.cases) {
    const nodes = fixture.nodes as RawSnapshotNode[];
    const byIndex = new Map(nodes.map((node) => [node.index, node]));
    const node = 'index' in fixture.target ? (byIndex.get(fixture.target.index) ?? null) : null;
    const point =
      'point' in fixture.target
        ? fixture.target.point
        : resolveCenter(byIndex.get(fixture.target.index));
    const occlusion = resolveKeyboardTapOcclusion({
      nodes,
      viewport: fixture.viewport,
      point,
      node,
    });
    assert.equal(occlusion.kind, fixture.expected.kind, fixture.name);
    const surface =
      occlusion.kind === 'clear' || occlusion.kind === 'occluded' ? occlusion.surface : null;
    if (!surface) {
      assert.equal(fixture.expected.frame, undefined, `${fixture.name}: no band to declare`);
      assert.equal(
        fixture.expected.controlRects,
        undefined,
        `${fixture.name}: no controls to declare`,
      );
      continue;
    }
    // A case that reaches a band owes its whole shape: the frame both the refusal and the disclosure
    // quote, and the controls that excuse a bare coordinate. Plane exclusion hides in the second one.
    assert.ok(
      fixture.expected.frame,
      `${fixture.name}: a verdict carrying a band must declare its frame`,
    );
    assert.ok(
      fixture.expected.controlRects,
      `${fixture.name}: a verdict carrying a band must declare its control rects`,
    );
    assert.deepEqual(surface.frame, fixture.expected.frame, `${fixture.name}: band frame`);
    assert.deepEqual(
      [...surface.controlRects],
      fixture.expected.controlRects,
      `${fixture.name}: keyboard control rects`,
    );
  }
});

test('the refusal reason belongs to the table, not this file', () => {
  assert.equal(loadTable().constants.occlusionReason, TAP_KEYBOARD_OCCLUDES_TARGET_REASON);
  assert.equal(TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS.reason, TAP_KEYBOARD_OCCLUDES_TARGET_REASON);
  assert.match(TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS.hint, /keyboard enter/);
  assert.match(TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS.hint, /dismiss key/);
  assert.match(TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS.hint, /snapshot -i/);
});

// The producer-measured band (#2660). Every case here is a golden-table tree, because the point is
// what changes about a decision the table already pins — not a new geometry to believe.

function tableCase(name: string): FixtureCase {
  const found = loadTable().cases.find((fixture) => fixture.name === name);
  assert.ok(found, `parity table has no case named ${name}`);
  return found;
}

function resolveWithFact(
  fixture: FixtureCase,
  keyboard: SnapshotKeyboardBandFact,
): ReturnType<typeof resolveKeyboardTapOcclusion> {
  const nodes = fixture.nodes as RawSnapshotNode[];
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const node = 'index' in fixture.target ? (byIndex.get(fixture.target.index) ?? null) : null;
  const point =
    'point' in fixture.target
      ? fixture.target.point
      : resolveCenter(byIndex.get(fixture.target.index));
  return resolveKeyboardTapOcclusion({
    nodes,
    viewport: fixture.viewport,
    point,
    node,
    keyboard,
  });
}

test('a measured band decides the tap the unnormalized landscape tree could not', () => {
  // The #2612 shape: a landscape keyboard whose capture normalized no coordinate space, which the
  // width rule refuses to measure at all. `visibleKeyboardFrame` answers that screen as a 874 x 204
  // band docked at y 198, and that is the whole of what the guard needs — no rule about the tree's
  // geometry runs, because a band the producer measured did not come from the tree.
  const fixture = tableCase(
    'a landscape keyboard from a capture that normalized no coordinate space cannot be measured',
  );
  const landscapeBand: SnapshotKeyboardBandFact = {
    kind: 'visible',
    frame: { x: 0, y: 198, width: 874, height: 204 },
  };

  assert.equal(resolveWithFact(fixture, landscapeBand).kind, 'occluded');
  assert.deepEqual(
    (resolveWithFact(fixture, landscapeBand) as { surface: { frame: Rect } }).surface.frame,
    landscapeBand.frame,
  );
});

test('a measured band is the band, even in a tree that reports no keyboard at all', () => {
  // The tree rule's answer here is `no-keyboard`. A refusal off a tree with no key nodes can only
  // have come from the fact, which is the assertion that the rule was not consulted at all.
  const fixture = tableCase('no keyboard in the tree means nothing to refuse');
  assert.equal(fixture.expected.kind, 'no-keyboard');
  const band: SnapshotKeyboardBandFact = {
    kind: 'visible',
    frame: { x: 0, y: 583, width: 402, height: 291 },
  };

  const occlusion = resolveWithFact(fixture, band);
  assert.equal(occlusion.kind, 'occluded');
  assert.deepEqual(
    (occlusion as { surface: { frame: Rect } }).surface,
    // With no keyboard in the tree there is no reported control to excuse a bare coordinate, and no
    // band to invent either: the frame is the producer's, verbatim.
    { frame: band.frame, controlRects: [] },
  );
});

test('a producer that found no keyboard settles it over the stale key nodes its tree still holds', () => {
  // A dismissal can leave key nodes in a tree captured around the same moment. The producer that
  // asked the keyboard afterwards is the one that knows.
  const fixture = tableCase('iPhone tab-bar item whose center is under the key plane is refused');
  assert.equal(fixture.expected.kind, 'occluded');
  assert.equal(resolveWithFact(fixture, { kind: 'absent' }).kind, 'no-keyboard');
});

test('a measured band still excuses the keyboard that the tree says the caller named', () => {
  const fixture = tableCase(
    'a key the caller named is the tap they meant, so the keyboard never blocks its own keys',
  );
  const occlusion = resolveWithFact(fixture, {
    kind: 'visible',
    frame: fixture.expected.frame ?? fixture.nodes[0]!.rect!,
  });
  assert.equal(occlusion.kind, 'clear');
});

test('a measured band still reads a coordinate on a reported key as the keyboard asked for', () => {
  const fixture = tableCase(
    'a bare coordinate landing on a key is the keyboard the caller asked for',
  );
  const occlusion = resolveWithFact(fixture, {
    kind: 'visible',
    frame: fixture.expected.frame ?? fixture.nodes[0]!.rect!,
  });
  assert.equal(occlusion.kind, 'clear');
});

test('an unmeasurable fact leaves every golden-table decision exactly as the tree rule made it', () => {
  // The fallback has to be total: a producer that could not look must not shift one verdict, on
  // either side of the refusal, or the table would stop describing this guard.
  for (const fixture of loadTable().cases) {
    const withFact = resolveWithFact(fixture, {
      kind: 'unmeasurable',
      reason: 'keyboard-frame-query-timeout',
    });
    assert.equal(withFact.kind, fixture.expected.kind, `${fixture.name}: kind`);
  }
});
