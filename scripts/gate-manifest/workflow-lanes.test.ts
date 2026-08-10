// Workflow and composite-action parsing into lanes.

import assert from 'node:assert/strict';
import test from 'node:test';
import { context, lanesFor } from './test-context.ts';

const BUILD_ACTION = `
name: 'Build'
inputs:
  build-command:
    default: 'pnpm build:default'
runs:
  using: 'composite'
  steps:
    - name: Build
      run: \${{ inputs.build-command }}
`;

test("a composite action's steps are walked, with inputs substituted from the caller", () => {
  // ci.yml's Swift job passes its real build command as an action input; without substitution
  // the whole Swift build lane looks unowned (and `${{ … }}` looks like dynamic dispatch).
  const ctx = context({
    actions: new Map([['.github/actions/build', BUILD_ACTION]]),
    packageScripts: new Map([['build:xcuitest:macos', 'sh ./scripts/build-xcuitest-apple.sh']]),
  });
  const [lane] = lanesFor(
    {
      'ci.yml':
        'jobs:\n  swift:\n    steps:\n      - uses: ./.github/actions/build\n' +
        '        with:\n          build-command: pnpm build:xcuitest:macos\n',
    },
    ctx,
  );
  assert.deepEqual([...lane!.terminals], ['exec:scripts/build-xcuitest-apple.sh']);
  assert.deepEqual(lane!.unresolved, []);
});

test("an action input the caller omits falls back to the action's declared default", () => {
  const ctx = context({
    actions: new Map([['.github/actions/build', BUILD_ACTION]]),
    packageScripts: new Map([['build:default', 'node scripts/build.ts']]),
  });
  const [lane] = lanesFor(
    { 'ci.yml': 'jobs:\n  swift:\n    steps:\n      - uses: ./.github/actions/build\n' },
    ctx,
  );
  assert.deepEqual([...lane!.terminals], ['exec:scripts/build.ts']);
});

test('a local action that does not exist fails closed', () => {
  const [lane] = lanesFor(
    { 'ci.yml': 'jobs:\n  gate:\n    steps:\n      - uses: ./.github/actions/gone\n' },
    context(),
  );
  assert.deepEqual(
    lane!.unresolved.map(({ kind, detail }) => `${kind}: ${detail}`),
    ['missing-action: local action "./.github/actions/gone" does not exist'],
  );
});

test('a matrix job whose name interpolates claims no check name rather than a literal one', () => {
  const lanes = lanesFor(
    {
      'm.yml':
        'name: M\non:\n  pull_request:\njobs:\n  shard:\n    name: Mutants (${{ matrix.name }})\n' +
        '    steps:\n      - run: pnpm mutation:run\n',
    },
    context({ packageScripts: new Map([['mutation:run', 'node scripts/mutation/run.ts']]) }),
  );
  assert.deepEqual(lanes[0]!.checkNames, []);
});

test('a lane is classified by how its workflow is triggered', () => {
  const lanes = lanesFor(
    {
      'pr.yml': 'name: P\non:\n  pull_request:\njobs:\n  a:\n    steps: []\n',
      'nightly.yml':
        'name: N\non:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  b:\n    steps: []\n',
      'release.yml':
        'name: R\non:\n  release:\n    types: [published]\njobs:\n  c:\n    steps: []\n',
    },
    context(),
  );
  assert.deepEqual(lanes.map((lane) => `${lane.job}:${lane.kind}`).sort(), [
    'a:pull-request',
    'b:scheduled',
    'c:release',
  ]);
});
