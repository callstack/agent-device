import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ArchiveBudget, type ArchiveManifestEntry } from './archive-safety.ts';

export type SupportedArchiveType = 'tar' | 'tgz' | 'zip';

export type ExtractArchiveOptions = {
  archivePath: string;
  outputRoot: string;
  type: SupportedArchiveType;
  budget?: ArchiveBudget;
  depth?: number;
  signal?: AbortSignal;
  validateManifest?: (manifest: readonly ArchiveManifestEntry[]) => void | Promise<void>;
};

/**
 * Extracts one archive. The ZIP and TAR readers are loaded only for the format this call reads:
 * `yauzl` and `tar-stream` are the heaviest code the install and upload paths carry, and a daemon
 * that never extracts must not evaluate either (#4980). Keeping the guards, budgets and errors in
 * this module means both readers share one contract and callers see one error surface whatever
 * the format.
 */
export async function extractArchiveSafely(options: ExtractArchiveOptions): Promise<void> {
  options.signal?.throwIfAborted();
  const archivePath = path.resolve(options.archivePath);
  const outputRoot = path.resolve(options.outputRoot);
  if (archivePath === outputRoot || archivePath.startsWith(`${outputRoot}${path.sep}`)) {
    throw new RangeError('archivePath must be outside outputRoot');
  }
  await fs.mkdir(outputRoot, { recursive: false });
  try {
    if (options.type === 'zip') {
      const { extractZipArchive } = await import('./archive-extraction-zip.ts');
      await extractZipArchive({ ...options, archivePath, outputRoot });
    } else {
      const { extractTarArchive } = await import('./archive-extraction-tar.ts');
      await extractTarArchive({
        ...options,
        archivePath,
        outputRoot,
        gzip: options.type === 'tgz',
      });
    }
  } catch (error) {
    await fs.rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

export function archiveTypeFromPath(archivePath: string): SupportedArchiveType | undefined {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tgz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.zip') || lower.endsWith('.ipa')) return 'zip';
  return undefined;
}
