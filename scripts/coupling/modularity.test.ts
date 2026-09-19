import assert from 'node:assert/strict';
import { test } from 'node:test';
import { targetDagZone } from '../layering/model.ts';
import { MINI_REPO_COMMITS, MINI_REPO_FILES } from '../repo-history/__fixtures__/mini-repo.ts';
import { buildRepoHistory } from '../repo-history/model.ts';
import { buildAffinity } from './affinity.ts';
import { familyModularity } from './modularity.ts';

const history = buildRepoHistory(MINI_REPO_COMMITS, new Set(MINI_REPO_FILES));
const families = new Set(MINI_REPO_FILES.map(targetDagZone));
const EPSILON = 1e-12;

function measured() {
  return familyModularity(buildAffinity(history.commits).edges, targetDagZone, families);
}

test('per-family in/out weight and the share of edge ends follow the kept edges', () => {
  // Kept: (a, b2) 3.5 alpha-gamma, (a, x) 2.5 alpha-beta, (x, y) 2.5 beta-beta. W = 8.5.
  const { perFamily, totalWeight, crossFamilyEdges } = measured();
  assert.equal(totalWeight, 8.5);
  assert.equal(crossFamilyEdges, 2);
  const alpha = perFamily.get('alpha')!;
  const beta = perFamily.get('beta')!;
  const gamma = perFamily.get('gamma')!;
  const mass = perFamily.get('mass')!;
  assert.deepEqual(
    [alpha.inWeight, alpha.outWeight, alpha.s, alpha.partners, alpha.outInFlow],
    [0, 6, 6, ['beta', 'gamma'], null],
  );
  assert.deepEqual(
    [beta.inWeight, beta.outWeight, beta.s, beta.partners, beta.outInFlow],
    [2.5, 2.5, 7.5, ['alpha'], 1],
  );
  assert.deepEqual(
    [gamma.inWeight, gamma.outWeight, gamma.s, gamma.partners],
    [0, 3.5, 3.5, ['alpha']],
  );
  assert.deepEqual(
    [mass.inWeight, mass.outWeight, mass.s, mass.partners, mass.Q],
    [0, 0, 0, [], 0],
  );
  assert.equal(alpha.s + beta.s + gamma.s + mass.s, 2 * totalWeight);
});

test('intraShare, expected, and Q_f use the declared formulas', () => {
  const { intraShare, expected, modularity, perFamily } = measured();
  assert.ok(Math.abs(intraShare - 2.5 / 8.5) < EPSILON);
  assert.ok(Math.abs(expected - 104.5 / 289) < EPSILON);
  assert.ok(Math.abs(modularity - (2.5 / 8.5 - 104.5 / 289)) < EPSILON);
  assert.ok(Math.abs(perFamily.get('beta')!.Q - (2.5 / 8.5 - (7.5 / 17) ** 2)) < EPSILON);
  assert.ok(Math.abs(perFamily.get('alpha')!.Q - -((6 / 17) ** 2)) < EPSILON);
});

test('Σ Q_f equals intraShare − expected', () => {
  const { intraShare, expected, perFamily } = measured();
  const sum = [...perFamily.values()].reduce((total, row) => total + row.Q, 0);
  assert.ok(
    Math.abs(sum - (intraShare - expected)) < EPSILON,
    `${sum} vs ${intraShare - expected}`,
  );
});

test('an empty edge set reports zero everywhere instead of NaN', () => {
  const empty = familyModularity([], targetDagZone, ['alpha']);
  assert.deepEqual(
    [empty.totalWeight, empty.intraShare, empty.expected, empty.modularity],
    [0, 0, 0, 0],
  );
  assert.equal(empty.perFamily.get('alpha')!.Q, 0);
});
