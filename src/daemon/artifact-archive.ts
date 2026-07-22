import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../kernel/errors.ts';
import { runCmd } from '../utils/exec.ts';

export async function extractTarInstallableArtifact(params: {
  archivePath: string;
  tempDir: string;
  platform: 'ios' | 'android';
  expectedRootName?: string;
}): Promise<string> {
  const rootName = await resolveTarArchiveRootName(params);
  await runCmd('tar', ['xf', params.archivePath, '-C', params.tempDir]);
  const installablePath = path.join(params.tempDir, rootName);
  if (!fs.existsSync(installablePath)) {
    throw new AppError(
      'INVALID_ARGS',
      `Expected extracted bundle "${rootName}" not found in archive`,
    );
  }
  return installablePath;
}

async function resolveTarArchiveRootName(params: {
  archivePath: string;
  platform: 'ios' | 'android';
  expectedRootName?: string;
}): Promise<string> {
  const entriesResult = await runCmd('tar', ['-tf', params.archivePath], { allowFailure: true });
  if (entriesResult.exitCode !== 0) {
    throw new AppError('INVALID_ARGS', 'Artifact is not a valid tar archive', {
      archivePath: params.archivePath,
      stdout: entriesResult.stdout,
      stderr: entriesResult.stderr,
      exitCode: entriesResult.exitCode,
    });
  }

  const entries = entriesResult.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new AppError('INVALID_ARGS', 'Uploaded app bundle archive is empty');
  }

  const normalizedEntries = entries.map(normalizeArchiveEntry);
  const rootName =
    params.expectedRootName ?? resolveArchiveRootName(normalizedEntries, params.platform);
  const hasExpectedRoot = normalizedEntries.some(
    (entry) => entry === rootName || entry.startsWith(`${rootName}/`),
  );
  if (!hasExpectedRoot) {
    throw new AppError(
      'INVALID_ARGS',
      `Uploaded archive must contain a top-level "${rootName}" bundle`,
    );
  }

  for (const entry of normalizedEntries) {
    validateArchiveEntryPath(entry, rootName);
  }

  const verboseResult = await runCmd('tar', ['-tvf', params.archivePath]);
  for (const line of verboseResult.stdout.split(/\r?\n/).filter(Boolean)) {
    if (line[0] === 'l' || line[0] === 'h') {
      throw new AppError(
        'INVALID_ARGS',
        'Uploaded app bundle archive cannot contain symlinks or hard links',
      );
    }
  }

  return rootName;
}

function resolveArchiveRootName(entries: string[], platform: 'ios' | 'android'): string {
  const roots = new Set<string>();
  for (const entry of entries) {
    const [root] = entry.split('/');
    if (root) roots.add(root);
  }
  const rootEntries = [...roots];
  if (platform === 'ios') {
    const appRoots = rootEntries.filter((entry) => entry.toLowerCase().endsWith('.app'));
    const appRoot = appRoots[0];
    if (appRoot !== undefined && appRoots.length === 1) return appRoot;
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
  const rootEntry = rootEntries[0];
  if (rootEntry !== undefined && rootEntries.length === 1) return rootEntry;
  throw new AppError(
    'INVALID_ARGS',
    `Archive must contain a single top-level bundle, found: ${rootEntries.join(', ')}`,
  );
}

function normalizeArchiveEntry(entry: string): string {
  if (entry.includes('\0')) {
    throw new AppError('INVALID_ARGS', `Invalid archive entry: ${entry}`);
  }
  if (path.posix.isAbsolute(entry)) {
    throw new AppError('INVALID_ARGS', `Archive entry must be relative: ${entry}`);
  }
  const normalized = path.posix.normalize(entry).replace(/^(\.\/)+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    throw new AppError('INVALID_ARGS', `Archive entry escapes bundle root: ${entry}`);
  }
  return normalized;
}

function validateArchiveEntryPath(entry: string, rootName: string): void {
  if (entry !== rootName && !entry.startsWith(`${rootName}/`)) {
    throw new AppError(
      'INVALID_ARGS',
      `Archive entry must stay inside top-level "${rootName}" bundle: ${entry}`,
    );
  }
}
