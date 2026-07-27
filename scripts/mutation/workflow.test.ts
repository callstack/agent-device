// The workflows' YAML cannot read the kernel registry, so these assertions keep
// the two in step: a module added to KERNEL_MODULES that no weekly shard runs
// would silently drop out of the sweep, and one no PR path filter selects would
// silently stop gating once the ratchet graduates.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ALL_MODULE_IDS, KERNEL_MODULES } from './modules.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function workflow(name: string): string {
  return fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8');
}

test('the weekly sweep shards exactly the registry modules', () => {
  const yaml = workflow('mutation-weekly.yml');
  const shards = [...yaml.matchAll(/^ {10}- (?<id>[a-z-]+)$/gm)].map((match) => match.groups!.id);
  assert.deepEqual(shards, [...ALL_MODULE_IDS]);
});

test('the weekly sweep merges the shards into one ratcheted verdict', () => {
  const yaml = workflow('mutation-weekly.yml');
  assert.match(yaml, /pnpm mutation:check --report-dir/);
  assert.match(yaml, /GITHUB_STEP_SUMMARY|\$GITHUB_STEP_SUMMARY/);
});

test('every kernel path a PR can touch selects the affected mutation job', () => {
  const paths = [...workflow('mutation-affected.yml').matchAll(/^ {6}- "(?<glob>[^"]+)"$/gm)].map(
    (match) => match.groups!.glob,
  );
  for (const module of KERNEL_MODULES) {
    for (const owned of module.owns) {
      const selected = paths.some((glob) => glob === owned || glob === `${owned}**`);
      assert.ok(selected, `no path filter selects ${owned} (module ${module.id})`);
    }
  }
  // The lane's own sources fail open into it too: a ratchet or baseline edit must
  // prove itself against real mutants, not against a stale report.
  for (const own of ['scripts/mutation/**', 'stryker.config.json', 'mutation-baselines/**']) {
    assert.ok(paths.includes(own), `missing path filter ${own}`);
  }
});
