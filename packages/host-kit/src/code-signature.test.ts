import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { computeDaemonCodeSignature, walkDaemonCodeGraph } from './code-signature.ts';
import { writeWorkspaceFixture } from './code-signature.fixtures.ts';
import { mkdtempForTestSync } from './internal/tmp-dir.fixtures.ts';

function labelsOf(entryPath: string, root: string): string[] {
  return walkDaemonCodeGraph(entryPath, root).files.map(([label]) => label);
}

test('a workspace subpath is walked, and its file is stamped under the package path', () => {
  const { root, entryPath } = writeWorkspaceFixture('agent-device-signature-workspace-');
  try {
    assert.deepEqual(labelsOf(entryPath, root).sort(), [
      'packages/kit/package.json',
      'packages/kit/src/owned.ts',
      'src/daemon.ts',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an edit to a package-owned module changes the source signature', () => {
  const { root, entryPath, ownedPath } = writeWorkspaceFixture('agent-device-signature-edit-');
  try {
    const before = computeDaemonCodeSignature(entryPath, root);

    fs.writeFileSync(ownedPath, 'export const owned = 20000;\n', 'utf8');

    assert.notEqual(computeDaemonCodeSignature(entryPath, root), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retargeting the exports map moves the edge without either endpoint changing', () => {
  const { root, entryPath, packageDir, manifestPath } = writeWorkspaceFixture(
    'agent-device-signature-exports-',
  );
  try {
    const before = computeDaemonCodeSignature(entryPath, root);
    fs.writeFileSync(path.join(packageDir, 'src', 'other.ts'), 'export const other = 1;\n', 'utf8');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: '@scope/kit',
        exports: { './owned': { types: './src/other.ts', default: './src/other.ts' } },
      }),
      'utf8',
    );

    assert.notEqual(computeDaemonCodeSignature(entryPath, root), before);
    assert.ok(labelsOf(entryPath, root).includes('packages/kit/src/other.ts'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an installed dependency is not followed into', () => {
  const root = mkdtempForTestSync('agent-device-signature-installed-');
  try {
    const entryPath = path.join(root, 'src', 'daemon.ts');
    const packageDir = path.join(root, 'node_modules', '@scope', 'vendor');
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });
    fs.writeFileSync(entryPath, "import '@scope/vendor/thing';\n", 'utf8');
    fs.writeFileSync(path.join(packageDir, 'src', 'thing.js'), 'export const thing = 1;\n', 'utf8');
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: '@scope/vendor', exports: { './thing': './src/thing.js' } }),
      'utf8',
    );

    assert.deepEqual(labelsOf(entryPath, root), ['src/daemon.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace package linked after the walk is an absent path, not a silent miss', () => {
  const root = mkdtempForTestSync('agent-device-signature-absent-');
  try {
    const entryPath = path.join(root, 'src', 'daemon.ts');
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, "import '@scope/kit/owned';\n", 'utf8');

    assert.ok(
      walkDaemonCodeGraph(entryPath, root).absentPaths.includes(
        path.join('node_modules', '@scope', 'kit', 'package.json'),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The cache's format guard covers only its own stored shape; it relies on the
 * WALK invalidating every document by being inside the graph it walks. That
 * held while the walker sat in `src/daemon`, and workspace resolution is what
 * keeps it true now that it is a package (#2340). A stamped label is a
 * `size:mtime` input to the signature, so membership is the whole claim.
 */
test('the daemon source graph stamps the walker that produced it', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const entryPath = path.join(repoRoot, 'src', 'daemon.ts');
  if (!fs.existsSync(entryPath)) return;

  assert.ok(labelsOf(entryPath, repoRoot).includes('packages/host-kit/src/code-signature.ts'));
});
