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
 * and the runner's `SnapshotQualityState.allCases` is pinned to the same file by a unit test. As a
 * set: the names are the contract, and a reordering breaks no verdict anywhere.
 */
test('the declared verdict states are the shared wire vocabulary', () => {
  assert.deepEqual(
    new Set(readSnapshotQualityStatesFixture()),
    new Set(SNAPSHOT_QUALITY_STATES),
    'update the fixture and the Swift enum together with the tuple',
  );
});

test('the verdict state type admits exactly the declared states', () => {
  // @ts-expect-error a state nobody declared cannot enter the verdict type
  const undeclared: SnapshotQualityState = 'degraded';
  void undeclared;
});
