// The workflows' YAML cannot read the kernel registry, so these assertions keep
// the two in step: a module added to KERNEL_MODULES that no weekly shard runs
// would silently drop out of the sweep, and one no PR path filter selects would
// silently stop gating once the ratchet graduates.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { KERNEL_MODULES, shardMatrix } from './modules.ts';

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

test('the weekly sweep merges the shards into one ratcheted verdict', () => {
  const yaml = workflow('mutation-weekly.yml');
  assert.match(yaml, /pnpm mutation:check --report-dir/);
  assert.match(yaml, /GITHUB_STEP_SUMMARY|\$GITHUB_STEP_SUMMARY/);
  // A dead shard must not be merged into a verdict that looks like a sweep.
  assert.match(
    yaml,
    new RegExp(`--expect-shards ${shardMatrix().length}\\b`),
    'the weekly ratchet does not require the full shard set',
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

test('every kernel path a PR can touch selects the affected mutation job', () => {
  // Quote style is the formatter's business (oxfmt formats the workflow tree), so
  // accept either spelling of the same scalar rather than pinning this gate to it.
  const paths = [
    ...workflow('mutation-affected.yml').matchAll(/^ {6}- (?<q>['"])(?<glob>[^'"]+)\k<q>$/gm),
  ].map((match) => match.groups!.glob);
  for (const module of KERNEL_MODULES) {
    for (const owned of module.owns) {
      const selected = paths.some(
        (glob) =>
          glob === owned ||
          glob === `${owned}**` ||
          (glob.endsWith('/**') && owned.startsWith(glob.slice(0, -2))),
      );
      assert.ok(selected, `no path filter selects ${owned} (module ${module.id})`);
    }
  }
  // Ownership is derived, so any test in src/ can own a kernel; the filter must
  // let all of them through and leave the decision to the `select` job. A
  // narrower filter is exactly the omission the derivation exists to prevent.
  assert.ok(
    paths.includes('src/**/*.test.ts'),
    'the PR lane must trigger on every src test, since test ownership is derived',
  );
  assert.match(workflow('mutation-affected.yml'), /mutation:affected --list-affected/);
  // The lane's own sources fail open into it too: a ratchet or baseline edit must
  // prove itself against real mutants, not against a stale report.
  for (const own of ['scripts/mutation/**', 'stryker.config.json', 'mutation-baselines/**']) {
    assert.ok(paths.includes(own), `missing path filter ${own}`);
  }
});
