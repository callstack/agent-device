import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isTapPointInsideViewport } from '../mobile-snapshot-semantics.ts';
import type { Rect } from '../../kernel/snapshot.ts';

// ADR 0011 Layer 2 golden parity table: the SAME JSON is asserted against the
// Swift twin (TapPointPolicy in apple/runner/AgentDeviceRunner/
// AgentDeviceRunnerUITests/RunnerTapPointPolicy.swift, gated XCTest in the
// same file), so drift between the runner's ELEMENT_OFFSCREEN guard and the
// runtime's offscreen rule turns CI red on whichever side changed.
//
// Scope: the table proves the GEOMETRIC rule only — element-frame center
// inside the window frame, edges inclusive, empty frame fails open. The
// scrollable-ancestor (effective viewport) logic layered on top by
// isNodeVisibleOnScreen is TS-only and out of scope here.

type FixtureCase = {
  name: string;
  elementFrame: Rect;
  windowFrame: Rect;
  allowed: boolean;
};

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'tap-point-policy.json',
);

test('the TS tap-point rule agrees with every golden parity table case', () => {
  const cases = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as FixtureCase[];
  assert.ok(cases.length > 0, 'parity table must not be empty');
  const names = new Set(cases.map((fixture) => fixture.name));
  assert.equal(names.size, cases.length, 'parity table case names must be unique');
  for (const fixture of cases) {
    assert.equal(
      isTapPointInsideViewport(fixture.elementFrame, fixture.windowFrame),
      fixture.allowed,
      fixture.name,
    );
  }
});
