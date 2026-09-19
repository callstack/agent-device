import assert from 'node:assert/strict';
import { test } from 'node:test';
import { targetDagZone } from '../layering/model.ts';
import {
  MINI_REPO_COMMITS,
  MINI_REPO_FILES,
  MINI_REPO_PATHS as P,
} from '../repo-history/__fixtures__/mini-repo.ts';
import { buildRepoHistory } from '../repo-history/model.ts';
import { buildAffinity } from './affinity.ts';
import { couplingHubs, familyPairs } from './hubs.ts';

const history = buildRepoHistory(MINI_REPO_COMMITS, new Set(MINI_REPO_FILES));
const edges = buildAffinity(history.commits).edges;

test('hubs rank files by kept weight with their out-family weight and reach', () => {
  assert.deepEqual(couplingHubs(edges, targetDagZone, 10), [
    { id: P.A, family: 'alpha', weight: 6, outWeight: 6, outFamilies: 2, partners: 2 },
    { id: P.X, family: 'beta', weight: 5, outWeight: 2.5, outFamilies: 1, partners: 2 },
    { id: P.B2, family: 'gamma', weight: 3.5, outWeight: 3.5, outFamilies: 1, partners: 1 },
    { id: P.Y, family: 'beta', weight: 2.5, outWeight: 0, outFamilies: 0, partners: 1 },
  ]);
  assert.equal(couplingHubs(edges, targetDagZone, 2).length, 2);
});

test('family pairs aggregate cross-family edges only, heaviest first', () => {
  assert.deepEqual(familyPairs(edges, targetDagZone), [
    { a: 'alpha', b: 'gamma', weight: 3.5, edges: 1 },
    { a: 'alpha', b: 'beta', weight: 2.5, edges: 1 },
  ]);
});
