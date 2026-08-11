// Can anything a qualifying lane runs escape `pnpm gate`?
//
// The other half — whether every registered check is actually RUN — is
// audit-coverage.test.ts.
//
// Every case is a mutation of the REAL model or a workflow loaded by the REAL loader, never
// a hand-built fixture: #1714's predecessor had 75 unit tests over home-grown parsers, and
// the holes that mattered were green in every one of them. The witnesses are table-driven
// because they are a corpus, not a narrative — each row is a hole that was actually
// reported in review or actually found in this repo, and the table is the record of which
// assertion catches it.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { audit, formatFailures } from './audit.ts';
import { loadBaseline } from './baseline.ts';
import { ALLOWED_ENV, EXTERNAL_ACTIONS } from './declarations.ts';
import { loadModel, type Model } from './model.ts';
import { loadLanes, stepDigest, type Lane } from './workflows.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const base = loadModel(repoRoot, tracked);
const baseline = loadBaseline();

const mutate = (change: (model: Model) => Partial<Model>): Model => ({ ...base, ...change(base) });

const mapLane = (model: Model, match: (lane: Lane) => boolean, change: (lane: Lane) => Lane) =>
  model.lanes.map((lane) => (match(lane) ? change(lane) : lane));

/** Plant one `run:` step into a qualifying lane, sealed the way loadLanes seals it. */
function plantStep(run: string, extras: Record<string, string> = {}): Model {
  const step = { name: 'Planted', source: 'ci.yml', run, extras, digest: stepDigest(run, extras) };
  return mutate((model) => ({
    lanes: mapLane(
      model,
      (lane) => lane.label === 'Layering Guard',
      (lane) => ({ ...lane, steps: [...lane.steps, step] }),
    ),
  }));
}

/**
 * Load a planted workflow with the REAL loader against the REAL actions, so parse,
 * resolution and audit are exercised together rather than a hand-built lane.
 */
function plantWorkflow(yaml: string, externals = EXTERNAL_ACTIONS): Model {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lane-'));
  try {
    fs.writeFileSync(path.join(dir, 'planted.yml'), yaml);
    return mutate((model) => ({
      lanes: [...model.lanes, ...loadLanes(dir, repoRoot, base.scripts, externals)],
    }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Plant a whole tree — workflow plus actions — so an action under test can be planted too. */
function plantTree(files: Record<string, string>): Model {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-tree-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.join(root, path.dirname(name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), body);
    }
    return mutate((model) => ({
      lanes: [
        ...model.lanes,
        ...loadLanes(path.join(root, '.github/workflows'), root, base.scripts),
      ],
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const workflow = (steps: string) => `name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
${steps}`;

const GATE_ACTION = '.github/actions/setup-apple-runner-build/action.yml';

const kinds = (model: Model) => [...new Set(audit(model, baseline).map((f) => f.assertion))].sort();

test('the live tree is green — every planted failure below is a real difference', () => {
  assert.deepEqual(audit(base, baseline), []);
});

// Each row: a hole that was reported or found, and the assertion that must catch it.
//
// Rounds 1–3 killed content analysis (`pnpm exec`, `pnpm exec --`/`npx --yes`, then
// `node -e 'import(…)'`) — "does this text run project code?" is not decidable from text,
// so the rule stopped asking. Round 4 moved the inventory key from a step's NAME to its
// digest. Rounds 5–6 found the same hole one and two levels out, in the values callers hand
// to local and third-party actions. Round 7 narrowed the construction so those two seams
// cannot carry a command at all, which is why the last rows assert a rejection rather than
// a fingerprint.
const WITNESSES: [name: string, build: () => Model, expected: string[]][] = [
  ['r1: pnpm exec', () => plantStep('pnpm exec node scripts/layering/check.ts'), ['bypass']],
  ['r2: pnpm exec --', () => plantStep('pnpm exec -- node scripts/layering/check.ts'), ['bypass']],
  ['r2: npx --yes', () => plantStep('npx --yes node scripts/layering/check.ts'), ['bypass']],
  ['r3: node -e import', () => plantStep(`node -e 'import("./x.ts")'`), ['bypass']],
  ['r3: node -e require', () => plantStep(`node -e 'require("./x.ts")'`), ['bypass']],
  ['r3: split-string import', () => plantStep(`node -e "import('./x' + '.ts')"`), ['bypass']],
  ['r3: eval', () => plantStep(`eval "$(echo 'node x.ts')"`), ['bypass']],
  ['r3: base64 | sh', () => plantStep('echo bm9kZQ== | base64 -d | sh'), ['bypass']],
  ['r3: heredoc', () => plantStep("bash <<'EOS'\nnode x.ts\nEOS"), ['bypass']],
  [
    'r3: generated script',
    () => plantStep('printf "node x.ts" > /tmp/x.sh && sh /tmp/x.sh'),
    ['bypass'],
  ],
  ['r3: plain file', () => plantStep('node scripts/layering/check.ts'), ['bypass']],
  [
    'r4: command substitution in a gate argument',
    () => plantStep(`pnpm gate layering $(node -e '1')`),
    ['bypass'],
  ],
  [
    'r4: working-directory hides nothing',
    () => plantStep(`node -e '1'`, { 'working-directory': 'website' }),
    ['bypass'],
  ],
  [
    'r4: inline env prefix on a gate call',
    () => plantStep('NODE_OPTIONS=--import ./x.ts pnpm gate layering'),
    ['bypass'],
  ],
  [
    'r7: an interpreter-retargeting variable is rejected by name',
    () =>
      mutate((model) => ({
        lanes: mapLane(
          model,
          (lane) => lane.label === 'Layering Guard',
          (lane) => ({ ...lane, envKeys: [...lane.envKeys, 'NODE_OPTIONS'] }),
        ),
      })),
    ['env'],
  ],
  [
    'r7: a local action may not interpolate an input into a shell',
    () =>
      plantTree({
        '.github/workflows/planted.yml': workflow(
          '      - uses: ./.github/actions/leaky\n        with:\n          thing: x\n',
        ),
        '.github/actions/leaky/action.yml': `inputs:
  thing:
    description: 'x'
runs:
  using: composite
  steps:
    - run: echo \${{ inputs.thing }}
      shell: bash
`,
      }),
    ['bypass', 'surface'],
  ],
  [
    'r9: `if: false` cannot silently disable a gate step',
    () =>
      plantWorkflow(`name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
      - name: Run the layering gate
        if: false
        run: pnpm gate layering
`),
    ['bypass'],
  ],
  [
    'r6: an undeclared third-party action',
    () =>
      plantWorkflow(
        workflow(
          `      - uses: nobody/unknown@${'0'.repeat(40)}\n        with:\n          script: node -e '1'\n`,
        ),
      ),
    ['external'],
  ],
  [
    'r6: project code in a third-party action’s script input',
    () =>
      plantWorkflow(
        workflow(`      - uses: reactivecircus/android-emulator-runner@b530d96654c385303d652368551fb075bc2f0b6b
        with:
          api-level: 36
          script: node -e 'import("./scripts/layering/check.ts")'
`),
      ),
    ['bypass'],
  ],
  [
    's1: defaults.run retargets every step’s shell',
    () =>
      plantWorkflow(`name: Planted
on:
  pull_request:
defaults:
  run:
    shell: bash -lc {0}
jobs:
  planted:
    steps:
      - run: pnpm gate layering
`),
    ['surface'],
  ],
  [
    's2: a reusable-workflow job',
    () =>
      plantWorkflow(`name: Planted
on:
  pull_request:
jobs:
  planted:
    uses: ./.github/workflows/ci.yml
`),
    ['surface'],
  ],
];

for (const [name, build, expected] of WITNESSES) {
  test(`rejected — ${name}`, () => {
    assert.deepEqual(kinds(build()), expected);
  });
}

// The other direction: shapes real lanes use must be accepted, or the rule is unusable.
const ACCEPTED = [
  'pnpm gate layering',
  'pnpm gate fallow --base origin/main',
  'pnpm --silent gate mutation-affected --list-affected',
  // GitHub evaluates `${{ … }}` before the shell, so it is not shell syntax.
  'pnpm gate mutation --modules ${{ matrix.module }}',
  // A failure-path envelope recorder still only invokes a gate.
  'pnpm gate mutation --fail-envelope "lane died" || true',
  // `$VAR` expands to a value; it does not run a program.
  'pnpm gate fallow --base "$FALLOW_BASE"',
];

for (const run of ACCEPTED) {
  test(`accepted — ${run}`, () => {
    assert.deepEqual(audit(plantStep(run), baseline), []);
  });
}

test('a gate-valued action input must name a registered check', () => {
  // Round 7 replaced `build-command: pnpm gate swift-runner-ios` with `gate: swift-runner-ios`.
  // The id is data the audit validates, so a typo is a finding rather than a command that
  // silently runs nothing.
  const planted = plantWorkflow(
    workflow(`      - uses: ./.github/actions/setup-apple-runner-build
        with:
          derived-path: /tmp/derived
          cache-key-prefix: planted
          gate: swift-runner-iso
`),
  );
  const found = audit(planted, baseline).filter((failure) => failure.assertion === 'gate');
  assert.equal(found.length, 1);
  assert.match(found[0]?.message ?? '', /"swift-runner-iso" names no registered check/);
});

test('editing the body behind a listed step is rejected, and its entry goes inert', () => {
  // Review round 4: the inventory keyed on {workflow, step name} and then trusted the body.
  const gate = `node -e 'import("./scripts/layering/check.ts")'`;
  const edited = mutate((model) => ({
    lanes: model.lanes.map((lane) => ({
      ...lane,
      steps: lane.steps.map((step) =>
        step.name === 'Run integration tests'
          ? { ...step, run: gate, digest: stepDigest(gate, step.extras) }
          : step,
      ),
    })),
  }));
  const found = audit(edited, baseline);
  assert.ok(found.some((f) => f.assertion === 'bypass'));
  assert.ok(found.some((f) => f.assertion === 'inert'));
});

test('a gate-valued action must be proven to run its gate, not trusted to', () => {
  // Round 8: listing an action in GATE_ACTIONS credited every caller with whatever id it
  // passed. Swapping the body for a no-op left the credit intact. The commit that fixed it
  // proved non-vacuity by hand; this is that proof, checked in.
  const withBody = (run: string) =>
    audit(
      {
        ...base,
        gateActionBodies: { ...base.gateActionBodies, [GATE_ACTION]: { run, boundTo: 'gate' } },
      },
      baseline,
    ).filter((failure) => failure.assertion === 'gate');

  assert.deepEqual(withBody('pnpm gate "$INPUT_GATE"'), [], 'the real body satisfies the contract');
  const noop = withBody('true');
  assert.equal(noop.length, 1, 'a no-op body must not credit its callers');
  assert.match(noop[0]?.message ?? '', /does not invoke/);
});

test('a baseline entry describing no live step is inert', () => {
  const invented = [
    ...baseline,
    { source: 'ci.yml', step: 'No Such Step', digest: 'deadbeefcafe' },
  ];
  assert.ok(
    audit(base, invented).some((f) => /digest deadbeefcafe/.test(f.message)),
    'an entry naming no live digest must be reported',
  );
});

test('every allowlisted env namespace is load-bearing', () => {
  // Dropping any one entry must produce a finding, or it is describing nothing.
  for (const entry of ALLOWED_ENV) {
    const without = ALLOWED_ENV.filter((candidate) => candidate !== entry);
    const found = audit(base, baseline, EXTERNAL_ACTIONS, without);
    assert.ok(found.length > 0, `removing ALLOWED_ENV ${entry} changed nothing; it is inert`);
  }
});

test('every declared external action is load-bearing at its current pin', () => {
  for (const entry of EXTERNAL_ACTIONS) {
    const without = EXTERNAL_ACTIONS.filter((candidate) => candidate !== entry);
    assert.ok(
      audit(base, baseline, without).length > 0,
      `removing EXTERNAL_ACTIONS ${entry.uses} changed nothing; it is inert`,
    );
  }
});

test('the command PRINTS a finding, rather than only counting it', () => {
  // `audit` emitted `external` while check.ts's heading map did not know the name, so the
  // command reported `1 failure(s)` and none of the guidance.
  const planted = plantWorkflow(
    workflow(
      `      - uses: nobody/unknown@${'0'.repeat(40)}\n        with:\n          script: node -e '1'\n`,
    ),
  );
  const printed = formatFailures(audit(planted, baseline));
  assert.match(printed, /Third-party actions with no declaration:/);
  assert.match(printed, /nobody\/unknown@0{40}/);

  const invented = formatFailures([{ assertion: 'brand-new-kind', message: 'must still print' }]);
  assert.match(invented, /Other failures \(brand-new-kind\)/);
  assert.match(invented, /must still print/);
});
