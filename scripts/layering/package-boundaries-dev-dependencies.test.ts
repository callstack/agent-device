// R11 and devDependencies: a private package declares siblings in `dependencies`, and only test
// support (tests, `*.fixtures.*` files, test trees) may also resolve through its `devDependencies`,
// so a test-only sibling such as test-kit never becomes a runtime dependency. Production source
// still needs the production field. Compact sibling of package-boundaries.test.ts, which sits at
// its size ratchet.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkPackageInternalSites,
  specifierSites,
  workspacePackagesFromManifests,
} from './package-boundaries.ts';

function manifests(owner: Record<string, unknown>) {
  return new Map([
    [
      'packages/helper/package.json',
      JSON.stringify({
        name: '@agent-device/helper',
        private: true,
        exports: { '.': './src/index.ts' },
      }),
    ],
    [
      'packages/owner/package.json',
      JSON.stringify({ name: '@agent-device/owner', exports: { '.': './src/index.ts' }, ...owner }),
    ],
  ]);
}

function violations(owner: Record<string, unknown>, file: string) {
  const packages = workspacePackagesFromManifests(manifests(owner));
  const pkg = packages.find(({ name }) => name === '@agent-device/owner')!;
  return checkPackageInternalSites(
    pkg,
    specifierSites(file, "import { helper } from '@agent-device/helper';"),
    packages,
    true,
  );
}

const DEV_ONLY = { private: true, devDependencies: { '@agent-device/helper': 'workspace:*' } };

test('a private package reads its devDependencies as test-only siblings', () => {
  const [, owner] = workspacePackagesFromManifests(manifests(DEV_ONLY));
  assert.deepEqual([...owner!.workspaceDependencies], []);
  assert.deepEqual([...owner!.workspaceDevDependencies], ['@agent-device/helper']);
});

test('test support may import a sibling declared only in devDependencies', () => {
  for (const file of [
    'packages/owner/src/thing.test.ts',
    'packages/owner/src/thing.spec.ts',
    'packages/owner/src/__tests__/thing.ts',
    'packages/owner/src/thing.fixtures.ts',
    'packages/owner/test/harness.ts',
  ]) {
    assert.deepEqual(violations(DEV_ONLY, file), [], file);
  }
});

test('production source needs the production field and is told so', () => {
  const found = violations(DEV_ONLY, 'packages/owner/src/thing.ts');
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /declares "@agent-device\/helper" only in devDependencies/);
  assert.match(found[0]!.message, /declare it in dependencies/);
});

test('an undeclared sibling is refused for tests and production alike', () => {
  for (const file of ['packages/owner/src/thing.test.ts', 'packages/owner/src/thing.ts']) {
    const found = violations({ private: true }, file);
    assert.equal(found.length, 1, file);
    assert.match(found[0]!.message, /without declaring "@agent-device\/helper"/);
  }
});

test('a production declaration serves tests and production', () => {
  const declared = { private: true, dependencies: { '@agent-device/helper': 'workspace:*' } };
  for (const file of ['packages/owner/src/thing.test.ts', 'packages/owner/src/thing.ts']) {
    assert.deepEqual(violations(declared, file), [], file);
  }
});

test('a published package keeps its siblings in devDependencies for every file', () => {
  const published = { devDependencies: { '@agent-device/helper': 'workspace:*' } };
  for (const file of ['packages/owner/src/thing.test.ts', 'packages/owner/src/thing.ts']) {
    assert.deepEqual(violations(published, file), [], file);
  }
});
