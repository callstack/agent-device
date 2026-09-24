import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { SNAPSHOT_QUALITY_STATES, type SnapshotQualityState } from './snapshot.ts';

const SNAPSHOT_QUALITY_STATES_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'ios-snapshot-quality-states.json',
);

function readSnapshotQualityStatesFixture(): string[] {
  return JSON.parse(fs.readFileSync(SNAPSHOT_QUALITY_STATES_FIXTURE_PATH, 'utf8')) as string[];
}

/**
 * The tuple's own claim, stated on `SNAPSHOT_QUALITY_STATES`: the fixture is its wire vocabulary,
 * and the runner's `SnapshotQualityState.allCases` is pinned to the same file by a unit test.
 */
test('the declared verdict states are the shared wire vocabulary', () => {
  assert.deepEqual(
    readSnapshotQualityStatesFixture(),
    [...SNAPSHOT_QUALITY_STATES],
    'update the fixture and the Swift enum together with the tuple',
  );
});

/**
 * The union the readers key their exhaustive maps against: it admits exactly the declared states,
 * so an undeclared one cannot reach a verdict and a state added to the tuple reaches every map.
 */
test('the verdict state type admits exactly the declared states', () => {
  const declared: Record<SnapshotQualityState, true> = {
    healthy: true,
    recovered: true,
    sparse: true,
  };
  for (const state of SNAPSHOT_QUALITY_STATES) {
    assert.equal(declared[state], true, state);
  }
  // @ts-expect-error a state nobody declared cannot enter the verdict type
  const undeclared: SnapshotQualityState = 'degraded';
  void undeclared;
});
