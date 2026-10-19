import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractTarInstallableArtifact } from '../artifact-archive.ts';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTestSync } from '@agent-device/test-kit';

const TAR_ENV = { ...process.env, COPYFILE_DISABLE: '1' };

/**
 * Builds a tar from the named top-level roots created under a fresh temp source
 * dir, then extracts it with no `expectedRootName`, so the archive's own layout
 * must decide the installable root (`inferArchiveRootName`).
 */
async function extractWithoutExpectedRoot(
  rootNames: string[],
  entries: Record<string, string>,
  platform: 'ios' | 'android',
): Promise<string> {
  const tempRoot = mkdtempForTestSync('agent-device-artifact-archive-');
  const sourceRoot = path.join(tempRoot, 'src');
  fs.mkdirSync(sourceRoot, { recursive: true });
  for (const [name, contents] of Object.entries(entries)) {
    const filePath = path.join(sourceRoot, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  const archivePath = path.join(tempRoot, 'artifact.tar');
  runCmdSync('tar', ['cf', archivePath, '-C', sourceRoot, ...rootNames], { env: TAR_ENV });
  const extractDir = path.join(tempRoot, 'out');
  fs.mkdirSync(extractDir);
  return await extractTarInstallableArtifact({ archivePath, tempDir: extractDir, platform });
}

test('an iOS tar infers the single top-level .app directory as the installable root', async () => {
  const artifactPath = await extractWithoutExpectedRoot(
    ['Sample.app'],
    { 'Sample.app/payload.txt': 'payload' },
    'ios',
  );
  assert.equal(path.basename(artifactPath), 'Sample.app');
  assert.equal(fs.readFileSync(path.join(artifactPath, 'payload.txt'), 'utf8'), 'payload');
});

test('an iOS tar with no top-level .app directory is refused, not installed under a wrong root', async () => {
  await assert.rejects(
    async () =>
      await extractWithoutExpectedRoot(['payload'], { 'payload/data.txt': 'data' }, 'ios'),
    /must contain a single top-level \.app directory/i,
  );
});

test('an iOS tar with two top-level .app directories refuses and names both candidates', async () => {
  await assert.rejects(
    async () =>
      await extractWithoutExpectedRoot(
        ['A.app', 'B.app'],
        { 'A.app/x': '1', 'B.app/y': '2' },
        'ios',
      ),
    /exactly one top-level \.app directory, found: A\.app, B\.app/i,
  );
});

test('an Android tar installs its single top-level bundle whatever it is named', async () => {
  const artifactPath = await extractWithoutExpectedRoot(
    ['bundle'],
    { 'bundle/base.apk': 'apk' },
    'android',
  );
  assert.equal(path.basename(artifactPath), 'bundle');
});

test('an Android tar with two top-level bundles is refused and names them', async () => {
  await assert.rejects(
    async () =>
      await extractWithoutExpectedRoot(
        ['bundle-a', 'bundle-b'],
        { 'bundle-a/x': '1', 'bundle-b/y': '2' },
        'android',
      ),
    /must contain a single top-level bundle, found: bundle-a, bundle-b/i,
  );
});
