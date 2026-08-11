// Assertion group two: is every registered check actually RUN by a lane a PR would start?
//
// Split from audit.test.ts, which asserts the other half — that nothing runs outside a
// gate. The two use different machinery (a mutated model here, planted YAML through the
// real loader there), which is the seam; `scripts/layering/` names its test files after
// the claim they assert for the same reason.
//
// Every case mutates the REAL model and asserts the audit goes red for the right reason.
// #1714's predecessor had 75 unit tests over home-grown parsers, and the two holes that
// mattered — a suite outside the naming convention, and category samples naming files no
// PR could touch — were green in every one of them.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { audit } from './audit.ts';
import { loadBaseline } from './baseline.ts';
import { categories, covered, loadModel, type Model } from './model.ts';
import type { Lane } from './workflows.ts';
import { CHECK_CATALOG } from '../check-affected/checks.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const base = loadModel(repoRoot, tracked);
const baseline = loadBaseline();

function mutate(change: (model: Model) => Partial<Model>): Model {
  return { ...base, ...change(base) };
}

function messages(model: Model, declared = baseline): string[] {
  return audit(model, declared).map((failure) => failure.message);
}

function mapLane(
  model: Model,
  match: (lane: Lane) => boolean,
  change: (lane: Lane) => Lane,
): Lane[] {
  return model.lanes.map((lane) => (match(lane) ? change(lane) : lane));
}

test('the live tree is green — every planted failure below is a real difference', () => {
  assert.deepEqual(messages(base), []);
});

test('deleting the lane that runs a gate reports exactly that gate, naming the runner', () => {
  const model = mutate((m) => ({
    lanes: mapLane(
      m,
      (lane) => lane.gates.includes('fuzz-parsers'),
      (lane) => ({
        ...lane,
        gates: lane.gates.filter((id) => id !== 'fuzz-parsers'),
      }),
    ),
  }));
  const found = messages(model);
  assert.equal(found.length, 1);
  assert.match(
    found[0] ?? '',
    /check "fuzz-parsers" is not run by any pull_request\/schedule lane/,
  );
  assert.match(found[0] ?? '', /pnpm gate fuzz-parsers/);
});

test('a gate outside the test:/check: naming convention is still owned — the #1714 hole', () => {
  // `fuzz:parsers` resolves to an executable, not a Vitest project or a --test file.
  // Under the old design that made it invisible to the suite universe; here it is a
  // registered check like any other, so nothing has to recognise its shape.
  const spec = CHECK_CATALOG.find((entry) => entry.id === 'fuzz-parsers');
  assert.ok(spec);
  const result = covered(spec, null, base);
  assert.ok(result.covered);
  assert.deepEqual(result.lanes, ['Replay Nightly / Parser Fuzz Lane']);
});

test('a docs-only change still reaches the command-reference gate (#1420)', () => {
  const model = mutate((m) => ({
    lanes: mapLane(
      m,
      (lane) => lane.workflow === 'pr-preview.yml',
      (lane) => ({ ...lane, paths: ['website/assets/**'] }),
    ),
  }));
  const found = messages(model);
  assert.equal(found.length, 1);
  assert.match(found[0] ?? '', /website\/docs\/docs\/commands\.md/);
  assert.match(found[0] ?? '', /selects "command-docs"/);
});

test('per-unit coverage catches a lane deletion that whole-check ownership would miss', () => {
  // command-docs-gate runs one unit-core FILE, so it must not stand in for the
  // project when Coverage disappears.
  const model = mutate((m) => ({
    lanes: m.lanes.filter((lane) => lane.label !== 'Coverage'),
  }));
  const found = messages(model);
  assert.ok(found.some((message) => /check "unit-ci" is not run/.test(message)));
  assert.ok(found.some((message) => /check "vitest-related" is not run/.test(message)));
});

test('a path filter that excludes a category fails, though the check still runs somewhere', () => {
  // Take the category's path from the derivation rather than naming a file, so the
  // case keeps exercising the real classification as the tree changes.
  const category = categories(base).find((entry) => entry.rule === 'own:daemon-wire-compat');
  assert.ok(category, 'the wire ledger must still be a category');
  const model = mutate((m) => ({
    lanes: mapLane(
      m,
      (lane) => lane.workflow === 'ci.yml',
      (lane) => ({
        ...lane,
        pathsIgnore: [...lane.pathsIgnore, category.path],
      }),
    ),
  }));
  const found = messages(model);
  assert.ok(
    found.every((message) => !/is not run by any/.test(message)),
    'the checks still run somewhere — only this path stops reaching them',
  );
  assert.ok(found.some((message) => message.includes(category.path)));
  assert.ok(found.some((message) => /selects "daemon-wire-compat"/.test(message)));
});

test('removing the opaque-runner declaration changes the audit, so it is not inert', () => {
  const model = mutate(() => ({ opaque: {} }));
  const found = messages(model);
  assert.ok(found.some((message) => /check "unit" is not run/.test(message)));
  assert.ok(found.some((message) => /vitest:unit-core/.test(message)));
});

test('a Vitest project no check runs is reported, and so is a suite script', () => {
  const project = mutate((m) => ({
    vitestProjects: [...m.vitestProjects, 'new-lane'],
  }));
  assert.ok(
    messages(project).some((message) =>
      /Vitest project "new-lane" is run by no registered check/.test(message),
    ),
  );

  const script = mutate((m) => ({
    scripts: {
      ...m.scripts,
      'test:orphan': 'vitest run --project unit-core --project orphan-only',
    },
    vitestProjects: [...m.vitestProjects, 'orphan-only'],
  }));
  assert.ok(
    messages(script).some((message) =>
      /package script "test:orphan" runs vitest:orphan-only/.test(message),
    ),
  );
});

test('categories are derived from the tracked tree, so no sample can be fictional', () => {
  const found = categories(base);
  assert.ok(found.length >= 12, `expected the selector's real categories, got ${found.length}`);
  for (const category of found) {
    assert.ok(tracked.includes(category.path), `${category.path} must be a tracked file`);
    assert.ok(category.checks.length > 0, `${category.rule} must select at least one check`);
  }
  // The #1420 category in particular has to be present, since ci.yml ignores website/**.
  const docs = found.find((category) => category.rule === 'own:command-docs');
  assert.equal(docs?.path, 'website/docs/docs/commands.md');
  assert.deepEqual(docs?.checks, ['command-docs']);
});
