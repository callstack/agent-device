// Does a category's own gate fire on a PR that only touches that category?

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { selectChecks } from '../check-affected/model.ts';
import type { CatalogEntry } from './catalog-wiring.ts';
import { pathFilterMatches, triggersOnPath } from './path-filters.ts';
import { unreachablePathCategories, unrepresentedRules } from './path-categories.ts';
import { deriveCategories } from './path-category-samples.ts';
import { readSelectorRules } from './selector-rules.ts';
import { buildLanes, parseWorkflow } from './workflow-lanes.ts';
import { context } from './test-context.ts';
import { FORWARDED_SELECTOR_RULES } from './waivers.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const SELECTOR_SOURCE = 'scripts/check-affected/model.ts';

test('workflow path filters match GitHub glob semantics', () => {
  assert.ok(pathFilterMatches('website/**', 'website/docs/commands.md'));
  assert.ok(pathFilterMatches('docs/**', 'docs/agents/testing.md'));
  assert.ok(!pathFilterMatches('website/**', 'src/website.ts'));
  assert.ok(pathFilterMatches('*.md', 'README.md'));
  assert.ok(!pathFilterMatches('*.md', 'docs/a.md'), '`*` must not cross a slash');
  assert.ok(pathFilterMatches('**/*.md', 'docs/a.md'));
  assert.ok(pathFilterMatches('README.md', 'README.md'));
});

test('paths-ignore excludes a path; an allowlisting paths: filter restricts to its own list', () => {
  const ignore = parseWorkflow(
    'ci.yml',
    "on:\n  pull_request:\n    paths-ignore:\n      - 'website/**'\njobs: {}\n",
  ).triggers;
  assert.ok(!triggersOnPath(ignore, 'website/docs/commands.md'));
  assert.ok(triggersOnPath(ignore, 'src/cli.ts'));

  const allow = parseWorkflow(
    'preview.yml',
    "on:\n  pull_request:\n    paths:\n      - 'website/**'\njobs: {}\n",
  ).triggers;
  assert.ok(triggersOnPath(allow, 'website/docs/commands.md'));
  assert.ok(!triggersOnPath(allow, 'src/cli.ts'));
});

test('a category whose owning job is excluded by its own workflow trigger fails', () => {
  // The generalized #1420 hole: the gate exists, the job exists, and the job never fires for
  // the change it is supposed to gate.
  const ctx = context({ packageScripts: new Map([['check:docs', 'node scripts/docs.ts']]) });
  const workflows = [
    parseWorkflow(
      '.github/workflows/ci.yml',
      "name: CI\non:\n  pull_request:\n    paths-ignore:\n      - 'website/**'\n" +
        'jobs:\n  docs:\n    name: Docs Gate\n    steps:\n      - run: pnpm check:docs\n',
    ),
  ];
  const lanes = buildLanes(workflows, ctx);
  const catalog: CatalogEntry[] = [{ id: 'docs', script: 'check:docs', ciJobs: ['Docs Gate'] }];
  const misses = unreachablePathCategories(
    [
      {
        label: 'website docs',
        path: 'website/docs/commands.md',
        checks: ['docs'],
        rules: ['gate:docs'],
      },
    ],
    catalog,
    workflows,
    lanes,
    new Set(),
  );
  assert.deepEqual(misses, [
    {
      category: 'website docs',
      path: 'website/docs/commands.md',
      check: 'docs',
      job: 'Docs Gate',
      workflow: '.github/workflows/ci.yml',
    },
  ]);
  // A path the workflow does trigger on is reachable through the same job.
  assert.deepEqual(
    unreachablePathCategories(
      [{ label: 'source', path: 'src/cli.ts', checks: ['docs'], rules: ['gate:docs'] }],
      catalog,
      workflows,
      lanes,
      new Set(),
    ),
    [],
  );
});

test('a selector rule no sample path exercises is reported as unrepresented', () => {
  const rules = ['own:swift', 'platform-src', 'gate:lint'];
  const categories = [
    { label: 'swift', path: 'apple/runner/a.swift', checks: [], rules: ['own:swift'] },
    { label: 'lint', path: 'src/a.ts', checks: [], rules: ['gate:lint'] },
  ];
  assert.deepEqual(unrepresentedRules(rules, categories), ['platform-src']);
  assert.deepEqual(
    unrepresentedRules(rules, [
      ...categories,
      { label: 'platform', path: 'src/platforms/a.ts', checks: [], rules: ['platform-src'] },
    ]),
    [],
  );
});

// --- The real tree ----------------------------------------------------------

test("the selector's real rule universe is derived, and excludes its fail-open classes", () => {
  const { rules } = readSelectorRules(
    SELECTOR_SOURCE,
    fs.readFileSync(path.join(repoRoot, SELECTOR_SOURCE), 'utf8'),
    FORWARDED_SELECTOR_RULES,
  );
  // Live selection rules, read from `reason(...)` calls and the BUILD_OWNERSHIP table.
  for (const expected of ['gate:lint', 'platform-src', 'own:swift', 'own:mcp', 'src-prod']) {
    assert.ok(rules.includes(expected), `expected the derived universe to include ${expected}`);
  }
  // Fail-open classes pair `rule:` with `path:`, not `check:` — running the full set means no
  // owning job whose triggers could exclude them, so they are not path categories.
  for (const failOpen of [
    'workflow-tooling',
    'unknown-path',
    'ambiguous-path',
    'selector-owning',
  ]) {
    assert.ok(!rules.includes(failOpen), `${failOpen} is a fail-open class, not a category`);
  }
});

test('planting a paths-ignore over a real category makes the real gate report it', () => {
  // Planted red against the LIVE selector and catalog: take the category the selector really
  // routes `src/platforms/**` through, and exclude it from the workflow that owns its checks.
  const plan = selectChecks({ changedFiles: ['src/platforms/android/index.ts'] });
  assert.ok(!plan.failOpen, 'the sample must classify for this regression to mean anything');
  const category = {
    label: 'platform source',
    path: 'src/platforms/android/index.ts',
    checks: plan.checks,
    rules: [...new Set(plan.reasons.map((reason) => reason.rule))],
  };
  const catalog: CatalogEntry[] = plan.checks.map((check) => ({
    id: check,
    script: null,
    ciJobs: ['Gate'],
  }));
  const excluded = [
    parseWorkflow(
      '.github/workflows/ci.yml',
      "name: CI\non:\n  pull_request:\n    paths-ignore:\n      - 'src/platforms/**'\n" +
        'jobs:\n  gate:\n    name: Gate\n    steps:\n      - run: pnpm lint\n',
    ),
  ];
  const lanes = buildLanes(excluded, context({ packageScripts: new Map([['lint', 'oxlint .']]) }));
  const misses = unreachablePathCategories(
    category ? [category] : [],
    catalog,
    excluded,
    lanes,
    new Set(),
  );
  assert.ok(misses.length > 0, 'excluding a live category from its owning workflow must fail');
  assert.ok(misses.every((miss) => miss.path === 'src/platforms/android/index.ts'));
});

test('every category sample is a real tracked file', () => {
  // A made-up path still classifies by prefix, so the gate reads green while asserting "a PR
  // touching only this path fires that job" about a path no PR can touch — and it can sit on the
  // wrong side of a `paths:` filter every real member of its category is inside.
  const tracked = new Set(
    execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n'),
  );
  for (const category of deriveCategories(selectChecks)) {
    assert.ok(tracked.has(category.path), `sample "${category.path}" is not a tracked file`);
  }
});
