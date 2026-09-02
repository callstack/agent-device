import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LAYERING_RULES, type LayeringContext } from './check.ts';
import {
  listTrackedPackageManifests,
  listTrackedSrcUtilsFiles,
  listTrackedTypeScriptFiles,
} from './tracked-sources.ts';
import { SRC_UTILS_RETIREMENT_RULE, srcUtilsRetirementViolations } from './src-utils-retirement.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function contextWithTrackedSrcUtilsFiles(trackedSrcUtilsFiles: readonly string[]): LayeringContext {
  return {
    sourceFiles: [],
    sources: new Map(),
    allTypeScriptSources: new Map(),
    trackedSrcUtilsFiles,
    edges: [],
    typeCycleMembers: [],
  };
}

test('R14 rejects every tracked path under the retired src/utils zone', () => {
  const trackedFiles = ['src/utils', 'src/utils/regrown.ts', 'src/utils/__fixtures__/capture.json'];
  const violations = srcUtilsRetirementViolations(trackedFiles);

  assert.equal(SRC_UTILS_RETIREMENT_RULE, 'R14 src-utils-retirement');
  assert.deepEqual(
    violations.map(({ rule, file }) => ({ rule, file })),
    trackedFiles.map((file) => ({ rule: SRC_UTILS_RETIREMENT_RULE, file })),
  );
  assert.deepEqual(
    LAYERING_RULES['src-utils-retirement'](contextWithTrackedSrcUtilsFiles(trackedFiles)),
    violations,
  );
  for (const violation of violations) {
    assert.match(violation.message, /src\/utils is retired; move this path/);
  }
});

test('R14 ignores paths outside the retired zone', () => {
  assert.deepEqual(
    srcUtilsRetirementViolations([
      'src/snapshot/scroll-edge-state.ts',
      'src/utils-next.ts',
      'test/fixtures/src/utils/example.json',
    ]),
    [],
  );
});

test('tracked-path discovery includes top-level and nested retired paths', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'src-utils-retirement-'));
  fs.mkdirSync(path.join(repo, 'src/utils/nested'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'packages/example/src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src/snapshot'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/café.ts'), 'export {}\n');
  fs.writeFileSync(path.join(repo, 'src/utils/café.ts'), 'export {}\n');
  fs.writeFileSync(path.join(repo, 'src/utils/regrown.ts'), 'export {}\n');
  fs.writeFileSync(path.join(repo, 'src/utils/nested/capture.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'src/snapshot/current.ts'), 'export {}\n');
  fs.writeFileSync(path.join(repo, 'packages/example/package.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'packages/example/src/café.ts'), 'export {}\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });

  assert.deepEqual(listTrackedSrcUtilsFiles(repo), [
    'src/utils/café.ts',
    'src/utils/nested/capture.json',
    'src/utils/regrown.ts',
  ]);
  assert.deepEqual(listTrackedTypeScriptFiles(repo), [
    'packages/example/src/café.ts',
    'src/café.ts',
    'src/snapshot/current.ts',
    'src/utils/café.ts',
    'src/utils/regrown.ts',
  ]);
  assert.deepEqual(listTrackedPackageManifests(repo), ['packages/example/package.json']);
  assert.deepEqual(
    LAYERING_RULES['src-utils-retirement'](
      contextWithTrackedSrcUtilsFiles(listTrackedSrcUtilsFiles(repo)),
    ).map(({ rule, file }) => ({ rule, file })),
    [
      { rule: SRC_UTILS_RETIREMENT_RULE, file: 'src/utils/café.ts' },
      { rule: SRC_UTILS_RETIREMENT_RULE, file: 'src/utils/nested/capture.json' },
      { rule: SRC_UTILS_RETIREMENT_RULE, file: 'src/utils/regrown.ts' },
    ],
  );
});

test('tracked-path discovery includes an exact retired root entry', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'src-utils-retirement-root-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/utils'), 'retired root\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });

  assert.deepEqual(listTrackedSrcUtilsFiles(repo), ['src/utils']);
});

test('the committed tree has no tracked src/utils path', () => {
  assert.deepEqual(
    LAYERING_RULES['src-utils-retirement'](
      contextWithTrackedSrcUtilsFiles(listTrackedSrcUtilsFiles(repoRoot)),
    ),
    [],
  );
});
