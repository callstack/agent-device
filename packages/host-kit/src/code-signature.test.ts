import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { computeDaemonCodeSignature, walkDaemonCodeGraph } from './code-signature.ts';
import {
  createCheckoutRootForTest,
  writeInstalledDependencyFixture,
  writeWorkspaceFixture,
} from './code-signature.fixtures.ts';

function labelsOf(entryPath: string, root: string): string[] {
  return walkDaemonCodeGraph(entryPath, root).files.map(([label]) => label);
}

/**
 * The same checkout named through a symlink, which is how a real one is
 * routinely named: macOS resolves `/tmp` to `/private/tmp`, and a checkout
 * under a symlinked parent directory reaches every file the same way.
 */
function linkTo(root: string): string {
  const linkPath = `${root}-link`;
  fs.symlinkSync(root, linkPath, 'dir');
  return linkPath;
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
  const { root, entryPath } = writeInstalledDependencyFixture('agent-device-signature-installed-');
  try {
    assert.deepEqual(labelsOf(entryPath, root), ['src/daemon.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A root named through a symlink is the same root, and every label is still
 * repository-relative. Resolving the manifests but not the root would put the
 * two on either side of the link, so a workspace package would be labelled by
 * the route out of the repository and back in.
 */
test('a checkout named through a symlink stamps the same repository-relative labels', () => {
  const { root } = writeWorkspaceFixture('agent-device-signature-linked-workspace-');
  const linkedRoot = linkTo(root);
  try {
    assert.deepEqual(labelsOf(path.join(linkedRoot, 'src', 'daemon.ts'), linkedRoot).sort(), [
      'packages/kit/package.json',
      'packages/kit/src/owned.ts',
      'src/daemon.ts',
    ]);
  } finally {
    fs.rmSync(linkedRoot, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The workspace/installed test is `node_modules` containment, so it answers
 * only while the root and the manifest are named the same way. Under an
 * unresolved root every installed dependency reads as a workspace package and
 * the walk follows its whole closure.
 */
test('an installed dependency is not followed into through a symlinked root', () => {
  const { root } = writeInstalledDependencyFixture('agent-device-signature-linked-installed-');
  const linkedRoot = linkTo(root);
  try {
    assert.deepEqual(labelsOf(path.join(linkedRoot, 'src', 'daemon.ts'), linkedRoot), [
      'src/daemon.ts',
    ]);
  } finally {
    fs.rmSync(linkedRoot, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace package linked after the walk is an absent path, not a silent miss', () => {
  const root = createCheckoutRootForTest('agent-device-signature-absent-');
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

/**
 * The same claim for the command descriptors (#2336). The daemon reaches the
 * registry, the catalog derived from it, and the rest of that package only by
 * workspace specifier, so a walk that stopped at the package boundary would
 * report an unchanged signature after a descriptor edit and the client would
 * keep reusing a daemon running the superseded policy. The manifest is stamped
 * beside them because its `exports` map is what chose those files.
 */
test('the daemon source graph stamps the command descriptor registry package', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const entryPath = path.join(repoRoot, 'src', 'daemon.ts');
  if (!fs.existsSync(entryPath)) return;

  const labels = labelsOf(entryPath, repoRoot);
  for (const owned of [
    'packages/command-registry/src/registry.ts',
    'packages/command-registry/src/catalog.ts',
    'packages/command-registry/package.json',
  ]) {
    assert.ok(labels.includes(owned), `${owned} is missing from the daemon code graph`);
  }
});

/**
 * The same claim for the ADR 0018 event journal (#2341). The daemon writes and reads
 * `events.ndjson` only through this package's workspace subpaths, so a walk that stopped at the
 * package boundary would report an unchanged signature after an entry-shape or retention-window
 * edit, and a client would keep reusing a daemon writing the superseded journal. The manifest is
 * asserted beside the sources because its `exports` map is what chose them.
 */
test('the daemon source graph stamps the session event journal package', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const entryPath = path.join(repoRoot, 'src', 'daemon.ts');
  if (!fs.existsSync(entryPath)) return;

  const labels = labelsOf(entryPath, repoRoot);
  for (const owned of [
    'packages/session-journal/src/session-event-log.ts',
    'packages/session-journal/src/session-event-log-window.ts',
    'packages/session-journal/src/session-event-action.ts',
    'packages/session-journal/package.json',
  ]) {
    assert.ok(labels.includes(owned), `${owned} is missing from the daemon code graph`);
  }
});
