import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MASS_FILE_COUNT,
  MINI_REPO_COMMITS,
  MINI_REPO_FILES,
  MINI_REPO_PATHS as P,
} from '../repo-history/__fixtures__/mini-repo.ts';
import { buildRepoHistory } from '../repo-history/model.ts';
import { buildAffinity, pairKey, splitPairKey } from './affinity.ts';

const history = buildRepoHistory(MINI_REPO_COMMITS, new Set(MINI_REPO_FILES));

function edge(edges: ReturnType<typeof buildAffinity>['edges'], a: string, b: string) {
  return edges.find((entry) => pairKey(entry.a, entry.b) === pairKey(a, b));
}

test('a commit touching k files adds 1/(k-1) to each pair and support counts commits', () => {
  const { edges } = buildAffinity(history.commits, { maxFiles: 60, minSupport: 1 });
  // c01 (k=3) gives (a, b2) 0.5; c06, c07, c09 (k=2) give 1 each.
  assert.deepEqual(edge(edges, P.A, P.B2), { a: P.A, b: P.B2, weight: 3.5, support: 4 });
  // (b2, x) only ever co-changes in c01.
  assert.deepEqual(edge(edges, P.B2, P.X), { a: P.B2, b: P.X, weight: 0.5, support: 1 });
  // c11 (k=2) gives (x, z) 1 and c14 (k=3) gives 0.5.
  assert.deepEqual(edge(edges, P.X, P.Z), { a: P.X, b: P.Z, weight: 1.5, support: 2 });
});

test('the support cut keeps exactly the pairs seen in at least minSupport commits', () => {
  const result = buildAffinity(history.commits);
  assert.deepEqual(
    result.edges.map((entry) => [entry.a, entry.b, entry.weight, entry.support]),
    [
      [P.A, P.B2, 3.5, 4],
      [P.A, P.X, 2.5, 3],
      [P.X, P.Y, 2.5, 3],
    ],
  );
  assert.equal(result.rawEdges, 6);
});

test('a commit over the file threshold is skipped and counted, never folded in', () => {
  const result = buildAffinity(history.commits);
  assert.deepEqual(result.skipped, [
    { sha: 'c15', subject: 'chore: mass migration', files: MASS_FILE_COUNT },
  ]);
  assert.equal(result.touchingCommits, 16);
  assert.equal(result.usedCommits, 11);
  assert.equal(
    result.edges.some((entry) => entry.a.startsWith('packages/mass/')),
    false,
  );
  const lenient = buildAffinity(history.commits, { maxFiles: 61, minSupport: 1 });
  assert.equal(lenient.skipped.length, 0);
  assert.equal(
    lenient.edges.filter((entry) => entry.a.startsWith('packages/mass/')).length,
    (MASS_FILE_COUNT * (MASS_FILE_COUNT - 1)) / 2,
  );
});

test('pair keys are order-independent and split back', () => {
  assert.equal(pairKey('b', 'a'), pairKey('a', 'b'));
  assert.deepEqual(splitPairKey(pairKey('b', 'a')), ['a', 'b']);
});
