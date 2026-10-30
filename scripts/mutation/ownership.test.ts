import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import fs from 'node:fs';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { runCmdSync } from '@agent-device/host-kit/command';
import { fileURLToPath } from 'node:url';
import { KERNEL_MODULES } from './modules.ts';
import {
  derivedAffectedModules,
  importedBy,
  isTestFile,
  mutatedSources,
  mutationTestFiles,
  ownedTestFiles,
  ownershipDeriver,
} from './ownership.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('a kernel is owned by the mirrored test that imports it directly', () => {
  const deriver = ownershipDeriver(repoRoot);
  assert.deepEqual(deriver.ownersOf('packages/kernel/src/errors-code-policy.test.ts'), [
    'kernel-errors',
  ]);
  assert.ok(
    deriver
      .ownersOf('packages/daemon/src/core/__tests__/ref-frame.test.ts')
      .includes('daemon-ref-frame'),
  );
  assert.ok(
    deriver
      .ownersOf('src/commands/interaction/runtime/settle.test.ts')
      .includes('interaction-settle'),
  );
});

// Reach is not ownership: nearly every test reaches the error kernel, and a
// reach-based scope is the whole suite. This test exercises edge detection only
// through the back runtime, so it does not measure scroll-edge-state.
test('a test that only reaches a kernel through other modules does not own it', () => {
  const testFile = 'packages/daemon/src/execution/__tests__/back-runtime.test.ts';
  assert.ok(!ownershipDeriver(repoRoot).ownersOf(testFile).includes('scroll-edge-state'));
  assert.ok(!mutationTestFiles(['scroll-edge-state'], repoRoot).includes(testFile));
});

test('a file absent from the tracked graph imports nothing', () => {
  assert.deepEqual([...importedBy('src/untracked-fixture.ts', repoRoot)], []);
});

test('a mutation scope holds no test another Vitest project owns', () => {
  // The apple-runner suites need that project's host setup, which Stryker's run does not install.
  assert.ok(
    !mutationTestFiles(['kernel-errors'], repoRoot).some((file) =>
      file.startsWith('packages/apple-runner/src/'),
    ),
  );
  assert.ok(!isTestFile('packages/apple-runner/src/__tests__/index-dispatch-disclosure.test.ts'));
});

test('a test that takes a kernel through a barrel re-export owns it', () => {
  // `@agent-device/ad-script` re-exports the codec this test exercises.
  assert.ok(
    mutationTestFiles(['target-annotation-serde'], repoRoot).includes(
      'packages/selectors/src/target-evidence.test.ts',
    ),
  );
});

test('a test that runs a kernel through its test support code owns it', () => {
  // `capture()` in scroll-edge-state-fixtures.ts calls the kernel; this test imports only it.
  const testFile =
    'packages/capture-kit/src/snapshot/__tests__/scroll-edge-state-target-resolution.test.ts';
  assert.ok(ownershipDeriver(repoRoot).ownersOf(testFile).includes('scroll-edge-state'));
  assert.ok(mutationTestFiles(['scroll-edge-state'], repoRoot).includes(testFile));
});

test('barrel re-exports reach the module each imported name comes from, and only that one', () => {
  const root = fs.realpathSync(mkdtempForTestSync('mutation-barrels-'));
  try {
    runCmdSync('git', ['init', '--quiet', root]);
    const write = (file: string, source: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source);
    };
    write('package.json', JSON.stringify({ name: 'barrel-fixture', type: 'module' }));
    write('src/kernel.ts', 'export const value = 1;');
    write('src/other.ts', 'export const unrelated = 2;');
    write('src/renamed.ts', "export { value as renamed } from './kernel.ts';");
    write('src/star.ts', "export * from './other.ts';\nexport * from './kernel.ts';");
    write('src/forwarded.ts', "import { value } from './kernel.ts';\nexport { value };");
    write(
      'src/__tests__/helper.ts',
      "import { value } from '../kernel.ts';\nexport const run = () => value;",
    );
    write('src/renamed.test.ts', "import { renamed } from './renamed.ts';");
    write('src/star.test.ts', "import { value } from './star.ts';");
    write('src/star-other.test.ts', "import { unrelated } from './star.ts';");
    write('src/forwarded.test.ts', "import { value } from './forwarded.ts';");
    write('src/helper.test.ts', "import { run } from './__tests__/helper.ts';");
    runCmdSync('git', ['add', '.'], { cwd: root });
    const reaches = (testFile: string) => importedBy(testFile, root).has('src/kernel.ts');
    assert.equal(reaches('src/renamed.test.ts'), true, 'export { a as b } from');
    assert.equal(reaches('src/star.test.ts'), true, 'export * from');
    assert.equal(reaches('src/star-other.test.ts'), false, 'export * of a name the kernel lacks');
    assert.equal(reaches('src/forwarded.test.ts'), true, 'import then export');
    assert.equal(reaches('src/helper.test.ts'), true, 'test support code');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ownership is complete: every test importing a kernel owns it', () => {
  const owned = ownedTestFiles(repoRoot);
  for (const module of KERNEL_MODULES) {
    const sources = mutatedSources(module, repoRoot);
    assert.ok(sources.length > 0, `${module.id} mutates nothing`);
    const files = owned.get(module.id) ?? [];
    assert.ok(
      files.length > 0,
      `${module.id} has no owning tests — its score cannot be attributed`,
    );
    for (const testFile of files) {
      const imported = importedBy(testFile, repoRoot);
      assert.ok(
        sources.some((source) => imported.has(source)),
        `${testFile} owns ${module.id} without importing it`,
      );
    }
    // The converse: a diff to an owning test selects the module on a PR.
    assert.ok(
      derivedAffectedModules([files[0]!], repoRoot).includes(module.id),
      `changing ${files[0]} does not select ${module.id}`,
    );
  }
});

test('non-kernel sources and non-tests are not owned', () => {
  assert.deepEqual(
    derivedAffectedModules(['README.md', 'packages/kernel/src/rect.ts'], repoRoot),
    [],
  );
  assert.ok(!isTestFile('packages/kernel/src/errors.ts'));
  assert.ok(!isTestFile('scripts/mutation/ownership.test.ts'));
  assert.ok(isTestFile('packages/kernel/src/errors-code-policy.test.ts'));
});

test('derived selection unions source ownership with test imports', () => {
  assert.deepEqual(
    derivedAffectedModules(
      [
        'packages/selectors/src/internal/parse.ts',
        'packages/daemon/src/core/__tests__/ref-frame.test.ts',
        'docs/agents/testing.md',
      ],
      repoRoot,
    ).filter((id) => id === 'selectors' || id === 'daemon-ref-frame'),
    ['daemon-ref-frame', 'selectors'],
  );
});
