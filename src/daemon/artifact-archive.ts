import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { extractArchiveSafely } from '../utils/archive-extraction.ts';
import type { ArchiveManifestEntry } from '../utils/archive-safety.ts';

export async function extractTarInstallableArtifact(params: {
  archivePath: string;
  tempDir: string;
  platform: 'ios' | 'android';
  expectedRootName?: string;
}): Promise<string> {
  const outputRoot = path.join(params.tempDir, 'extracted');
  let rootName = '';
  const type = await detectTarArchiveType(params.archivePath);
  await extractArchiveSafely({
    archivePath: params.archivePath,
    outputRoot,
    type,
    validateManifest: (manifest) => {
      rootName = resolveArchiveRootName(manifest, params.platform, params.expectedRootName);
    },
  });
  const installablePath = path.join(outputRoot, rootName);
  if (!fs.existsSync(installablePath)) {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    throw new AppError(
      'INVALID_ARGS',
      `Expected extracted bundle "${rootName}" not found in archive`,
    );
  }
  return installablePath;
}

async function detectTarArchiveType(archivePath: string): Promise<'tar' | 'tgz'> {
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    const signature = Buffer.alloc(2);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    return bytesRead === signature.length && signature[0] === 0x1f && signature[1] === 0x8b
      ? 'tgz'
      : 'tar';
  } finally {
    await handle.close();
  }
}

function resolveArchiveRootName(
  manifest: readonly ArchiveManifestEntry[],
  platform: 'ios' | 'android',
  expectedRootName?: string,
): string {
  if (manifest.length === 0) {
    throw new AppError('INVALID_ARGS', 'Uploaded app bundle archive is empty');
  }
  const roots = new Set(
    manifest
      .map((entry) => entry.name.split('/')[0])
      .filter((entry): entry is string => Boolean(entry)),
  );
  const rootName = expectedRootName ?? inferArchiveRootName([...roots], platform);
  if (!roots.has(rootName)) {
    throw new AppError(
      'INVALID_ARGS',
      `Uploaded archive must contain a top-level "${rootName}" bundle`,
    );
  }
  for (const entry of manifest) {
    if (entry.name !== rootName && !entry.name.startsWith(`${rootName}/`)) {
      throw new AppError(
        'INVALID_ARGS',
        `Archive entry must stay inside top-level "${rootName}" bundle: ${entry.name}`,
      );
    }
  }
  return rootName;
}

function inferArchiveRootName(roots: string[], platform: 'ios' | 'android'): string {
  if (platform === 'ios') {
    const appRoots = roots.filter((entry) => entry.toLowerCase().endsWith('.app'));
    if (appRoots.length === 1) return appRoots[0]!;
    if (appRoots.length === 0) {
      throw new AppError(
        'INVALID_ARGS',
        'iOS app bundle archives must contain a single top-level .app directory',
      );
    }
    throw new AppError(
      'INVALID_ARGS',
      `iOS app bundle archives must contain exactly one top-level .app directory, found: ${appRoots.join(', ')}`,
    );
  }
  if (roots.length === 1) return roots[0]!;
  throw new AppError(
    'INVALID_ARGS',
    `Archive must contain a single top-level bundle, found: ${roots.join(', ')}`,
  );
}
