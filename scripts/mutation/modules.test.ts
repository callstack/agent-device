import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  affectedModules,
  ALL_MODULE_IDS,
  KERNEL_MODULES,
  moduleForFile,
  mutateGlobs,
} from './modules.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('every enumerated kernel path exists', () => {
  for (const module of KERNEL_MODULES) {
    for (const owned of [...module.owns, ...module.tests]) {
      assert.ok(
        fs.existsSync(path.join(repoRoot, owned)),
        `${module.id} owns a path that no longer exists: ${owned}`,
      );
    }
  }
});

/** Repository-relative modules a file imports, following relative specifiers only. */
function imports(file: string): string[] {
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  return [...text.matchAll(/from '(?<spec>\.[^']+)'/g)]
    .map((match) =>
      path.posix.normalize(path.posix.join(path.posix.dirname(file), match.groups!.spec)),
    )
    .filter((resolved) => fs.existsSync(path.join(repoRoot, resolved)));
}

/** Whether `file` reaches `target` through the import graph. */
function reaches(file: string, target: string): boolean {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...imports(current));
  }
  return false;
}

test('each owned test file exercises the module it is listed under', () => {
  for (const module of KERNEL_MODULES) {
    const sources = module.mutate.filter((glob) => !glob.startsWith('!') && !glob.includes('*'));
    if (sources.length === 0) continue; // directory module: ownership is the prefix
    for (const testFile of module.tests) {
      assert.ok(
        sources.some((source) => reaches(testFile, source)),
        `${module.id} lists ${testFile}, which never reaches ${sources.join(', ')}`,
      );
    }
  }
});

test('a kernel source with a mirrored test file lists that test', () => {
  for (const module of KERNEL_MODULES) {
    for (const source of module.mutate.filter(
      (glob) => !glob.startsWith('!') && !glob.includes('*'),
    )) {
      const dir = path.dirname(source);
      const name = path.basename(source, '.ts');
      const mirrors = [`${dir}/${name}.test.ts`, `${dir}/__tests__/${name}.test.ts`].filter(
        (candidate) => fs.existsSync(path.join(repoRoot, candidate)),
      );
      for (const mirror of mirrors) {
        assert.equal(
          moduleForFile(mirror),
          module.id,
          `${mirror} mirrors ${source} but does not select ${module.id}`,
        );
      }
    }
  }
});

test('changed files map onto the module that owns them', () => {
  assert.equal(moduleForFile('src/kernel/errors.ts'), 'kernel-errors');
  assert.equal(moduleForFile('./src/daemon/ref-frame.ts'), 'daemon-ref-frame');
  assert.equal(moduleForFile('src/selectors/parse.ts'), 'selectors');
  // Tests of a kernel are owned too: a weakened test is exactly the change
  // whose mutation score must be re-measured.
  assert.equal(moduleForFile('src/selectors/__tests__/resolve.test.ts'), 'selectors');
  assert.equal(moduleForFile('src/kernel/__tests__/errors.test.ts'), 'kernel-errors');
  assert.equal(moduleForFile('src/daemon/__tests__/ref-frame.test.ts'), 'daemon-ref-frame');
  assert.equal(
    moduleForFile('src/commands/interaction/runtime/settle.test.ts'),
    'interaction-settle',
  );
  assert.equal(
    moduleForFile('src/commands/interaction/runtime/gestures.test.ts'),
    'scroll-edge-state',
  );
  assert.equal(moduleForFile('src/kernel/rect.ts'), undefined);
  assert.equal(moduleForFile('README.md'), undefined);
});

test('affected selection is deduplicated and registry-ordered', () => {
  assert.deepEqual(
    affectedModules([
      'src/selectors/parse.ts',
      'src/selectors/match.ts',
      'src/kernel/errors.ts',
      'docs/agents/testing.md',
    ]),
    ['kernel-errors', 'selectors'],
  );
  assert.deepEqual(affectedModules(['docs/agents/testing.md']), []);
});

test('mutate globs default to every module and narrow on request', () => {
  assert.deepEqual(mutateGlobs(), mutateGlobs(ALL_MODULE_IDS));
  assert.deepEqual(mutateGlobs(['kernel-errors']), ['src/kernel/errors.ts']);
});
