// Load-bearing ownership, path-reachability, and suite-registration witnesses.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { audit } from './audit.ts';
import { categories, loadModel, type Model } from './model.ts';
import type { Lane } from './workflows.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const base = loadModel(repoRoot, tracked);

function mutate(change: (model: Model) => Partial<Model>): Model {
  return { ...base, ...change(base) };
}

function messages(model: Model): string[] {
  return audit(model).map((failure) => failure.message);
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
    /check "fuzz-parsers" is not declared by any pull_request\/schedule lane/,
  );
  assert.match(found[0] ?? '', /run-gate action step for `fuzz-parsers`/);
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

// The Coverage lane runs a bare `vitest run --coverage`, which runs every project the config
// declares — so an unrun project is only representable once that script names its projects.
const projectScoped = (projects: readonly string[]): string =>
  `vitest run --coverage ${projects.map((name) => `--project ${name}`).join(' ')}`;

test('a Vitest project no check runs is reported, and so is a suite script', () => {
  const project = mutate((m) => ({
    scripts: { ...m.scripts, 'test:coverage:ci': projectScoped(m.vitestProjects) },
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
      'test:coverage:ci': projectScoped(m.vitestProjects),
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

test('a `test:*` script that is a suite by name, not by shape, needs an owner', () => {
  // The five `test:replay:*` scripts run `node src/bin.ts test <dir>`, which resolves to a
  // `script:` leaf. A shape-only rule could not see them: four were owned because someone
  // hand-registered them, and `test:replay:android` was neither registered nor reported.
  const model = mutate((m) => ({
    scripts: { ...m.scripts, 'test:replay:freebsd': 'node src/bin.ts test test/replays/freebsd' },
  }));
  assert.ok(
    messages(model).some((message) =>
      /package script "test:replay:freebsd" runs script:test:replay:freebsd/.test(message),
    ),
    'a new test:* script with no catalog entry must fail `registered`',
  );
});

// The device-lane rules (#1781 A9-2) route Apple and Android paths to the parked replay lanes.
// Path coverage exempts a declared manual-only check the way `owned` does — the gap is already
// printed by name — but only while it is declared: drop the declaration and every path that
// selects the check reports it.
test('a parked check selected by a path is exempt from path-coverage only while declared', () => {
  const declared = audit(base).filter((failure) => failure.assertion === 'path-coverage');
  assert.deepEqual(declared, []);
  const undeclared = audit(base, { manualOnly: {}, unprovable: {} }).filter(
    (failure) => failure.assertion === 'path-coverage',
  );
  assert.ok(
    undeclared.some((failure) => /selects "replay-ios"/.test(failure.message)),
    'without the declaration, the iOS replay lane must surface as unreachable from its paths',
  );
});
