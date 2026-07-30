import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const perfNightlyWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'perf-nightly.yml'),
  'utf8',
);
const packageSmokeWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'package-smoke.yml'),
  'utf8',
);

function script(name: string): string {
  const value = packageJson.scripts[name];
  assert.ok(value, `package.json must define "${name}"`);
  return value;
}

test('prepack builds the complete package without stopping the development daemon', () => {
  assert.equal(script('prepack'), 'pnpm check:mcp-metadata && pnpm package:npm');
  assert.doesNotMatch(script('package:npm'), /clean:daemon|rebuild:cli/);
  assert.equal(packageJson.scripts['build:dev'], undefined);
  assert.match(packageSmokeWorkflow, /run: pnpm prepack/);
  for (const input of [
    'pnpm-workspace.yaml',
    'packages/**',
    'scripts/patch-xcuitest-runner-icon.ts',
    'scripts/sync-mcp-metadata.mjs',
    'scripts/write-xcuitest-cache-metadata.mjs',
    '.github/actions/setup-node-pnpm/**',
  ]) {
    assert.ok(packageSmokeWorkflow.includes(`- '${input}'`));
  }
});

test('perf uses one platform-selectable entry point', () => {
  assert.equal(script('perf'), 'node --experimental-strip-types scripts/perf/run.ts');
  assert.equal(packageJson.scripts['perf:ios'], undefined);
  assert.equal(packageJson.scripts['perf:android'], undefined);
  assert.doesNotMatch(perfNightlyWorkflow, /pnpm perf:/);
  assert.match(perfNightlyWorkflow, /pnpm perf --platform ios/);
  assert.match(perfNightlyWorkflow, /pnpm perf --platform android/);
});

test('Fallow exposes one changed-code gate and an explicit full-tree audit', () => {
  assert.equal(packageJson.scripts.fallow, undefined);
  assert.equal(script('check:fallow'), 'fallow audit');
  assert.equal(script('fallow:all'), 'fallow --summary');
});

test('the npm package build covers every package-owned build output', () => {
  assert.deepEqual(script('package:npm').split(' && '), [
    'pnpm build',
    'pnpm build:xcuitest:ios',
    'pnpm build:xcuitest:macos',
    'pnpm build:xcuitest:tvos',
    'pnpm build:xcuitest:visionos',
    'pnpm build:macos-helper:clean',
    'pnpm package:apple-runner:npm',
    'pnpm build:android',
  ]);

  assert.deepEqual(script('build:android').split(' && '), [
    'pnpm package:android-snapshot-helper:npm',
    'pnpm package:android-ime-helper:npm',
  ]);
});
