// What the loader derives from the real workflow tree, plus the two structural cases the
// tree cannot show: a composite-action cycle, and an action whose source is not here.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { loadModel } from './model.ts';
import { loadLanes, matchesGlob, verbatimScripts } from './workflows.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const model = loadModel(repoRoot, tracked);

test('the canonical action binds and runs a structural gate without optional arguments', () => {
  const action = parse(
    fs.readFileSync(path.join(repoRoot, '.github/actions/run-gate/action.yml'), 'utf8'),
  ) as {
    inputs: { gate: { required: boolean } };
    runs: { steps: { env?: Record<string, string>; run?: string }[] };
  };
  assert.equal(action.inputs.gate.required, true);
  const runner = action.runs.steps.at(-1);
  assert.equal(runner?.env?.INPUT_GATE, '${{ inputs.gate }}');
  assert.match(runner?.run ?? '', /pnpm gate "\$INPUT_GATE"/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-gate-'));
  try {
    const mockPnpm = path.join(root, 'pnpm');
    fs.writeFileSync(mockPnpm, '#!/bin/bash\nprintf "%s\\n" "$@"\n');
    fs.chmodSync(mockPnpm, 0o755);
    const stdout = execFileSync('/bin/bash', ['-c', runner?.run ?? ''], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ''}`,
        INPUT_GATE: 'layering',
        INPUT_ARGS: '',
        GITHUB_OUTPUT: path.join(root, 'output'),
      },
    });
    assert.equal(stdout, 'gate\nlayering\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Write a workflow (and optionally a tree of actions) and load it with the real loader. */
function planted(files: Record<string, string>): ReturnType<typeof loadLanes> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-wf-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.join(root, path.dirname(name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), body);
    }
    return loadLanes(path.join(root, '.github/workflows'), root, model.scripts);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a command repeating a script body verbatim credits that script', () => {
  const body = model.scripts['check:package'] as string;
  assert.deepEqual(verbatimScripts(body, model.scripts), ['check:package']);
  assert.deepEqual(verbatimScripts('node scripts/something-else.ts', model.scripts), []);
});

test('path filters use GitHub glob semantics', () => {
  assert.equal(matchesGlob('website/**', 'website/docs/docs/commands.md'), true);
  assert.equal(matchesGlob('docs/**', 'website/docs/x.md'), false);
  assert.equal(matchesGlob('*.md', 'README.md'), true);
  assert.equal(matchesGlob('*.md', 'docs/README.md'), false, '* must not span a separator');
});

test('lanes carry the workflow spelling the catalog used, and only real triggers qualify', () => {
  const labels = model.lanes.map((lane) => lane.label);
  assert.ok(labels.includes('Coverage'), 'CI jobs are named bare');
  assert.ok(labels.includes('iOS / Smoke Tests'), 'other workflows are prefixed');
  const deploy = model.lanes.find((lane) => lane.workflow === 'deploy.yml');
  assert.equal(deploy?.qualifying, false, 'a push-only lane gates nothing on the way in');
});

test('a workflow_dispatch-only lane owns nothing, however many gates it declares', () => {
  const [lane] = planted({
    '.github/workflows/planted.yml': `name: Planted
on:
  workflow_dispatch:
jobs:
  planted:
    steps:
      - uses: ./.github/actions/run-gate
        with:
          gate: replay-ios`,
  });
  assert.deepEqual(lane?.gates, ['replay-ios'], 'the gate is still read');
  assert.equal(lane?.qualifying, false, 'but nothing dispatches itself, so it owns nothing');
  assert.deepEqual(lane?.triggers, ['workflow_dispatch'], 'the trigger kind survives the model');
});

// `qualifying` collapses every trigger into one bit, and two very different lanes share the
// `false` side of it: one a human starts, one that starts itself on every push.
test('trigger kinds survive the model, not just whether they qualify', () => {
  const [push] = planted({
    '.github/workflows/planted.yml': `name: Planted
on:
  push:
    branches: [main]
jobs:
  planted:
    steps:
      - run: echo hi`,
  });
  assert.equal(push?.qualifying, false);
  assert.deepEqual(push?.triggers, ['push']);
  const nightly = model.lanes.find((lane) => lane.workflow === 'replays-nightly.yml');
  assert.deepEqual(nightly?.triggers, ['schedule', 'workflow_dispatch']);
});

test('a gate invoked from inside a composite action belongs to the calling lane', () => {
  const android = model.lanes.find((lane) => lane.label === 'Android / Smoke Tests');
  assert.ok(
    android?.gates.includes('android-helpers'),
    'the helper build is reached through the setup action',
  );
});

test('a composite action cycle is a loud error, not an empty step list', () => {
  // The depth cutoff this replaces returned no steps, which reads to every assertion
  // downstream as "this action executes nothing" — silence in the one place that must shout.
  assert.throws(
    () =>
      planted({
        '.github/workflows/planted.yml': `name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
      - uses: ./.github/actions/a
`,
        '.github/actions/a/action.yml': `runs:
  using: composite
  steps:
    - uses: ./.github/actions/b
`,
        '.github/actions/b/action.yml': `runs:
  using: composite
  steps:
    - uses: ./.github/actions/a
`,
      }),
    /composite action cycle/,
  );
});

test('nesting deeper than the old cutoff is followed rather than silently dropped', () => {
  const nested = (next: string) => `runs:
  using: composite
  steps:
    - uses: ./.github/actions/${next}
`;
  const lanes = planted({
    '.github/workflows/planted.yml': `name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
      - uses: ./.github/actions/a
`,
    '.github/actions/a/action.yml': nested('b'),
    '.github/actions/b/action.yml': nested('c'),
    '.github/actions/c/action.yml': nested('d'),
    '.github/actions/d/action.yml': nested('e'),
    '.github/actions/e/action.yml': `runs:
  using: composite
  steps:
    - uses: ./.github/actions/run-gate
      with:
        gate: layering
`,
  });
  assert.deepEqual(
    lanes[0]?.gates,
    ['layering'],
    'a gate five levels down is still credited to the lane',
  );
});
