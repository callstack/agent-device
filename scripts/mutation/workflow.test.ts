// The workflows' YAML cannot read the kernel registry or the lane's own source
// list, so these assertions keep them in step: a module added to KERNEL_MODULES
// that no weekly shard runs would silently drop out of the sweep, and a PR path
// filter out of step with LANE_TOOLING either lets a harness change merge
// unproven or starts a job that selects nothing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { shardMatrix } from './modules.ts';
import { LANE_TOOLING } from './run.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function workflow(name: string): string {
  return fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8');
}

test('the weekly sweep shards exactly the registry matrix', () => {
  const yaml = workflow('mutation-weekly.yml');
  const jobs = [...yaml.matchAll(/^ {10}- \{ (?<entry>[^}]+) \}$/gm)].map((match) =>
    Object.fromEntries(
      match
        .groups!.entry.split(', ')
        .map((pair) => pair.split(': ') as [string, string])
        .map(([key, value]) => [key, value]),
    ),
  );
  assert.deepEqual(
    jobs,
    shardMatrix().map((spec) =>
      spec.shard ? { ...spec } : { name: spec.name, module: spec.module },
    ),
  );
});

test('the weekly sweep merges the shards into one score table', () => {
  const yaml = workflow('mutation-weekly.yml');
  assert.match(yaml, /gate: mutation-check[\s\S]*--report-dir/);
  assert.match(yaml, /GITHUB_STEP_SUMMARY|\$GITHUB_STEP_SUMMARY/);
  // A dead shard must not be merged into a table that looks like a sweep.
  assert.match(
    yaml,
    new RegExp(`--expect-shards\\s+${shardMatrix().length}\\b`),
    'the weekly report does not require the full shard set',
  );
});

// A shard that outruns the job timeout reports nothing, so the per-shard budget
// is the acceptance criterion made mechanical.
test('no mutation shard is allowed to exceed the 30-minute budget', () => {
  for (const name of ['mutation-weekly.yml', 'mutation-affected.yml']) {
    for (const [, minutes] of workflow(name).matchAll(/timeout-minutes: (\d+)/g)) {
      assert.ok(Number(minutes) <= 30, `${name} declares a ${minutes}-minute job`);
    }
  }
});

// Only a harness diff can produce a non-empty matrix, so the trigger is asserted
// in both directions against LANE_TOOLING: a missing path lets a harness change
// merge without ever running a mutant, and an extra one starts a select job that
// can only answer `[]`.
test('the affected lane triggers on exactly the lane sources that can select mutants', () => {
  // Quote style is the formatter's business (oxfmt formats the workflow tree), so
  // accept either spelling of the same scalar rather than pinning this gate to it.
  const paths = [
    ...workflow('mutation-affected.yml').matchAll(/^ {6}- (?<q>['"])(?<glob>[^'"]+)\k<q>$/gm),
  ].map((match) => match.groups!.glob);
  const expected = [
    ...LANE_TOOLING.map((prefix) => (prefix.endsWith('/') ? `${prefix}**` : prefix)),
    // The workflow reruns itself so a trigger edit is proven by the lane it edits.
    '.github/workflows/mutation-affected.yml',
  ];
  assert.deepEqual(
    [...paths].sort(),
    [...expected].sort(),
    'the PR path filter drifted from LANE_TOOLING in scripts/mutation/run.ts',
  );
  assert.match(workflow('mutation-affected.yml'), /gate: mutation-affected[\s\S]*--list-affected/);
});
