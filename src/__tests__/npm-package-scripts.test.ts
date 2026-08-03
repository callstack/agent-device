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
const packagedCliWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
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

// `check:package` verifies the tarball, so it has to observe every build output the package ships —
// it runs last, after the Apple and Android payloads exist, not next to the JS build.
test('the npm package build covers every package-owned build output, then verifies the result', () => {
  assert.deepEqual(script('package:npm').split(' && '), [
    'pnpm build',
    'pnpm build:xcuitest:ios',
    'pnpm build:xcuitest:macos',
    'pnpm build:xcuitest:tvos',
    'pnpm build:xcuitest:visionos',
    'pnpm build:macos-helper:clean',
    'pnpm package:apple-runner:npm',
    'pnpm build:android',
    'pnpm check:package',
  ]);

  assert.deepEqual(script('build:android').split(' && '), [
    'pnpm package:android-snapshot-helper:npm',
    'pnpm package:android-ime-helper:npm',
  ]);
});

// Behavior of the closure audit is pinned by fixtures in
// scripts/__tests__/package-closure-audit.test.ts, which can fail a malformed package the way no
// test of the real gate can. That leaves the wiring: the audit and both runtime probes have to stay
// wired into the gate, or the fixtures would keep passing while the tarball went unchecked.
test('the package gate runs the closure audit and both runtime probes', () => {
  const gate = fs.readFileSync(path.join(repoRoot, 'scripts', 'check-package.ts'), 'utf8');
  for (const call of [
    'auditDependencyClosure(installedRoot, manifest)',
    'importEveryExport(manifest)',
    'smokeTestBin(installedRoot, manifest)',
  ]) {
    assert.ok(gate.includes(call), `scripts/check-package.ts must still call ${call}`);
  }
});

// The gate reads the packed tarball, so `prepack` is the last point where a broken package can still
// be stopped. Publishing runs it; nothing else guarantees the tarball is ever verified.
test('publishing cannot skip the package gate', () => {
  assert.match(script('package:npm'), /pnpm check:package$/);
  assert.match(script('check:tooling'), /pnpm check:package$/);
  // The minimum-Node job runs the script directly — the repo's pinned pnpm needs a newer Node than
  // the floor that job covers — so it must still name the same entry point the script does.
  assert.match(script('check:package'), /scripts\/check-package\.ts$/);
  assert.match(
    packagedCliWorkflow,
    /run: node --experimental-strip-types scripts\/check-package\.ts/,
  );
});
