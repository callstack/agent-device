import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar-stream';
import {
  ArchiveBudget,
  archiveError,
  normalizeArchiveEntryName,
  reserveArchiveManifest,
  resolveArchiveOutputPath,
  sameArchiveManifestEntry,
  type ArchiveManifestEntry,
} from './archive-safety.ts';

type TarOptions = {
  archivePath: string;
  outputRoot: string;
  gzip: boolean;
  budget?: ArchiveBudget;
  depth?: number;
  validateManifest?: (manifest: readonly ArchiveManifestEntry[]) => void | Promise<void>;
};

export async function extractTarArchive(options: TarOptions): Promise<void> {
  const budget = options.budget ?? new ArchiveBudget();
  const depth = options.depth ?? 1;
  const manifest = await inspectTar(options, budget, depth);
  await options.validateManifest?.(manifest);
  const reservation = reserveArchiveManifest(budget, depth, manifest);
  const extractor = tar.extract();
  const extraction = streamTar(options.archivePath, options.gzip, extractor);
  try {
    for await (const entry of extractor) {
      const actualEntry = manifestEntryFromTarHeader(entry.header);
      if (!actualEntry) {
        await drainTarEntry(entry);
        continue;
      }
      const manifestEntry = manifest.shift();
      if (!manifestEntry || !sameArchiveManifestEntry(manifestEntry, actualEntry)) {
        throw archiveError(
          'ARCHIVE_MANIFEST_MISMATCH',
          'Archive contents changed after inspection',
        );
      }
      await writeTarEntry(entry, manifestEntry, options.outputRoot, reservation);
      reservation.commitEntry();
    }
    await extraction;
  } catch (error) {
    extractor.destroy();
    await extraction.catch(() => {});
    throw error;
  }
  if (manifest.length !== 0) {
    throw archiveError('ARCHIVE_MANIFEST_MISMATCH', 'Archive contents changed after inspection');
  }
  reservation.finish();
}

async function inspectTar(
  options: TarOptions,
  budget: ArchiveBudget,
  depth: number,
): Promise<ArchiveManifestEntry[]> {
  const manifest: ArchiveManifestEntry[] = [];
  let declaredBytes = 0;
  const extractor = tar.extract();
  const inspection = streamTar(options.archivePath, options.gzip, extractor);
  try {
    for await (const entry of extractor) {
      const manifestEntry = manifestEntryFromTarHeader(entry.header);
      if (!manifestEntry) {
        await drainTarEntry(entry);
        continue;
      }
      declaredBytes += manifestEntry.size;
      budget.preflightArchive({
        depth,
        entryCount: manifest.length + 1,
        declaredBytes,
      });
      manifest.push(manifestEntry);
      await drainTarEntry(entry);
    }
    await inspection;
  } catch (error) {
    extractor.destroy();
    await inspection.catch(() => {});
    throw error;
  }
  return manifest;
}

function streamTar(archivePath: string, gzip: boolean, extractor: tar.Extract): Promise<void> {
  return gzip
    ? pipeline(createReadStream(archivePath), createGunzip(), extractor)
    : pipeline(createReadStream(archivePath), extractor);
}

function readTarKind(type: tar.Headers['type']): 'directory' | 'file' {
  if (type === 'directory') return 'directory';
  if (type === 'file' || type === 'contiguous-file' || type == null) return 'file';
  if (type === 'link' || type === 'symlink') {
    throw archiveError(
      'ARCHIVE_UNSAFE_ENTRY',
      'Uploaded app bundle archive cannot contain symlinks or hard links',
    );
  }
  throw archiveError('ARCHIVE_UNSAFE_ENTRY', 'Archive contains a link or special entry');
}

function safeMode(mode: number | undefined, kind: 'directory' | 'file'): number {
  const fallback = kind === 'directory' ? 0o755 : 0o644;
  return (mode ?? fallback) & 0o777;
}

function manifestEntryFromTarHeader(header: tar.Headers): ArchiveManifestEntry | undefined {
  if (isRootDirectoryMarker(header.name, header.type)) return undefined;
  const name = normalizeArchiveEntryName(header.name);
  const kind = readTarKind(header.type);
  const size = kind === 'directory' ? 0 : (header.size ?? 0);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw archiveError('ARCHIVE_INVALID_ENTRY', 'Archive entry has an invalid size');
  }
  return { name, kind, size, mode: safeMode(header.mode, kind) };
}

async function writeTarEntry(
  entry: tar.Entry,
  manifestEntry: ArchiveManifestEntry,
  outputRoot: string,
  reservation: { chargeBytes(bytes: number): void },
): Promise<void> {
  const outputPath = resolveArchiveOutputPath(outputRoot, manifestEntry.name);
  if (manifestEntry.kind === 'directory') {
    await fs.mkdir(outputPath, { recursive: true, mode: manifestEntry.mode });
    await drainTarEntry(entry);
    return;
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await pipeline(
    entry,
    async function* (source) {
      for await (const chunk of source) {
        reservation.chargeBytes(Buffer.byteLength(chunk));
        yield chunk;
      }
    },
    createWriteStream(outputPath, { flags: 'wx', mode: manifestEntry.mode }),
  );
}

async function drainTarEntry(entry: tar.Entry): Promise<void> {
  for await (const _chunk of entry) {
    // Drain inspection metadata and directory markers without charging decoded bytes.
  }
}

function isRootDirectoryMarker(name: string, type: tar.Headers['type']): boolean {
  return type === 'directory' && (name === '.' || name === './' || name === '');
}
