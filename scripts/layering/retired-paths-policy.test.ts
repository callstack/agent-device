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
import { RETIRED_PATH_RULES, retiredPathRuleViolations } from './retired-paths-policy.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function contextWithFiles(
  files: Partial<Pick<LayeringContext, 'sourceFiles' | 'trackedSrcUtilsFiles'>>,
): LayeringContext {
  return {
    sourceFiles: [],
    sources: new Map(),
    allTypeScriptSources: new Map(),
    trackedSrcUtilsFiles: [],
    edges: [],
    typeCycleMembers: [],
    ...files,
  };
}

test('R14 rejects every tracked path under the retired src/utils zone', () => {
  const trackedFiles = ['src/utils', 'src/utils/regrown.ts', 'src/utils/__fixtures__/capture.json'];
  const violations = retiredPathRuleViolations('R14', trackedFiles);

  assert.equal(RETIRED_PATH_RULES.R14.rule, 'R14 src-utils-retirement');
  assert.deepEqual(
    violations,
    trackedFiles.map((file) => ({
      rule: 'R14 src-utils-retirement',
      file,
      line: 1,
      message: 'src/utils is retired; move this path to its owning package or command zone',
    })),
  );
  assert.deepEqual(
    LAYERING_RULES['src-utils-retirement'](
      contextWithFiles({ trackedSrcUtilsFiles: trackedFiles, sourceFiles: trackedFiles }),
    ),
    violations,
  );
});

test('R14 ignores paths outside the retired zone', () => {
  assert.deepEqual(
    retiredPathRuleViolations('R14', [
      'src/snapshot/scroll-edge-state.ts',
      'src/utils-next.ts',
      'src/replay/planted.ts',
      'test/fixtures/src/utils/example.json',
    ]),
    [],
  );
});

test('R71 rejects a planted production file under retired src/replay by name', () => {
  const violations = retiredPathRuleViolations('R71', ['src/replay/planted-production-file.ts']);

  assert.equal(RETIRED_PATH_RULES.R71.rule, 'R71 replay-ownership');
  assert.deepEqual(violations, [
    {
      rule: 'R71 replay-ownership',
      file: 'src/replay/planted-production-file.ts',
      line: 1,
      message:
        'src/replay/ is retired; caller source acquisition belongs under src/commands/replay/ ' +
        'and replay-test presentation belongs under src/cli/replay-test/.',
    },
  ]);
  assert.deepEqual(
    LAYERING_RULES['replay-ownership'](
      contextWithFiles({ sourceFiles: ['src/replay/planted-production-file.ts'] }),
    ),
    violations,
  );
});

test('R71 accepts the current replay owners and ignores the src/utils zone', () => {
  assert.deepEqual(
    retiredPathRuleViolations('R71', [
      'src/commands/replay/script-source-bundle.ts',
      'src/cli/replay-test/reporting.ts',
      'src/daemon/replay-script-source.ts',
      'src/replay-next.ts',
      'src/utils/regrown.ts',
    ]),
    [],
  );
});

test('tracked-path discovery includes top-level and nested retired paths', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-paths-policy-'));
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
      contextWithFiles({ trackedSrcUtilsFiles: listTrackedSrcUtilsFiles(repo) }),
    ).map(({ rule, file }) => ({ rule, file })),
    [
      { rule: 'R14 src-utils-retirement', file: 'src/utils/café.ts' },
      { rule: 'R14 src-utils-retirement', file: 'src/utils/nested/capture.json' },
      { rule: 'R14 src-utils-retirement', file: 'src/utils/regrown.ts' },
    ],
  );
});

test('tracked-path discovery includes an exact retired root entry', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-paths-policy-root-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/utils'), 'retired root\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });

  assert.deepEqual(listTrackedSrcUtilsFiles(repo), ['src/utils']);
});

test('the committed tree has no tracked path under a retired directory', () => {
  assert.deepEqual(
    LAYERING_RULES['src-utils-retirement'](
      contextWithFiles({ trackedSrcUtilsFiles: listTrackedSrcUtilsFiles(repoRoot) }),
    ),
    [],
  );
});
