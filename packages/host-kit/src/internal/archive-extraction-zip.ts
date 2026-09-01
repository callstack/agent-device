import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import {
  ArchiveBudget,
  archiveError,
  normalizeArchiveEntryName,
  reserveArchiveManifest,
  resolveArchiveOutputPath,
  sameArchiveManifestEntry,
  type ArchiveManifestEntry,
} from './archive-safety.ts';

type ZipOptions = {
  archivePath: string;
  outputRoot: string;
  budget?: ArchiveBudget;
  depth?: number;
  signal?: AbortSignal;
  validateManifest?: (manifest: readonly ArchiveManifestEntry[]) => void | Promise<void>;
};

export async function extractZipArchive(options: ZipOptions): Promise<void> {
  options.signal?.throwIfAborted();
  const budget = options.budget ?? new ArchiveBudget();
  const depth = options.depth ?? 1;
  const manifest: ArchiveManifestEntry[] = [];
  let declaredBytes = 0;
  await readZipEntries(options.archivePath, options.signal, (entry) => {
    budget.preflightArchive({
      depth,
      entryCount: manifest.length + 1,
      declaredBytes,
    });
    const manifestEntry = toManifestEntry(entry);
    declaredBytes += manifestEntry.size;
    budget.preflightArchive({
      depth,
      entryCount: manifest.length + 1,
      declaredBytes,
    });
    manifest.push(manifestEntry);
  });
  await options.validateManifest?.(manifest);
  const reservation = reserveArchiveManifest(budget, depth, manifest);
  const entries = await readZipEntries(options.archivePath, options.signal, (_entry, index) => {
    if (index >= manifest.length) mismatch();
  });
  if (entries.length !== manifest.length) mismatch();
  const zipFile = await openZip(options.archivePath);
  try {
    for (let index = 0; index < entries.length; index += 1) {
      options.signal?.throwIfAborted();
      const entry = entries[index];
      const expected = manifest[index];
      if (!entry || !expected || !sameArchiveManifestEntry(toManifestEntry(entry), expected)) {
        mismatch();
      }
      const outputPath = resolveArchiveOutputPath(options.outputRoot, expected.name);
      if (expected.kind === 'directory') {
        await fs.mkdir(outputPath, { recursive: true, mode: expected.mode });
      } else {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        const source = await openEntryStream(zipFile, entry);
        await pipeline(
          source,
          async function* (chunks) {
            for await (const chunk of chunks) {
              reservation.chargeBytes(Buffer.byteLength(chunk));
              yield chunk;
            }
          },
          createWriteStream(outputPath, { flags: 'wx', mode: expected.mode }),
          { signal: options.signal },
        );
      }
      reservation.commitEntry();
    }
    reservation.finish();
  } finally {
    zipFile.close();
  }
}

async function readZipEntries(
  archivePath: string,
  signal?: AbortSignal,
  inspect?: (entry: yauzl.Entry, index: number) => void,
): Promise<yauzl.Entry[]> {
  const zipFile = await openZip(archivePath);
  return await new Promise<yauzl.Entry[]>((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    const cleanup = (): void => {
      zipFile.off('entry', onEntry);
      zipFile.off('end', onEnd);
      zipFile.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onEntry = (entry: yauzl.Entry): void => {
      try {
        inspect?.(entry, entries.length);
        entries.push(entry);
        zipFile.readEntry();
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(entries);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      zipFile.close();
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    zipFile.on('entry', onEntry);
    zipFile.once('end', onEnd);
    zipFile.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    zipFile.readEntry();
  }).finally(() => zipFile.close());
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
      (error, zipFile) => (error ? reject(error) : resolve(zipFile)),
    );
  });
}

function openEntryStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)));
  });
}

function toManifestEntry(entry: yauzl.Entry): ArchiveManifestEntry {
  assertZipEntryIsReadable(entry);
  const name = normalizeArchiveEntryName(entry.fileName);
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const directory = isZipDirectory(entry.fileName, unixMode);
  const fallback = directory ? 0o755 : 0o644;
  return {
    name,
    kind: directory ? 'directory' : 'file',
    size: directory ? 0 : entry.uncompressedSize,
    mode: unixMode & 0o777 || fallback,
  };
}

function assertZipEntryIsReadable(entry: yauzl.Entry): void {
  if (entry.isEncrypted()) {
    throw archiveError('ARCHIVE_UNSAFE_ENTRY', 'Encrypted archive entries are not supported');
  }
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (type !== 0 && type !== 0o040000 && type !== 0o100000) {
    throw archiveError('ARCHIVE_UNSAFE_ENTRY', 'Archive contains a link or special entry');
  }
}

function isZipDirectory(fileName: string, unixMode: number): boolean {
  return fileName.endsWith('/') || (unixMode & 0o170000) === 0o040000;
}

function mismatch(): never {
  throw archiveError('ARCHIVE_MANIFEST_MISMATCH', 'Archive contents changed after inspection');
}
