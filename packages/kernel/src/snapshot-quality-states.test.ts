import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  SNAPSHOT_QUALITY_STATES,
  isSnapshotQualityState,
  type SnapshotQualityState,
} from './snapshot.ts';

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

test('state predicate accepts exactly the declared states', () => {
  for (const state of SNAPSHOT_QUALITY_STATES) {
    assert.equal(isSnapshotQualityState(state), true, state);
  }
  assert.equal(isSnapshotQualityState('degraded'), false);
  assert.equal(isSnapshotQualityState('Healthy'), false);
  assert.equal(isSnapshotQualityState(''), false);
  assert.equal(isSnapshotQualityState(undefined), false);
  assert.equal(isSnapshotQualityState(42), false);
  // @ts-expect-error a state nobody declared cannot enter the verdict type
  const undeclared: SnapshotQualityState = 'degraded';
  void undeclared;
});
