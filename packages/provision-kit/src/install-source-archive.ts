import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  extractArchiveSafely,
  archiveTypeFromPath,
  ArchiveBudget,
} from '@agent-device/host-kit/archive';

const MAX_INSTALL_SOURCE_SEARCH_DEPTH = 5;

type InstallableMatcher = (
  candidatePath: string,
  stat: { isFile(): boolean; isDirectory(): boolean },
) => boolean;

type ResolvedInstallableCandidate = {
  /** The outermost archive the source arrived as. */
  archivePath?: string;
  /** The innermost archive, the one the installable was extracted from directly. */
  containingArchivePath?: string;
  installablePath: string;
};

function resolvedCandidate(
  installablePath: string,
  params: { archivePath: string | undefined; containingArchivePath?: string },
): ResolvedInstallableCandidate {
  return {
    archivePath: params.archivePath,
    ...(params.containingArchivePath
      ? { containingArchivePath: params.containingArchivePath }
      : {}),
    installablePath,
  };
}

export async function resolveInstallableCandidate(
  candidatePath: string,
  params: {
    archivePath: string | undefined;
    containingArchivePath?: string;
    isInstallablePath: InstallableMatcher;
    installableLabel: string;
    registerCleanup: (cleanup: () => Promise<void>) => void;
    budget: ArchiveBudget;
    archiveDepth: number;
    onArchiveAccepted?: (depth: number) => void;
  },
): Promise<ResolvedInstallableCandidate> {
  const stat = await fs.stat(candidatePath).catch(() => null);
  if (!stat) throw new AppError('INVALID_ARGS', `App source not found: ${candidatePath}`);
  if (params.isInstallablePath(candidatePath, stat)) {
    return resolvedCandidate(candidatePath, params);
  }
  if (stat.isFile() && isArchivePath(candidatePath)) {
    return await resolveExtractedArchive(candidatePath, params);
  }
  if (stat.isDirectory()) {
    const installables = await collectMatchingPaths(candidatePath, params.isInstallablePath);
    if (installables.length === 1) {
      return resolvedCandidate(installables[0]!, params);
    }
    if (installables.length > 1) {
      throw new AppError(
        'INVALID_ARGS',
        `Found multiple ${params.installableLabel} candidates under ${candidatePath}: ${installables.join(', ')}`,
        { matches: installables },
      );
    }
    const archives = await collectMatchingPaths(candidatePath, (entryPath, entryStat) =>
      Boolean(entryStat.isFile() && isArchivePath(entryPath)),
    );
    if (archives.length === 1) {
      return await resolveExtractedArchive(archives[0]!, params);
    }
    if (archives.length > 1) {
      throw new AppError(
        'INVALID_ARGS',
        `Found multiple nested archives under ${candidatePath}; expected one ${params.installableLabel} source`,
        { matches: archives },
      );
    }
  }
  throw new AppError(
    'INVALID_ARGS',
    `Expected ${params.installableLabel} source, but got ${candidatePath}`,
  );
}

async function resolveExtractedArchive(
  archivePath: string,
  params: Parameters<typeof resolveInstallableCandidate>[1],
): ReturnType<typeof resolveInstallableCandidate> {
  const extracted = await extractArchive(archivePath, params.budget, params.archiveDepth + 1);
  params.onArchiveAccepted?.(params.archiveDepth + 1);
  params.registerCleanup(extracted.cleanup);
  return await resolveInstallableCandidate(extracted.outputPath, {
    ...params,
    archivePath: params.archivePath ?? archivePath,
    containingArchivePath: archivePath,
    archiveDepth: params.archiveDepth + 1,
  });
}

async function extractArchive(
  archivePath: string,
  budget: ArchiveBudget,
  depth: number,
): Promise<{ outputPath: string; cleanup: () => Promise<void> }> {
  const type = archiveTypeFromPath(archivePath);
  if (!type) throw new AppError('INVALID_ARGS', `Unsupported archive: ${archivePath}`);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-archive-'));
  const outputPath = path.join(tempDir, 'extracted');
  try {
    await extractArchiveSafely({ archivePath, outputRoot: outputPath, type, budget, depth });
    return {
      outputPath,
      cleanup: async () => await fs.rm(tempDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function collectMatchingPaths(
  rootPath: string,
  matcher: InstallableMatcher,
): Promise<string[]> {
  const matches: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const entries = await fs.readdir(current.path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === '__MACOSX' || entry.name.startsWith('._')) continue;
      const entryPath = path.join(current.path, entry.name);
      if (matcher(entryPath, entry)) matches.push(entryPath);
      else if (entry.isDirectory() && current.depth < MAX_INSTALL_SOURCE_SEARCH_DEPTH) {
        queue.push({ path: entryPath, depth: current.depth + 1 });
      }
    }
  }
  return [...new Set(matches)];
}

function isArchivePath(candidatePath: string): boolean {
  return archiveTypeFromPath(candidatePath) !== undefined;
}
