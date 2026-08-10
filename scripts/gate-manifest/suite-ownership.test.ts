// Which units of work no lane reaches.

import assert from 'node:assert/strict';
import test from 'node:test';
import { suiteUniverse, unownedTerminals } from './suite-ownership.ts';
import { context, lanesFor } from './test-context.ts';

test('a new vitest project no lane runs is unowned until it is wired or waived', () => {
  const ctx = context({ vitestProjects: ['unit-core', 'brand-new'] });
  const lanes = lanesFor(
    {
      'ci.yml':
        'jobs:\n  cov:\n    steps:\n      - run: pnpm exec vitest run --project unit-core\n',
    },
    ctx,
  );
  const unowned = unownedTerminals(suiteUniverse(ctx), lanes, new Set());
  assert.deepEqual(unowned, [{ terminal: 'vitest:brand-new', suites: ['vitest:brand-new'] }]);
  // …and declaring it local-only silences exactly that one, nothing else.
  assert.deepEqual(unownedTerminals(suiteUniverse(ctx), lanes, new Set(['vitest:brand-new'])), []);
});

test('ownership is per unit of work, so a split aggregate is not reported as unowned', () => {
  // `check:everything` spans two jobs and no single job runs all of it.
  const ctx = context({
    vitestProjects: ['unit-core'],
    packageScripts: new Map([
      ['check:everything', 'pnpm test:unit && pnpm test:smoke'],
      ['test:unit', 'vitest run --project unit-core'],
      ['test:smoke', 'node scripts/smoke.ts'],
    ]),
  });
  const lanes = lanesFor(
    {
      'ci.yml':
        'jobs:\n  cov:\n    steps:\n      - run: pnpm test:unit\n' +
        '  int:\n    steps:\n      - run: pnpm test:smoke\n',
    },
    ctx,
  );
  assert.deepEqual(unownedTerminals(suiteUniverse(ctx), lanes, new Set()), []);
});

test('the suite universe is every vitest project plus every test:/check: script', () => {
  const ctx = context({
    vitestProjects: ['unit-core'],
    packageScripts: new Map([
      ['check:one', 'node scripts/one.ts'],
      ['test:two', 'node scripts/two.ts'],
      ['build:three', 'node scripts/three.ts'],
    ]),
  });
  assert.deepEqual(
    suiteUniverse(ctx).map((suite) => suite.id),
    ['check:one', 'test:two', 'vitest:unit-core'],
  );
});
