import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emitDiagnostic } from './diagnostics.ts';

export type AtomicPublishMode = 'replace' | 'link-exclusive';

/**
 * Publishes a complete file from a same-directory temporary sibling. Contents are text or bytes: an
 * encoding is passed only for text, so a PNG or a video chunk reaches the disk as the caller built it.
 *
 * The temporary file is always removed. Cleanup is best effort and never replaces the write or publish
 * error; a cleanup failure is retained as secondary evidence when a request diagnostics scope exists.
 */
export function publishFileSync(options: {
  destination: string;
  contents: string | Uint8Array;
  mode?: number;
  preserveExistingMode?: boolean;
  publish?: AtomicPublishMode;
  /** The asked-for mode is MADE exact on the sibling instead of paid for with the umask. */
  exactMode?: boolean;
}): void {
  withAtomicPublishTempPathSync(options.destination, (temporaryPath) => {
    const existing = options.preserveExistingMode
      ? fs.statSync(options.destination, { throwIfNoEntry: false })
      : undefined;
    const preservedMode = existing?.isFile() ? existing.mode & 0o777 : undefined;
    const mode = preservedMode ?? options.mode;
    const writeOptions = {
      encoding: typeof options.contents === 'string' ? ('utf8' as const) : undefined,
      ...(mode === undefined ? {} : { mode }),
    };
    fs.writeFileSync(temporaryPath, options.contents, writeOptions);
    // A file CREATE ANDs its mode with the umask, so a mode that has to be EXACT is SAID on the temporary
    // sibling before the entry exists and no reader sees a wider file. Preserving an existing mode is always
    // exact. An asked-for mode is NOT, which is what a generic caller has always relied on: with `mode` 0600
    // under umask 0200 it gets 0400, and only {@link publishScriptFileSync} asks for the exact number.
    const exactMode = preservedMode ?? (options.exactMode ? mode : undefined);
    if (exactMode !== undefined) fs.chmodSync(temporaryPath, exactMode);
    if (options.publish === 'link-exclusive') {
      fs.linkSync(temporaryPath, options.destination);
    } else {
      fs.renameSync(temporaryPath, options.destination);
    }
  });
}

/**
 * The canonical temp path for a destination: a sibling of the name, inside the directory the publish will
 * create the entry in — the walk's answer for a script destination, `path.dirname` for every other one. Its
 * name stays bounded whatever the destination's length, so any name that fits the filesystem has a temp
 * sibling that fits too.
 */
function createAtomicPublishTempPath(directory: string, destination: string): string {
  return path.join(
    directory,
    `${temporaryNamePrefix(destination)}${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
}

/** How many bytes of the destination's name a temp sibling repeats, so a reader can still tell whose it is. */
const TEMP_NAME_STEM_BYTES = 32;

/**
 * The start every temp sibling of `destination` shares, and no other destination's: at most 32 bytes of its
 * name for a reader, then a hash of the WHOLE name, so two names that share their first bytes never share it.
 */
function temporaryNamePrefix(destination: string): string {
  const name = path.basename(destination);
  let stem = '';
  for (const character of name) {
    if (Buffer.byteLength(stem + character) > TEMP_NAME_STEM_BYTES) break;
    stem += character;
  }
  const digest = crypto.createHash('sha256').update(name).digest('hex').slice(0, 16);
  return `.${stem}.${digest}.`;
}

function removeTempBestEffort(destination: string, temporaryPath: string | undefined): void {
  if (temporaryPath === undefined) return;
  try {
    fs.rmSync(temporaryPath, { force: true });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'atomic_file_cleanup_failed',
      data: {
        destination,
        temporaryPath,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export type DurableFilePublishMode = 'replace' | 'link-exclusive';

/** Publishes complete UTF-8 contents with a durable file and directory fence. */
export function publishDurableFileSync(options: {
  destination: string;
  contents: string;
  mode?: number;
  publish?: DurableFilePublishMode;
}): void {
  const directory = path.dirname(options.destination);
  withAtomicPublishTempPathSync(options.destination, (temporaryPath) => {
    let descriptor: number | undefined;
    let failed = false;
    let primaryError: unknown;
    try {
      assertSafeDestination(options.destination);
      descriptor = fs.openSync(temporaryPath, 'wx', options.mode ?? 0o600);
      fs.writeFileSync(descriptor, options.contents, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      assertSafeDestination(options.destination);
      if (options.publish === 'link-exclusive') {
        fs.linkSync(temporaryPath, options.destination);
      } else {
        fs.renameSync(temporaryPath, options.destination);
      }
      syncDirectoryBestEffort(directory);
    } catch (error) {
      failed = true;
      primaryError = error;
    }
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        if (!failed) {
          failed = true;
          primaryError = error;
        }
      }
    }
    if (failed) throw primaryError;
  });
}

/**
 * Gives a publisher a canonical temp path and cleanup ownership while it performs its own write protocol.
 * The sibling goes in `directory`, which the caller must name when it knows the physical directory the entry
 * is created in; a spelling that sends `..` or a link elsewhere is not where a temporary file may land.
 */
export function withAtomicPublishTempPathSync<T>(
  destination: string,
  publish: (temporaryPath: string) => T,
): T {
  const temporaryPath = createAtomicPublishTempPath(path.dirname(destination), destination);
  try {
    return publish(temporaryPath);
  } finally {
    removeTempBestEffort(destination, temporaryPath);
  }
}

/** Syncs a containing directory where the filesystem supports directory fsync. */
function syncDirectoryBestEffort(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch {
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
  }
}

/** Identifies a temp path produced for a particular destination. */
export function isAtomicPublishTemporaryPath(value: unknown, destination: string): boolean {
  if (typeof value !== 'string') return false;
  if (path.dirname(value) !== path.dirname(destination)) return false;
  const name = path.basename(value);
  return name.startsWith(temporaryNamePrefix(destination)) && name.endsWith('.tmp');
}

/** `lstat` where absence is `undefined` and any other failure is the caller's to answer for. */
function lstatIfPresent(pathname: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertSafeDestination(destination: string): void {
  const stats = lstatIfPresent(destination);
  if (stats?.isSymbolicLink()) {
    throw new Error(`Refusing to replace a durable file symbolic link: ${destination}`);
  }
  if (stats && !stats.isFile()) {
    throw new Error(
      `Refusing to replace a durable path that is not a regular file: ${destination}`,
    );
  }
}
