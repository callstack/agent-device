import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KERNEL_MODULES } from './modules.ts';
import {
  derivedAffectedModules,
  isTestFile,
  mutatedSources,
  ownedTestFiles,
  ownershipDeriver,
  reachableFrom,
} from './ownership.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('a kernel is owned by the mirrored test that imports it directly', () => {
  const deriver = ownershipDeriver(repoRoot);
  assert.deepEqual(deriver.ownersOf('src/__tests__/kernel/errors-code-policy.test.ts'), [
    'kernel-errors',
  ]);
  assert.ok(
    deriver.ownersOf('src/daemon/__tests__/ref-frame.test.ts').includes('daemon-ref-frame'),
  );
  assert.ok(
    deriver
      .ownersOf('src/commands/interaction/runtime/settle.test.ts')
      .includes('interaction-settle'),
  );
});

// The omission that hand-listed ownership could not see: this test asserts over
// normalizeError without importing packages/kernel/src/errors.ts itself.
test('a kernel is owned by tests that reach it indirectly', () => {
  const deriver = ownershipDeriver(repoRoot);
  assert.ok(
    deriver.ownersOf('src/__tests__/daemon-error.test.ts').includes('kernel-errors'),
    'daemon-error.test.ts exercises normalizeError but does not own kernel-errors',
  );
  assert.ok(
    deriver
      .ownersOf('src/commands/interaction/runtime/gestures.test.ts')
      .includes('scroll-edge-state'),
  );
});

test('ownership is complete: every test reaching a kernel owns it', () => {
  const owned = ownedTestFiles(repoRoot);
  const cache = new Map<string, string[]>();
  for (const module of KERNEL_MODULES) {
    const sources = mutatedSources(module, repoRoot);
    assert.ok(sources.length > 0, `${module.id} mutates nothing`);
    const files = owned.get(module.id) ?? [];
    assert.ok(
      files.length > 0,
      `${module.id} has no owning tests — its score cannot be attributed`,
    );
    for (const testFile of files) {
      const reachable = reachableFrom(testFile, repoRoot, cache);
      assert.ok(
        sources.some((source) => reachable.has(source)),
        `${testFile} owns ${module.id} without reaching it`,
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
  assert.ok(isTestFile('src/__tests__/kernel/errors-code-policy.test.ts'));
});

test('derived selection unions source ownership with test reachability', () => {
  assert.deepEqual(
    derivedAffectedModules(
      [
        'src/selectors/parse.ts',
        'src/daemon/__tests__/ref-frame.test.ts',
        'docs/agents/testing.md',
      ],
      repoRoot,
    ).filter((id) => id === 'selectors' || id === 'daemon-ref-frame'),
    ['daemon-ref-frame', 'selectors'],
  );
});
