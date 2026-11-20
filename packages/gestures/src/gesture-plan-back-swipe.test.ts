import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildGesturePlan } from './gesture-plan.ts';

// The iOS runner's back swipe mirrors the `right-edge` fling preset. This table holds both sides to
// it: this file against the host planner, RunnerTests+NavigationTests.swift against the runner.
type BackSwipeCase = {
  name: string;
  surface: { x: number; y: number; width: number; height: number };
  start: { x: number; y: number };
  end: { x: number; y: number };
  durationMs: number;
};

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'back-swipe-geometry.json',
);

test('the right-edge fling preset plans the back swipe the runner mirrors', () => {
  const cases = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as BackSwipeCase[];
  assert.ok(cases.length > 0);
  for (const fixture of cases) {
    const plan = buildGesturePlan({ intent: 'fling', preset: 'right-edge' }, fixture.surface);
    assert.ok(plan.topology === 'single', fixture.name);
    const samples = plan.pointers[0].samples;
    assert.deepEqual(samples[0]?.point, fixture.start, fixture.name);
    assert.deepEqual(samples.at(-1)?.point, fixture.end, fixture.name);
    assert.equal(plan.durationMs, fixture.durationMs, fixture.name);
  }
});
