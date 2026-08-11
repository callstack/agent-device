// Assertion group one: can anything a qualifying lane runs escape `pnpm gate`?
//
// The other half — whether every registered check is actually RUN — is
// audit-coverage.test.ts. These are mutations of the REAL model, not fixtures: #1714's
// predecessor had 75 unit tests over home-grown parsers, and the holes that mattered were
// green in every one of them. Fixtures test the parser; only the live tree tests the
// claim. So each case below plants a failure in the loaded model, asserts the audit goes
// red for the right reason, and asserts the unmutated model is green — which is what makes
// the planting non-vacuous.
//
// The cases whose comments name a review round are the reported bypasses, kept as
// regressions in the order they were found: content analysis (rounds 1–3), the inventory
// key (round 4), executable inputs to local actions (round 5), and to third-party
// actions (round 6).

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { audit } from './audit.ts';
import { EXTERNAL_ACTIONS, LANE_ENVIRONMENTS, NON_GATE_STEPS } from './declarations.ts';
import { loadModel, type Model } from './model.ts';
import { loadLanes, stepDigest, type Lane } from './workflows.ts';

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
function plantedWorkflow(yaml: string, externals = EXTERNAL_ACTIONS): Model {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lane-'));
  try {
    fs.writeFileSync(path.join(dir, 'planted.yml'), yaml);
    // The declaration list is threaded into the LOADER, not just the audit: which inputs a
    // third-party action executes decides which steps exist at all.
    const lanes = loadLanes(dir, repoRoot, base.scripts, externals);
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

const emulatorCall = (script: string) => `name: Planted
on:
  pull_request:
jobs:
  planted:
    name: Planted Android Lane
    runs-on: ubuntu-latest
    steps:
      - name: Run Android smoke checks
        uses: reactivecircus/android-emulator-runner@b530d96654c385303d652368551fb075bc2f0b6b
        with:
          api-level: 36
          script: ${script}
`;

test('a caller cannot smuggle code through an input a THIRD-PARTY action executes', () => {
  // Review round 6: the round-5 fix read local composite actions to find which inputs they
  // interpolate into a `run:` block. An external action cannot be read, and the model then
  // treated it as executing nothing — so this `script:` value, which is how the Android
  // smoke lanes run their whole suite, moved no digest and produced no finding.
  assert.deepEqual(
    messages(plantedWorkflow(emulatorCall('pnpm gate build'))),
    [],
    'a call site whose executable input is a gate needs no declaration',
  );

  const smuggled = audit(
    plantedWorkflow(emulatorCall(`node -e 'import("./scripts/layering/check.ts")'`)),
  ).filter((failure) => failure.assertion === 'bypass');
  assert.equal(smuggled.length, 1, 'and project code in the same value is a bypass');
  assert.match(smuggled[0]?.message ?? '', /android-emulator-runner/);
});

test('an undeclared third-party action is a finding, not an action that executes nothing', () => {
  const planted = plantedWorkflow(`name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
      - uses: some-org/some-action@0000000000000000000000000000000000000000
        with:
          script: node -e 'import("./scripts/layering/check.ts")'
`);
  const found = audit(planted).filter((failure) => failure.assertion === 'external');
  assert.equal(found.length, 1);
  assert.match(found[0]?.message ?? '', /some-org\/some-action@0{40}/);

  // Non-vacuity, and the reason the key is the SHA: the same action at a different pin is
  // a different declaration, because a new version can execute new inputs.
  const declared = [
    ...EXTERNAL_ACTIONS,
    {
      uses: 'some-org/some-action@0000000000000000000000000000000000000000',
      executes: ['script'],
      reason: 'test',
    },
  ];
  const withDeclaration = audit(
    plantedWorkflow(
      `name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
      - uses: some-org/some-action@0000000000000000000000000000000000000000
        with:
          script: node -e 'import("./scripts/layering/check.ts")'
`,
      declared,
    ),
    NON_GATE_STEPS,
    declared,
  );
  assert.equal(
    withDeclaration.filter((failure) => failure.assertion === 'external').length,
    0,
    'declaring the action clears the external finding',
  );
  assert.equal(
    withDeclaration.filter((failure) => failure.assertion === 'bypass').length,
    1,
    'and hands its executable input to the construction rule, which rejects this one',
  );
});

test('a declaration for an action no lane uses is inert', () => {
  const stale = [
    ...EXTERNAL_ACTIONS,
    { uses: 'gone/away@' + '0'.repeat(40), executes: [], reason: 'test' },
  ];
  const found = audit(base, NON_GATE_STEPS, stale).filter(
    (failure) => failure.assertion === 'inert',
  );
  assert.equal(found.length, 1);
  assert.match(found[0]?.message ?? '', /gone\/away/);
});

test('every declared external action is load-bearing at its current pin', () => {
  // The live tree is green, so each entry matches a real `uses:`. This pins the other
  // direction: dropping any one entry must produce a finding, or it is describing nothing.
  for (const entry of EXTERNAL_ACTIONS) {
    const without = EXTERNAL_ACTIONS.filter((candidate) => candidate !== entry);
    const found = audit(base, NON_GATE_STEPS, without);
    assert.ok(
      found.length > 0,
      `removing EXTERNAL_ACTIONS ${entry.uses} changed nothing; it is inert`,
    );
  }
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
      editStep('Run integration tests', (step) => ({
        run: `${step.run}\n${gate}`,
      })),
    ],
    [
      'injected env',
      editStep('Run integration tests', (step) => ({
        extras: {
          ...step.extras,
          'env.NODE_OPTIONS': '--import ./scripts/layering/check.ts',
        },
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
    {
      workflow: 'ci.yml',
      step: 'No Such Step',
      digest: 'deadbeefcafe',
      reason: 'never existed',
    },
  ];
  assert.ok(
    messages(base, invented).some((message) => /digest deadbeefcafe/.test(message)),
    'an entry naming no live digest is inert',
  );
});
