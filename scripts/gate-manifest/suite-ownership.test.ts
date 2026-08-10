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
        'on:\n  pull_request:\njobs:\n  cov:\n' +
        '    steps:\n      - run: pnpm exec vitest run --project unit-core\n',
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
        'on:\n  pull_request:\njobs:\n  cov:\n    steps:\n      - run: pnpm test:unit\n' +
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

test('a suite reachable only from a push or release lane is not owned', () => {
  // #1429 accepts a PR job or a scheduled workflow as an owner. A script that runs only on a
  // push to main, at release time, or on manual dispatch gates nothing on the way in, so
  // crediting those lanes would report a hole as covered.
  const ctx = context({
    vitestProjects: [],
    packageScripts: new Map([['check:published', 'node scripts/published.ts']]),
  });
  const nonOwning = lanesFor(
    {
      'release.yml':
        'name: R\non:\n  release:\n    types: [published]\n  workflow_dispatch:\n' +
        'jobs:\n  publish:\n    steps:\n      - run: pnpm check:published\n',
      'deploy.yml':
        'name: D\non:\n  push:\n    branches: [main]\n' +
        'jobs:\n  deploy:\n    steps:\n      - run: pnpm check:published\n',
    },
    ctx,
  );
  assert.deepEqual(
    nonOwning.map((lane) => lane.kind).sort(),
    ['push', 'release'],
    'workflow_dispatch beside release must not promote the lane to scheduled',
  );
  assert.deepEqual(unownedTerminals(suiteUniverse(ctx), nonOwning, new Set()), [
    { terminal: 'exec:scripts/published.ts', suites: ['check:published'] },
  ]);

  // The same script reached from a scheduled lane is owned.
  const scheduled = lanesFor(
    {
      'nightly.yml':
        'name: N\non:\n  schedule:\n    - cron: "0 0 * * *"\n' +
        'jobs:\n  nightly:\n    steps:\n      - run: pnpm check:published\n',
    },
    ctx,
  );
  assert.deepEqual(unownedTerminals(suiteUniverse(ctx), scheduled, new Set()), []);
});

test('a gate named outside the test:/check: convention is still in the universe', () => {
  // The convention does not enforce itself. `maestro:conformance`, `mutation:test` and
  // `fuzz:parsers` all run real gates in real lanes under other names and were invisible here,
  // so membership follows what a script RUNS, not what it is called.
  const ctx = context({
    packageScripts: new Map([
      ['maestro:conformance', 'node --test test/conformance/oracle.test.ts'],
      ['build', 'tsc -b'],
    ]),
  });
  const ids = suiteUniverse(ctx).map((suite) => suite.id);
  assert.ok(ids.includes('maestro:conformance'), 'a test-running script must be governed');
  assert.ok(!ids.includes('build'), 'an ordinary script must stay out of the universe');
});
