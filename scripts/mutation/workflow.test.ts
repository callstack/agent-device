// The workflows' YAML cannot read the kernel registry or the lane's own source
// list, so these assertions keep them in step: a module added to KERNEL_MODULES
// that no weekly shard runs would silently drop out of the sweep, and a PR path
// filter out of step with LANE_TOOLING either lets a harness change merge
// unproven or starts a job that selects nothing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
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

// Asserted in both directions against LANE_TOOLING: a missing path lets a lane
// change merge without its self-test or mutants, and an extra one starts a select
// job that can only answer `[]`.
test('the affected lane triggers on exactly the lane tooling', () => {
  // Quote style is the formatter's business (oxfmt formats the workflow tree), so
  // accept either spelling of the same scalar rather than pinning this gate to it.
  const paths = [
    ...workflow('mutation-affected.yml').matchAll(/^ {6}- (?<q>['"])(?<glob>[^'"]+)\k<q>$/gm),
  ].map((match) => match.groups!.glob);
  const expected = LANE_TOOLING.map((prefix) => (prefix.endsWith('/') ? `${prefix}**` : prefix));
  assert.deepEqual(
    [...paths].sort(),
    [...expected].sort(),
    'the PR path filter drifted from LANE_TOOLING in scripts/mutation/run.ts',
  );
  assert.match(workflow('mutation-affected.yml'), /gate: mutation-affected[\s\S]*--list-affected/);
});

// Selection and scoring must agree on scope, or the report would score shards the
// select job never spent (or expect ones it skipped).
test('manual dispatch widens selection and scoring to the lane dependencies', () => {
  const yaml = parse(workflow('mutation-affected.yml'));
  assert.ok('workflow_dispatch' in yaml.on, 'dependency-only diffs have no way to run the canary');
  assert.equal(
    yaml.env.MUTATION_SCOPE,
    "${{ github.event_name == 'workflow_dispatch' && '--with-dependencies' || '' }}",
  );
  const select = yaml.jobs.select.steps.find((step: { id?: string }) => step.id === 'select');
  assert.match(select.with.args, /\$\{\{ env\.MUTATION_SCOPE \}\}/);
  const score = yaml.jobs.report.steps.find(
    (step: { name: string }) => step.name === 'Score the affected modules',
  );
  assert.equal(score.run.match(/--base "\$MUTATION_BASE" \$MUTATION_SCOPE/g)?.length, 2);
});

test('mutant job budgets include setup and unconditional evidence upload', () => {
  for (const name of ['mutation-weekly.yml', 'mutation-affected.yml']) {
    const jobs = parse(workflow(name)).jobs;
    const job = jobs[name === 'mutation-weekly.yml' ? 'shard' : 'mutants'];
    assert.equal(job['timeout-minutes'], 30, name);
    const steps = job.steps as { name: string; 'timeout-minutes'?: number; if?: string }[];
    const mutantIndex = steps.findIndex((step) => step.name.startsWith('Run mutants for'));
    assert.ok(mutantIndex > 0, name);
    const setup = steps.slice(0, mutantIndex);
    for (const step of setup) {
      assert.ok(
        Number.isInteger(step['timeout-minutes']) && step['timeout-minutes']! > 0,
        `${name}: unbounded setup step ${step.name}`,
      );
    }
    assert.equal(steps[mutantIndex]!['timeout-minutes'], 22, name);
    const setupBudget = setup.reduce((total, step) => total + step['timeout-minutes']!, 0);
    assert.ok(
      job['timeout-minutes'] - setupBudget - steps[mutantIndex]!['timeout-minutes']! >= 5,
      `${name}: setup and mutants consume the evidence/upload budget`,
    );
    assert.equal(
      steps.find((step) => step.name === 'Record a failed shard envelope')?.if,
      'failure() || cancelled()',
      name,
    );
    assert.equal(steps.find((step) => step.name === 'Upload shard report')?.if, 'always()', name);
  }
});
