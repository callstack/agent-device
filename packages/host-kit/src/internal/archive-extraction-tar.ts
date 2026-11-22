import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar-stream';
import { AppError } from '@agent-device/kernel/errors';
import {
  ARCHIVE_REASONS,
  ArchiveBudget,
  archiveError,
  createExtractedDirectory,
  extractedEntryMode,
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
  signal?: AbortSignal;
  validateManifest?: (manifest: readonly ArchiveManifestEntry[]) => void | Promise<void>;
};

export async function extractTarArchive(options: TarOptions): Promise<void> {
  options.signal?.throwIfAborted();
  const budget = options.budget ?? new ArchiveBudget();
  const depth = options.depth ?? 1;
  const manifest = await inspectTar(options, budget, depth);
  await options.validateManifest?.(manifest);
  const reservation = reserveArchiveManifest(budget, depth, manifest);
  const extractor = tar.extract();
  const extraction = streamTar(options.archivePath, options.gzip, extractor, options.signal);
  try {
    for await (const entry of extractor) {
      options.signal?.throwIfAborted();
      const actualEntry = manifestEntryFromTarHeader(entry.header);
      if (!actualEntry) {
        await drainTarEntry(entry);
        continue;
      }
      const manifestEntry = manifest.shift();
      if (!manifestEntry || !sameArchiveManifestEntry(manifestEntry, actualEntry)) {
        throw archiveError(
          ARCHIVE_REASONS.manifestMismatch.reason,
          'Archive contents changed after inspection',
        );
      }
      await writeTarEntry(entry, manifestEntry, options.outputRoot, reservation, options.signal);
      reservation.commitEntry();
    }
    await extraction;
  } catch (error) {
    extractor.destroy();
    await extraction.catch(() => {});
    throw cancellationOwnedFailure(options.signal, error);
  }
  if (manifest.length !== 0) {
    throw archiveError(
      ARCHIVE_REASONS.manifestMismatch.reason,
      'Archive contents changed after inspection',
    );
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
  const inspection = streamTar(options.archivePath, options.gzip, extractor, options.signal);
  try {
    for await (const entry of extractor) {
      options.signal?.throwIfAborted();
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
    throw cancellationOwnedFailure(options.signal, error);
  }
  return manifest;
}

/**
 * Starts the archive pipeline with its outcome observed at once: a cancellation can reject it
 * while the entry loop still awaits a filesystem operation, before the loop joins it.
 */
function streamTar(
  archivePath: string,
  gzip: boolean,
  extractor: tar.Extract,
  signal?: AbortSignal,
): Promise<void> {
  const stream = gzip
    ? pipeline(createReadStream(archivePath), createGunzip(), extractor, { signal })
    : pipeline(createReadStream(archivePath), extractor, { signal });
  stream.catch(() => {});
  return stream;
}

/** A cancelled walk reports the signal's typed reason; a classified archive failure stays. */
function cancellationOwnedFailure(signal: AbortSignal | undefined, error: unknown): unknown {
  if (!signal?.aborted || error instanceof AppError) return error;
  return signal.reason;
}

function readTarKind(type: tar.Headers['type']): 'directory' | 'file' {
  if (type === 'directory') return 'directory';
  if (type === 'file' || type === 'contiguous-file' || type == null) return 'file';
  if (type === 'link' || type === 'symlink') {
    throw archiveError(
      ARCHIVE_REASONS.unsafeEntry.reason,
      'Uploaded app bundle archive cannot contain symlinks or hard links',
    );
  }
  throw archiveError(
    ARCHIVE_REASONS.unsafeEntry.reason,
    'Archive contains a link or special entry',
  );
}

function manifestEntryFromTarHeader(header: tar.Headers): ArchiveManifestEntry | undefined {
  if (isRootDirectoryMarker(header.name, header.type)) return undefined;
  const name = normalizeArchiveEntryName(header.name);
  const kind = readTarKind(header.type);
  const size = kind === 'directory' ? 0 : (header.size ?? 0);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw archiveError(ARCHIVE_REASONS.invalidEntry.reason, 'Archive entry has an invalid size');
  }
  return { name, kind, size, mode: extractedEntryMode(kind, header.mode) };
}

/**
 * Writes one entry under the extraction's signal. The signal is checked after each
 * filesystem await, so no writer opens after a cancellation, and the entry pipeline joins
 * its own writer before it settles, so cleanup never races an open write.
 */
async function writeTarEntry(
  entry: tar.Entry,
  manifestEntry: ArchiveManifestEntry,
  outputRoot: string,
  reservation: { chargeBytes(bytes: number): void },
  signal: AbortSignal | undefined,
): Promise<void> {
  const outputPath = resolveArchiveOutputPath(outputRoot, manifestEntry.name);
  if (manifestEntry.kind === 'directory') {
    await createExtractedDirectory(outputPath, manifestEntry.mode, signal);
    signal?.throwIfAborted();
    await drainTarEntry(entry);
    return;
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  signal?.throwIfAborted();
  await pipeline(
    entry,
    async function* (source) {
      for await (const chunk of source) {
        reservation.chargeBytes(Buffer.byteLength(chunk));
        yield chunk;
      }
    },
    createWriteStream(outputPath, { flags: 'wx', mode: manifestEntry.mode }),
    { signal },
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
