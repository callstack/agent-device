import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function script(name: string): string {
  const value = packageJson.scripts[name];
  assert.ok(value, `package.json must define "${name}"`);
  return value;
}

test('prepack builds the complete package without stopping the development daemon', () => {
  assert.equal(script('prepack'), 'pnpm check:mcp-metadata && pnpm package:npm');
  assert.doesNotMatch(script('package:npm'), /clean:daemon|rebuild:cli/);
  assert.equal(packageJson.scripts['build:dev'], undefined);
});

test('perf uses one platform-selectable entry point', () => {
  assert.equal(script('perf'), 'node --experimental-strip-types scripts/perf/run.ts');
  assert.equal(packageJson.scripts['perf:ios'], undefined);
  assert.equal(packageJson.scripts['perf:android'], undefined);
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
