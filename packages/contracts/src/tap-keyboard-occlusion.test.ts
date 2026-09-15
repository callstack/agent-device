import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
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
