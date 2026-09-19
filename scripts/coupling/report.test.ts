import assert from 'node:assert/strict';
import { test } from 'node:test';
import { targetDagZone } from '../layering/model.ts';
import {
  MINI_REPO_COMMITS,
  MINI_REPO_FILES,
  MINI_REPO_NOW,
  MINI_REPO_PATHS as P,
} from '../repo-history/__fixtures__/mini-repo.ts';
import { buildRepoHistory } from '../repo-history/model.ts';
import {
  buildCouplingReport,
  DRIFT_REFERENCE,
  driftWarnings,
  formatCouplingSummary,
  type CouplingReport,
} from './report.ts';

const history = buildRepoHistory(MINI_REPO_COMMITS, new Set(MINI_REPO_FILES));
const EPSILON = 1e-12;

function report(sinceDays = 200): CouplingReport {
  return buildCouplingReport(
    { commits: history.commits, files: MINI_REPO_FILES },
    {
      familyOf: targetDagZone,
      sinceDays,
      now: MINI_REPO_NOW,
      generated: { commit: 'abc1234', date: '2026-09-19T00:00:00.000Z' },
    },
  );
}

test('computes all-time and trailing-window measurements side by side', () => {
  const built = report();
  assert.deepEqual(built.generated, {
    commit: 'abc1234',
    date: '2026-09-19T00:00:00.000Z',
    files: MINI_REPO_FILES.length,
    families: 4,
  });
  assert.equal(built.window.sinceDays, 200);
  assert.equal(built.window.allTime.from, null);
  assert.equal(built.window.since.from, '2026-03-03T00:00:00.000Z');
  assert.deepEqual(built.window.allTime.commits, {
    total: 18,
    touching: 16,
    used: 11,
    skipped: 1,
    maxFiles: 60,
  });
  assert.deepEqual(built.window.allTime.edges, {
    raw: 6,
    kept: 3,
    minSupport: 3,
    crossFamily: 2,
    crossFamilyShare: 2 / 3,
  });
  // The window keeps only (x, y): one intra-family edge, so modularity collapses to zero.
  assert.equal(built.window.since.commits.total, 11);
  assert.equal(built.window.since.edges.kept, 1);
  assert.equal(built.window.since.edges.crossFamilyShare, 0);
  assert.deepEqual(built.assortativity.since, { intraShare: 1, expected: 1, modularity: 0 });
  assert.ok(Math.abs(built.assortativity.allTime.modularity - (2.5 / 8.5 - 104.5 / 289)) < EPSILON);
  assert.deepEqual(built.window.allTime.skipped, [
    { sha: 'c15', subject: 'chore: mass migration', files: 61 },
  ]);
  assert.deepEqual(built.window.allTime.span.histogram, { 1: 9, 2: 5, 3: 1 });
});

test('per-family rows carry file counts, flow, partners, and Q for every family with files', () => {
  const rows = new Map(report().perFamily.map((row) => [row.family, row]));
  assert.deepEqual([...rows.keys()], ['alpha', 'beta', 'gamma', 'mass']);
  assert.deepEqual(rows.get('mass'), {
    family: 'mass',
    files: 61,
    inWeight: 0,
    outWeight: 0,
    outInFlow: null,
    partners: [],
    Q: 0,
  });
  const beta = rows.get('beta')!;
  assert.deepEqual(
    [beta.files, beta.inWeight, beta.outWeight, beta.outInFlow, beta.partners],
    [5, 2.5, 2.5, 1, ['alpha']],
  );
  const sum = report().perFamily.reduce((total, row) => total + row.Q, 0);
  const { intraShare, expected } = report().assortativity.allTime;
  assert.ok(Math.abs(sum - (intraShare - expected)) < EPSILON);
});

test('hubs, family pairs, and edges come from the all-time window', () => {
  const built = report();
  assert.equal(built.hubs[0]!.id, P.A);
  assert.deepEqual(built.familyPairs[0], { a: 'alpha', b: 'gamma', weight: 3.5, edges: 1 });
  assert.equal(built.edges.length, 3);
});

test('a reference miss is a named drift warning, never a failure', () => {
  const warnings = driftWarnings(report());
  assert.equal(warnings.length, 2, warnings.join('\n'));
  assert.match(
    warnings[0]!,
    /^drift warning: all-time modularity -0\.067 is outside the reference 0\.2-0\.35/,
  );
  assert.match(
    warnings[1]!,
    /^drift warning: share of multi-family commits spanning >= 5 families 0\.0% is below/,
  );
  const inRange: CouplingReport = {
    ...report(),
    assortativity: {
      ...report().assortativity,
      allTime: { intraShare: 0.364, expected: 0.114, modularity: 0.25 },
    },
  };
  inRange.window.allTime.span.shareAtLeast5 = DRIFT_REFERENCE.spanAtLeast5ShareMin;
  assert.deepEqual(driftWarnings(inRange), []);
});

test('the text summary names every section the report carries', () => {
  const text = formatCouplingSummary(report(), 5);
  for (const needle of [
    'commits: 18 total, 16 touching production files, 11 used for pairs, 1 skipped (> 60 files)',
    'edges: 3 kept at support >= 3 (of 6 pairs), 2 cross-family (66.7%)',
    'intraShare 29.4% vs expected 36.2% -> modularity -0.067',
    'last 200 days (since 2026-03-03)',
    'family span: 1:9 2:5 3:1; 6 multi-family commits, median 2, >= 5 families 0.0%',
    'skipped mass commits (all-time):',
    'c15 61 files  chore: mass migration',
    'per family (all-time',
    'top coupling hubs',
    'heaviest family pairs:',
    'alpha <-> gamma',
    'drift warning: all-time modularity',
    'not a removability or correctness claim',
  ]) {
    assert.ok(text.includes(needle), `missing ${JSON.stringify(needle)} in:\n${text}`);
  }
});
