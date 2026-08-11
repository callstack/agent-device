// The wiring assertions that keep `owned` honest.
//
// `owned` says "some qualifying lane runs this check". Four things could make that claim
// true on paper and false in CI, and each has an assertion here: an id that names no check,
// an `if:` that stops the step running, an action trusted to run a gate it does not, and a
// job whose steps this loader cannot see at all.
//
// Cases are planted as real YAML and read by the REAL loader against the REAL actions, so
// parse, resolution and audit are exercised together.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { audit, formatFailures } from './audit.ts';
import { GATE_CONDITIONS } from './declarations.ts';
import { loadModel, type Model } from './model.ts';
import { creditsUnder, gateIdsIn, loadLanes } from './workflows.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const base = loadModel(repoRoot, tracked);

const mutate = (change: (model: Model) => Partial<Model>): Model => ({ ...base, ...change(base) });

/**
 * Load a planted workflow with the REAL loader against the REAL actions, so parse,
 * resolution and audit are exercised together rather than a hand-built lane.
 */
function plantWorkflow(yaml: string): Model {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lane-'));
  try {
    fs.writeFileSync(path.join(dir, 'planted.yml'), yaml);
    return mutate((model) => ({
      lanes: [...model.lanes, ...loadLanes(dir, repoRoot, base.scripts)],
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

const found = (model: Model) => audit(model).map((failure) => failure.message);
const kinds = (model: Model) => [...new Set(audit(model).map((f) => f.assertion))].sort();

test('the live tree is green — every planted failure below is a real difference', () => {
  assert.deepEqual(found(base), []);
});

test('a gate id that names no registered check is reported', () => {
  const model = plantWorkflow(
    workflow(`      - name: Planted
        run: pnpm gate not-a-real-check`),
  );
  assert.ok(found(model).some((m) => /"not-a-real-check" names no registered check/.test(m)));
});

test('a gate behind an undeclared `if:` earns no credit and is named', () => {
  const model = plantWorkflow(
    workflow(`      - name: Planted
        if: github.actor == 'nobody'
        run: pnpm gate layering`),
  );
  const messages = found(model);
  assert.ok(messages.some((m) => /GATE_CONDITIONS does not rule on/.test(m)));
  assert.ok(messages.some((m) => /github\.actor == 'nobody'/.test(m)));
});

test('`credits: false` denies credit as deliberately as an undeclared condition', () => {
  assert.equal(creditsUnder('failure()'), false);
  assert.equal(GATE_CONDITIONS['failure()']?.credits, false);
  assert.equal(creditsUnder('always()'), true);
  assert.equal(creditsUnder(null), true);
  assert.equal(creditsUnder('some condition nobody declared'), false);
});

test('a gate-valued action is proven to run its gate, not trusted to', () => {
  // The declaration says this action runs whatever `gate:` names. If the body does not,
  // every caller's ownership credit rests on the declaration alone. The proof is read from
  // the real action file, so this replaces what the model read rather than planting a tree.
  const action = '.github/actions/setup-apple-runner-build/action.yml';
  assert.ok(base.gateActionBodies[action], 'the real action must still be proven');
  const model = mutate(() => ({
    gateActionBodies: {
      [action]: { run: 'echo "not running the gate"', boundTo: null, condition: null },
    },
  }));
  assert.ok(
    found(model).some((m) => /body does not invoke .*pnpm gate "\$INPUT_GATE"/.test(m)),
    'the audit must reject an action whose body does not honour GATE_ACTIONS',
  );
});

test('a job whose steps the loader cannot open is reported rather than read as empty', () => {
  const model = plantWorkflow(`name: Planted
on:
  pull_request:
jobs:
  planted:
    uses: ./.github/workflows/_reusable.yml`);
  assert.ok(
    found(model).some((m) => /runs steps this loader never opens/.test(m)),
    'a reusable-workflow job hides its gates, so it must fail closed',
  );
});

test('a composite-action cycle throws rather than reporting an empty step list', () => {
  assert.throws(
    () =>
      plantTree({
        '.github/workflows/planted.yml': `name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
      - uses: ./.github/actions/loop-a`,
        '.github/actions/loop-a/action.yml': `name: 'A'
description: 'a'
runs:
  using: composite
  steps:
    - uses: ./.github/actions/loop-b`,
        '.github/actions/loop-b/action.yml': `name: 'B'
description: 'b'
runs:
  using: composite
  steps:
    - uses: ./.github/actions/loop-a`,
      }),
    /composite action cycle/,
  );
});

test('gates inside a composite action are credited to the calling lane', () => {
  const model = plantTree({
    '.github/workflows/planted.yml': `name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
      - uses: ./.github/actions/runs-a-gate`,
    '.github/actions/runs-a-gate/action.yml': `name: 'Nested'
description: 'runs a gate from inside an action'
runs:
  using: composite
  steps:
    - shell: bash
      run: pnpm gate not-a-real-check`,
  });
  assert.ok(
    found(model).some((m) => /"not-a-real-check" names no registered check/.test(m)),
    'a gate one level inside an action must be seen',
  );
});

test('a conditional `uses:` withholds credit from everything the action reaches', () => {
  const model = plantTree({
    '.github/workflows/planted.yml': `name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
      - uses: ./.github/actions/runs-a-gate
        if: github.actor == 'nobody'`,
    '.github/actions/runs-a-gate/action.yml': `name: 'Nested'
description: 'runs a gate from inside an action'
runs:
  using: composite
  steps:
    - shell: bash
      run: pnpm gate layering`,
  });
  assert.ok(found(model).some((m) => /github\.actor == 'nobody'/.test(m)));
});

test('a non-qualifying workflow earns no credit', () => {
  // Release and dispatch lanes do not gate the way in, so a check only they run is unowned.
  const model = plantWorkflow(`name: Planted
on:
  workflow_dispatch:
jobs:
  planted:
    steps:
      - name: Planted
        run: pnpm gate not-a-real-check`);
  assert.ok(
    !found(model).some((m) => /not-a-real-check/.test(m)),
    'a dispatch-only lane is not part of the manifest at all',
  );
});

test('every failure kind the audit can emit has a heading in the report', () => {
  // A new assertion added to audit() but not to HEADINGS would still print, but under a
  // fallback heading — this keeps the two from drifting silently.
  const messages = formatFailures([
    { assertion: 'owned', message: 'a' },
    { assertion: 'brand-new', message: 'b' },
  ]);
  assert.match(messages, /Registered checks no lane runs:/);
  assert.match(messages, /Other failures \(brand-new\):/);
  assert.match(messages, /2 failure\(s\)/);
});

test('planted failures are reported under the assertion that owns them', () => {
  const model = plantWorkflow(
    workflow(`      - name: Planted
        if: github.actor == 'nobody'
        run: pnpm gate not-a-real-check`),
  );
  assert.deepEqual(kinds(model), ['condition']);
});

// --- Crediting is by execution shape, not by text appearing in a body -----------------
//
// #1429: "Do not infer reachability from a command name merely appearing in workflow text."
// A substring scan did exactly that. Each row is a body that NAMES a gate without running
// it, and must therefore leave the check unowned.

const DEAD_TEXT: [string, string][] = [
  ['right operand of &&', 'false && pnpm gate layering'],
  ['right operand of ||', 'true || pnpm gate layering'],
  ['argument to echo', 'echo pnpm gate layering'],
  ['quoted in a message', 'echo "run pnpm gate layering to fix this"'],
  ['inside a false branch', 'if false; then\n  pnpm gate layering\nfi'],
  ['inside a heredoc', "cat <<'EOF'\npnpm gate layering\nEOF"],
  ['after a shell comment', 'echo hi\n# pnpm gate layering'],
  ['not the first command', 'echo hi; pnpm gate layering'],
];

for (const [name, run] of DEAD_TEXT) {
  test(`a gate ${name} earns no credit`, () => {
    assert.deepEqual(gateIdsIn(run), [], `"${run.replace(/\n/g, '\\n')}" must not credit`);
  });
}

const LIVE: [string, string, string[]][] = [
  ['a bare invocation', 'pnpm gate layering', ['layering']],
  ['one per line', 'pnpm gate build\npnpm gate package', ['build', 'package']],
  ['with arguments', 'pnpm gate fallow --base "$FALLOW_BASE"', ['fallow']],
  ['after another command', 'pnpm clean:daemon\npnpm gate unit', ['unit']],
  ['behind an env prefix', 'CI=1 pnpm gate lint', ['lint']],
  ['with a pnpm flag', 'pnpm --silent gate lint', ['lint']],
  [
    'captured from a substitution',
    'modules=$(pnpm --silent gate mutation-affected --list-affected | tail -n1)',
    ['mutation-affected'],
  ],
  ['carrying a GitHub expression', 'pnpm gate coverage --base "${{ github.sha }}"', ['coverage']],
];

for (const [name, run, expected] of LIVE) {
  test(`a gate ${name} is credited`, () => {
    assert.deepEqual(gateIdsIn(run), expected);
  });
}

test('a job-level `if:` guards every gate the job reaches', () => {
  // Six live jobs carry one, and it was not modelled at all: a job that cannot run still
  // credited every gate inside it.
  const model = plantWorkflow(`name: Planted
on:
  pull_request:
jobs:
  planted:
    if: github.actor == 'nobody'
    steps:
      - name: Planted
        run: pnpm gate layering`);
  assert.ok(
    found(model).some((m) => /github\.actor == 'nobody'/.test(m)),
    'the job-level condition must reach the sighting',
  );
});

test("a caller's crediting `if:` cannot erase an inner `if: false`", () => {
  // `guard[0] ?? step.condition` REPLACED the nested condition, so an outer `always()` over
  // an inner `if: false` credited a gate that cannot execute. Every guard has to hold.
  const model = plantTree({
    '.github/workflows/planted.yml': `name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
      - uses: ./.github/actions/inner-false
        if: always()`,
    '.github/actions/inner-false/action.yml': `name: 'Inner'
description: 'a gate its own step disables'
runs:
  using: composite
  steps:
    - shell: bash
      if: false
      run: pnpm gate layering`,
  });
  const messages = found(model);
  assert.ok(
    messages.some((m) => /if: false/.test(m)),
    `the inner 'if: false' must survive the outer always(): ${messages.join(' | ')}`,
  );
});
