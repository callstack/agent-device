// The gate manifest's tests are mutations of the REAL model, not fixtures.
//
// #1714's predecessor had 75 unit tests over home-grown parsers, and the two holes
// that mattered — a suite outside the naming convention, and category samples that
// named files no PR could touch — were green in every one of them. Fixtures test the
// parser; only the live tree tests the claim. So each case below plants a failure in
// the loaded model, asserts the audit goes red for the right reason, and asserts the
// unmutated model is green — which is what makes the planting non-vacuous.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { audit } from './audit.ts';
import { LANE_ENVIRONMENTS, NON_GATE_STEPS } from './declarations.ts';
import {
  categories,
  covered,
  loadLanes,
  loadModel,
  stepDigest,
  type Lane,
  type Model,
} from './model.ts';
import { CHECK_CATALOG } from '../check-affected/checks.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const base = loadModel(repoRoot, tracked);

function mutate(change: (model: Model) => Partial<Model>): Model {
  return { ...base, ...change(base) };
}

function messages(model: Model, declared = NON_GATE_STEPS): string[] {
  return audit(model, declared).map((failure) => failure.message);
}

function mapLane(
  model: Model,
  match: (lane: Lane) => boolean,
  change: (lane: Lane) => Lane,
): Lane[] {
  return model.lanes.map((lane) => (match(lane) ? change(lane) : lane));
}

/** Plant one `run:` step into a qualifying lane, sealed the way loadLanes seals it. */
function plantCommand(run: string, extras: Record<string, string> = {}): Model {
  const step = {
    name: 'Planted',
    source: 'ci.yml',
    run,
    extras,
    digest: stepDigest(run, extras),
  };
  return mutate((m) => ({
    lanes: mapLane(
      m,
      (lane) => lane.label === 'Layering Guard',
      (lane) => ({ ...lane, steps: [...lane.steps, step] }),
    ),
  }));
}

/** Edit a live step and re-seal it, which is what editing the YAML does. */
function editStep(
  name: string,
  change: (step: Model['lanes'][number]['steps'][number]) => {
    run?: string;
    extras?: Record<string, string>;
  },
): Model {
  return mutate((m) => ({
    lanes: m.lanes.map((lane) => ({
      ...lane,
      steps: lane.steps.map((step) => {
        if (step.name !== name || step.run === undefined) return step;
        const next = change(step);
        const run = next.run ?? step.run;
        const extras = next.extras ?? step.extras;
        return { ...step, run, extras, digest: stepDigest(run, extras) };
      }),
    })),
  }));
}

const bypassesFor = (run: string, extras: Record<string, string> = {}) =>
  audit(plantCommand(run, extras)).filter((failure) => failure.assertion === 'bypass');

/**
 * Load a planted workflow with the REAL loader, resolving `./.github/actions/…` against the
 * real tree. The composite action under test is the one CI uses, so these cases exercise
 * parse, resolution and audit together rather than a hand-built lane.
 */
function plantedWorkflow(yaml: string): Model {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lane-'));
  try {
    fs.writeFileSync(path.join(dir, 'planted.yml'), yaml);
    const lanes = loadLanes(dir, repoRoot, base.scripts);
    return mutate((model) => ({ lanes: [...model.lanes, ...lanes] }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const applyRunnerCall = (command: string) => `name: Planted
on:
  pull_request:
jobs:
  planted:
    name: Planted Apple Lane
    runs-on: macos-15
    steps:
      - name: Build the Apple runner
        uses: ./.github/actions/setup-apple-runner-build
        with:
          derived-path: /tmp/derived
          cache-key-prefix: planted
          build-command: ${command}
`;

test('a caller cannot smuggle code through an input a composite action executes', () => {
  // Review round 5: `setup-apple-runner-build` runs `${{ inputs.build-command }}`, so its
  // own step digest is CONSTANT and vouches for nothing — the command lives at the call
  // site. Both models below reach a byte-identical action; only the `with:` value differs.
  assert.deepEqual(
    messages(plantedWorkflow(applyRunnerCall('pnpm gate swift-runner-ios'))),
    [],
    'a call site whose executable input is a gate needs no declaration',
  );

  const smuggled = audit(
    plantedWorkflow(applyRunnerCall(`node -e 'import("./scripts/layering/check.ts")'`)),
  ).filter((failure) => failure.assertion === 'bypass');
  assert.equal(smuggled.length, 1, 'and project code in the same value is a bypass');
  assert.match(smuggled[0]?.message ?? '', /build-command/);
});

test('an execution surface the model does not read is rejected rather than ignored', () => {
  // Neither shape is used today. `defaults.run` retargets the shell of every step in a
  // lane, and a reusable-workflow job runs steps from a file the loader never opens, so
  // both would make the no-bypass rule quietly incomplete.
  const surfaces = (yaml: string) =>
    audit(plantedWorkflow(yaml)).filter((failure) => failure.assertion === 'surface');

  const found = surfaces(`name: Planted
on:
  pull_request:
defaults:
  run:
    shell: bash -lc {0}
jobs:
  planted:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm gate layering
`);
  assert.equal(found.length, 1);
  assert.match(found[0]?.message ?? '', /defaults:/);

  const reusable = surfaces(`name: Planted
on:
  pull_request:
jobs:
  planted:
    uses: ./.github/workflows/ci.yml
`);
  assert.equal(reusable.length, 1);
  assert.match(reusable[0]?.message ?? '', /reusable workflow/);
});

test('the live tree is green — every planted failure below is a real difference', () => {
  assert.deepEqual(messages(base), []);
});

test('deleting the lane that runs a gate reports exactly that gate, naming the runner', () => {
  const model = mutate((m) => ({
    lanes: mapLane(
      m,
      (lane) => lane.gates.includes('fuzz-parsers'),
      (lane) => ({ ...lane, gates: lane.gates.filter((id) => id !== 'fuzz-parsers') }),
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
  const model = mutate((m) => ({ lanes: m.lanes.filter((lane) => lane.label !== 'Coverage') }));
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
      (lane) => ({ ...lane, pathsIgnore: [...lane.pathsIgnore, category.path] }),
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

test('a qualifying lane accepts nothing but a gate invocation or a listed step', () => {
  // The rule is about SHAPE, so this is one property, not a list of spellings. Three
  // review rounds killed the content-analysis version: `pnpm exec`, then `pnpm exec --`
  // and `npx --yes`, then `node -e 'import(…)'`. Each of the cases below defeated some
  // predicate over command text; none of them can defeat "it is not `pnpm gate`".
  const evasions = [
    'pnpm check:layering',
    'node --experimental-strip-types scripts/gate/check.ts',
    'pnpm exec -- node scripts/gate/check.ts',
    'npx --yes node scripts/gate/check.ts',
    `node -e 'await import("./scripts/layering/check.ts").then(({ main }) => process.exit(main()))'`,
    `node -e 'require("./scripts/layering/check.ts")'`,
    `node -e "import('./scr' + 'ipts/layering/check.ts')"`,
    `eval "$(echo 'node scripts/layering/check.ts')"`,
    'echo bm9kZSBzY3JpcHRzL2xheWVyaW5nL2NoZWNrLnRz | base64 -d | sh',
    "bash <<'EOS'\nnode scripts/layering/check.ts\nEOS",
    'printf "node scripts/layering/check.ts" > /tmp/x.sh && sh /tmp/x.sh',
    // An env prefix is a `env:` block spelled in the shell, and injects the same way.
    'NODE_OPTIONS=--import ./scripts/layering/check.ts pnpm gate layering',
  ];
  for (const run of evasions) {
    assert.equal(bypassesFor(run).length, 1, `must be rejected: ${run}`);
  }
});

test('editing the body behind a listed step name is rejected', () => {
  // Review round 4: the inventory keyed on {workflow, step name} and then trusted the
  // body, so a listed step could be repointed at anything. The entry binds the DIGEST —
  // `run` plus every execution-affecting key — so an edit trips bypass and inert at once.
  const gate = `node -e 'await import("./scripts/layering/check.ts")'`;
  for (const [label, model] of [
    ['replaced body', editStep('Run integration tests', () => ({ run: gate }))],
    [
      'appended body',
      editStep('Run integration tests', (step) => ({ run: `${step.run}\n${gate}` })),
    ],
    [
      'injected env',
      editStep('Run integration tests', (step) => ({
        extras: { ...step.extras, 'env.NODE_OPTIONS': '--import ./scripts/layering/check.ts' },
      })),
    ],
  ] as const) {
    const found = audit(model).filter((failure) => failure.assertion === 'bypass');
    assert.equal(found.length, 1, `must be rejected: ${label}`);
    assert.match(found[0]?.message ?? '', /records digest/, `must name the digest drift: ${label}`);
  }
});

test('a gate invocation cannot carry a payload or an injecting environment', () => {
  // Two more round-4 witnesses: a prefix-only matcher accepted command substitution in
  // the arguments, and `env` was not modelled at all, so NODE_OPTIONS ran code with
  // nothing visible on the command line.
  assert.equal(
    bypassesFor(`pnpm gate gate-manifest $(node -e 'import("./scripts/layering/check.ts")')`)
      .length,
    1,
    'command substitution in a gate argument must be rejected',
  );
  assert.equal(
    bypassesFor('pnpm gate layering', {
      'env.NODE_OPTIONS': '--import ./scripts/layering/check.ts',
    }).length,
    1,
    'a gate step carrying env must be inventoried, not accepted by shape',
  );
  // `$VAR` expands to a value rather than running a program, so it stays allowed.
  assert.deepEqual(bypassesFor('pnpm gate fallow --base "$FALLOW_BASE"'), []);
});

test('a lane cannot inject through its inherited environment', () => {
  // Found while confirming round 4 rather than reported: workflow- and job-level `env:`
  // reaches every step, so `NODE_OPTIONS` there injects into a plain gate step while the
  // step itself stays byte-identical. Ten lanes carry job-level env today.
  const injected = mutate((m) => ({
    lanes: m.lanes.map((lane) =>
      lane.label === 'Layering Guard'
        ? {
            ...lane,
            env: { NODE_OPTIONS: '--import ./scripts/layering/check.ts' },
            envDigest: 'injected000',
          }
        : lane,
    ),
  }));
  assert.ok(
    audit(injected).some((failure) => failure.assertion === 'lane-env'),
    'an uninventoried lane environment must fail',
  );

  const edited = mutate((m) => ({
    lanes: m.lanes.map((lane) =>
      lane.workflow === 'ios.yml' ? { ...lane, envDigest: 'tampered0000' } : lane,
    ),
  }));
  const found = audit(edited);
  assert.ok(
    found.some((failure) => failure.assertion === 'lane-env'),
    'an edited env is unlisted',
  );
  assert.ok(
    found.some((failure) => /LANE_ENVIRONMENTS ios\.yml/.test(failure.message)),
    'and its old entry goes inert',
  );

  // Non-vacuity: the live tree really does have lanes carrying env, so this is not
  // asserting about a shape the repo never uses.
  assert.ok(LANE_ENVIRONMENTS.length >= 10);
});

test('a step is not hidden by working-directory', () => {
  // loadLanes used to drop these, which made anything placed in one invisible.
  const found = audit(
    plantCommand(`node -e 'import("./scripts/layering/check.ts")'`, {
      'working-directory': 'website',
    }),
  ).filter((failure) => failure.assertion === 'bypass');
  assert.equal(found.length, 1);
});

test('the gate shape is accepted, including the forms real lanes use', () => {
  for (const run of [
    'pnpm gate layering',
    'pnpm gate fallow --base origin/main',
    'pnpm --silent gate mutation-affected --list-affected',
    // GitHub evaluates `${{ … }}` before the shell, so it is not shell syntax.
    'pnpm gate mutation --modules ${{ matrix.module }}',
    // A failure-path envelope recorder still only invokes a gate.
    'pnpm gate mutation --fail-envelope "lane died" || true',
  ]) {
    assert.deepEqual(bypassesFor(run), [], `must be accepted: ${run}`);
  }
});

test('`pnpm gate` naming an unregistered check is rejected even though the shape is right', () => {
  const found = bypassesFor('pnpm gate laering');
  assert.equal(found.length, 1);
  assert.match(found[0]?.message ?? '', /`pnpm gate laering` names no registered check/);
});

test('an entry goes inert when the step it describes stops existing', () => {
  // Deleting the step orphans its entry. Renaming it does NOT, by design: the digest
  // binds what the step RUNS, and a name is metadata — keying on the name is exactly
  // the mistake review round 4 found, because it let the body change underneath it.
  const deleted = mutate((m) => ({
    lanes: m.lanes.map((lane) => ({
      ...lane,
      steps: lane.steps.filter((step) => step.name !== 'Run iOS Settings replay smoke test'),
    })),
  }));
  assert.ok(
    messages(deleted).some((message) => /matches no shell a qualifying lane reaches/.test(message)),
    'a deleted step orphans its entry',
  );

  const renamed = editStep('Run iOS Settings replay smoke test', () => ({}));
  assert.deepEqual(messages(renamed), [], 'a pure rename changes nothing that runs');

  const invented = [
    ...NON_GATE_STEPS,
    { workflow: 'ci.yml', step: 'No Such Step', digest: 'deadbeefcafe', reason: 'never existed' },
  ];
  assert.ok(
    messages(base, invented).some((message) => /digest deadbeefcafe/.test(message)),
    'an entry naming no live digest is inert',
  );
});

test('removing the opaque-runner declaration changes the audit, so it is not inert', () => {
  const model = mutate(() => ({ opaque: {} }));
  const found = messages(model);
  assert.ok(found.some((message) => /check "unit" is not run/.test(message)));
  assert.ok(found.some((message) => /vitest:unit-core/.test(message)));
});

test('a Vitest project no check runs is reported, and so is a suite script', () => {
  const project = mutate((m) => ({ vitestProjects: [...m.vitestProjects, 'new-lane'] }));
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
