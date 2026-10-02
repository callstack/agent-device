import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_EXPANDED_BYTES,
  MAX_ARCHIVE_NESTING_DEPTH,
} from './artifact-limits.ts';

export type ArchiveManifestEntry = {
  name: string;
  kind: 'directory' | 'file';
  size: number;
  mode: number;
};

type ArchiveLimits = {
  maxBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
};

export class ArchiveBudget {
  readonly maxBytes: number;
  readonly maxEntries: number;
  readonly maxDepth: number;
  #bytes = 0;
  #entries = 0;

  constructor(limits: ArchiveLimits = {}) {
    this.maxBytes = validateLimit(limits.maxBytes ?? MAX_ARCHIVE_EXPANDED_BYTES, 'maxBytes');
    this.maxEntries = validateLimit(limits.maxEntries ?? MAX_ARCHIVE_ENTRIES, 'maxEntries');
    this.maxDepth = validateLimit(limits.maxDepth ?? MAX_ARCHIVE_NESTING_DEPTH, 'maxDepth');
  }

  get bytes(): number {
    return this.#bytes;
  }

  get entries(): number {
    return this.#entries;
  }

  preflightArchive(input: {
    depth: number;
    entryCount: number;
    declaredBytes: number;
  }): ArchiveReservation {
    const depth = validateLimit(input.depth, 'depth');
    const entryCount = validateLimit(input.entryCount, 'entryCount');
    const declaredBytes = validateLimit(input.declaredBytes, 'declaredBytes');
    if (depth < 1 || depth > this.maxDepth) {
      throw archiveError('ARCHIVE_NESTING_LIMIT', 'Archive nesting depth exceeds the limit');
    }
    if (entryCount > this.maxEntries - this.#entries) {
      throw archiveError('ARCHIVE_ENTRY_LIMIT', 'Archive contains too many entries');
    }
    if (declaredBytes > this.maxBytes - this.#bytes) {
      throw archiveError('ARCHIVE_EXPANDED_BYTES_LIMIT', 'Archive expands beyond the byte limit');
    }
    return new ArchiveReservation(
      (bytes) => this.#chargeBytes(bytes),
      () => this.#commitEntry(),
      input.entryCount,
      input.declaredBytes,
    );
  }

  #chargeBytes(bytes: number): void {
    const acceptedBytes = validateLimit(bytes, 'bytes');
    if (acceptedBytes > this.maxBytes - this.#bytes) {
      throw archiveError('ARCHIVE_EXPANDED_BYTES_LIMIT', 'Archive expands beyond the byte limit');
    }
    this.#bytes += acceptedBytes;
  }

  #commitEntry(): void {
    if (this.#entries >= this.maxEntries) {
      throw archiveError('ARCHIVE_ENTRY_LIMIT', 'Archive contains too many entries');
    }
    this.#entries += 1;
  }
}

class ArchiveReservation {
  readonly #chargeBudgetBytes: (bytes: number) => void;
  readonly #commitBudgetEntry: () => void;
  readonly #declaredEntries: number;
  readonly #declaredBytes: number;
  #actualEntries = 0;
  #actualBytes = 0;

  constructor(
    chargeBudgetBytes: (bytes: number) => void,
    commitBudgetEntry: () => void,
    declaredEntries: number,
    declaredBytes: number,
  ) {
    this.#chargeBudgetBytes = chargeBudgetBytes;
    this.#commitBudgetEntry = commitBudgetEntry;
    this.#declaredEntries = declaredEntries;
    this.#declaredBytes = declaredBytes;
  }

  chargeBytes(bytes: number): void {
    const acceptedBytes = validateLimit(bytes, 'bytes');
    if (acceptedBytes > this.#declaredBytes - this.#actualBytes) {
      throw archiveError('ARCHIVE_MANIFEST_MISMATCH', 'Archive contents changed after inspection');
    }
    this.#chargeBudgetBytes(acceptedBytes);
    this.#actualBytes += acceptedBytes;
  }

  commitEntry(): void {
    if (this.#actualEntries >= this.#declaredEntries) {
      throw archiveError('ARCHIVE_MANIFEST_MISMATCH', 'Archive contents changed after inspection');
    }
    this.#commitBudgetEntry();
    this.#actualEntries += 1;
  }

  finish(): void {
    if (
      this.#actualEntries !== this.#declaredEntries ||
      this.#actualBytes !== this.#declaredBytes
    ) {
      throw archiveError('ARCHIVE_MANIFEST_MISMATCH', 'Archive contents changed after inspection');
    }
  }
}

export function reserveArchiveManifest(
  budget: ArchiveBudget,
  depth: number,
  manifest: readonly ArchiveManifestEntry[],
): ArchiveReservation {
  return budget.preflightArchive({
    depth,
    entryCount: manifest.length,
    declaredBytes: manifest.reduce((total, entry) => total + entry.size, 0),
  });
}

export function sameArchiveManifestEntry(
  left: ArchiveManifestEntry,
  right: ArchiveManifestEntry,
): boolean {
  return (
    left.name === right.name &&
    left.kind === right.kind &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

export function normalizeArchiveEntryName(rawName: string): string {
  if (!rawName || rawName.includes('\0') || rawName.includes('\\')) {
    throw archiveError('ARCHIVE_UNSAFE_PATH', 'Archive contains an unsafe entry path');
  }
  if (path.posix.isAbsolute(rawName) || /^[a-zA-Z]:/.test(rawName) || rawName.startsWith('//')) {
    throw archiveError('ARCHIVE_UNSAFE_PATH', 'Archive contains an unsafe entry path');
  }
  const normalized = path.posix
    .normalize(rawName)
    .replace(/^(\.\/)+/, '')
    .replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw archiveError('ARCHIVE_UNSAFE_PATH', 'Archive contains an unsafe entry path');
  }
  return normalized;
}

export function resolveArchiveOutputPath(outputRoot: string, entryName: string): string {
  const normalized = normalizeArchiveEntryName(entryName);
  const resolvedRoot = path.resolve(outputRoot);
  const resolvedEntry = path.resolve(resolvedRoot, ...normalized.split('/'));
  if (!resolvedEntry.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw archiveError('ARCHIVE_UNSAFE_PATH', 'Archive entry escapes the extraction root');
  }
  return resolvedEntry;
}

const DEFAULT_ENTRY_PERMISSIONS = { directory: 0o755, file: 0o644 } as const;
const OWNER_ENTRY_ACCESS = { directory: 0o700, file: 0o600 } as const;

/**
 * The mode an extracted entry is written with: declared permission bits only, never set-id or
 * sticky bits, and always enough owner access that the extraction root can be removed recursively.
 * An entry that declares no mode at all gets the default; an explicit mode of zero is honored.
 */
export function extractedEntryMode(
  kind: ArchiveManifestEntry['kind'],
  declaredMode: number | undefined,
): number {
  const permissions =
    declaredMode === undefined ? DEFAULT_ENTRY_PERMISSIONS[kind] : declaredMode & 0o777;
  return permissions | OWNER_ENTRY_ACCESS[kind];
}

/**
 * Creates one directory entry with its own mode. Parents an archive never declared are created
 * with the default mode. Whether the directory is new or an earlier entry already implied it, it
 * ends up with the declared mode under the process umask, as the kernel applies to files, so entry
 * order does not change the extracted permissions.
 */
export async function createExtractedDirectory(outputPath: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await fs.mkdir(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await fs.lstat(outputPath)).isDirectory()) throw error;
  }
  await fs.chmod(outputPath, (mode & ~process.umask()) | OWNER_ENTRY_ACCESS.directory);
}

export function archiveError(reason: string, message: string, cause?: unknown): AppError {
  return new AppError('INVALID_ARGS', message, { reason }, cause);
}

function validateLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}
