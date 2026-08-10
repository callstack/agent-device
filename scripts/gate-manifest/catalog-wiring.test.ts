// CHECK_CATALOG.ciJobs, checked against live jobs.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CHECK_CATALOG } from '../check-affected/checks.ts';
import {
  missingCatalogJobs,
  unreachableCatalogClaims,
  type CatalogEntry,
} from './catalog-wiring.ts';
import { buildLanes, parseWorkflow } from './workflow-lanes.ts';
import { context, lanesFor } from './test-context.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const CATALOG_WORKFLOWS = {
  '.github/workflows/ci.yml':
    'name: CI\non:\n  pull_request:\njobs:\n  lint:\n    name: Lint & Format\n' +
    '    steps:\n      - run: pnpm lint\n',
  '.github/workflows/ios.yml':
    'name: iOS\non:\n  pull_request:\njobs:\n  smoke:\n    name: Smoke Tests\n' +
    '    steps:\n      - run: pnpm build:xcuitest\n',
};

test('a catalog entry naming a job that no workflow defines fails, naming both sides', () => {
  const ctx = context({ packageScripts: new Map([['lint', 'oxlint .']]) });
  const lanes = lanesFor(CATALOG_WORKFLOWS, ctx);
  const catalog: CatalogEntry[] = [{ id: 'lint', script: 'lint', ciJobs: ['Lint and Format'] }];
  const [miss] = missingCatalogJobs(catalog, lanes);
  assert.equal(miss!.check, 'lint');
  assert.equal(miss!.job, 'Lint and Format');
  assert.ok(miss!.known.includes('Lint & Format'), 'the message must offer the real job names');
});

test('a cross-workflow job is matched bare and as "<workflow> / <job>"', () => {
  const ctx = context({ packageScripts: new Map([['build:xcuitest', 'sh ./scripts/x.sh']]) });
  const lanes = lanesFor(CATALOG_WORKFLOWS, ctx);
  assert.deepEqual(
    missingCatalogJobs([{ id: 'swift', script: null, ciJobs: ['iOS / Smoke Tests'] }], lanes),
    [],
  );
  assert.equal(
    missingCatalogJobs([{ id: 'swift', script: null, ciJobs: ['tvOS / Smoke Tests'] }], lanes)
      .length,
    1,
  );
});

test('a catalog claim is judged against the union of the jobs it names, not each alone', () => {
  // `unit` legitimately names two jobs that split the work between them; neither runs all of it.
  const ctx = context({
    packageScripts: new Map([
      ['check:unit', 'pnpm test:unit && pnpm test:smoke'],
      ['test:unit', 'vitest run --project unit-core'],
      ['test:smoke', 'node scripts/smoke.ts'],
    ]),
  });
  const lanes = lanesFor(
    {
      'ci.yml':
        'name: CI\non:\n  pull_request:\njobs:\n  cov:\n    name: Coverage\n' +
        '    steps:\n      - run: pnpm test:unit\n' +
        '  int:\n    name: Integration Tests\n    steps:\n      - run: pnpm test:smoke\n',
    },
    ctx,
  );
  const catalog: CatalogEntry[] = [
    { id: 'unit', script: 'check:unit', ciJobs: ['Coverage', 'Integration Tests'] },
  ];
  assert.deepEqual(unreachableCatalogClaims(catalog, lanes, ctx, new Set()), []);

  // Drop one of the two jobs from the claim and the uncovered half surfaces by name.
  const [miss] = unreachableCatalogClaims(
    [{ id: 'unit', script: 'check:unit', ciJobs: ['Coverage'] }],
    lanes,
    ctx,
    new Set(),
  );
  assert.deepEqual(miss!.missing, ['exec:scripts/smoke.ts']);
});

test('every CHECK_CATALOG.ciJobs entry names a job that really exists', () => {
  // The #1429 primary hole, asserted against the live workflows so a job rename fails in the
  // unit lane too and not only in `pnpm check:gate-manifest`.
  const files = execFileSync('git', ['ls-files', '.github/workflows/*.yml'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  const workflows = files.map((file) =>
    parseWorkflow(file, fs.readFileSync(path.join(repoRoot, file), 'utf8')),
  );
  const lanes = buildLanes(workflows, context());
  const catalog: CatalogEntry[] = CHECK_CATALOG.map((entry) => ({
    id: entry.id,
    script: entry.kind.type === 'script' ? entry.kind.script : null,
    ciJobs: entry.ciJobs,
  }));
  assert.deepEqual(
    missingCatalogJobs(catalog, lanes).map((miss) => `${miss.check} → "${miss.job}"`),
    [],
    'a CHECK_CATALOG entry points at a CI job no workflow defines',
  );
});
