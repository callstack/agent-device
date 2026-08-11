// What the loader derives from the real workflow tree, plus the two structural cases the
// tree cannot show: a composite-action cycle, and an action whose source is not here.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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

test('a gate invoked from inside a composite action belongs to the calling lane', () => {
  const android = model.lanes.find((lane) => lane.label === 'Android / Smoke Tests');
  assert.ok(
    android?.gates.includes('android-helpers'),
    'the helper build is reached through the setup action',
  );
});

test('a gate invoked inside a third-party action’s script input belongs to the lane too', () => {
  // Round 6: `android-emulator-runner`'s `script:` is where the Android smoke lane does all
  // of its work, including `pnpm gate build`. Before that input was modelled the lane looked
  // like it ran nothing at all.
  const android = model.lanes.find((lane) => lane.label === 'Android / Smoke Tests');
  assert.ok(android?.gates.includes('build'), 'the build gate is inside the emulator script');
  assert.ok(
    android?.externals.some((ref) => ref.startsWith('reactivecircus/android-emulator-runner@')),
    'and the action itself is recorded, so the audit can require a declaration',
  );
});

test('every external action is recorded with its pin, not just its name', () => {
  const refs = [...new Set(model.lanes.flatMap((lane) => lane.externals))];
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${ref} must be pinned to a sha`);
  }
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
    - run: node -e 'require("./scripts/layering/check.ts")'
`,
  });
  assert.deepEqual(
    lanes[0]?.steps.map((step) => step.run),
    [`node -e 'require("./scripts/layering/check.ts")'`],
    'five levels down is still a step of the lane',
  );
});
