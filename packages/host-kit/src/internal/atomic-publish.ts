import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { identityOf, lstatEntry, lstatIfPresent } from './file-identity.ts';
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
  /** Asked of the NAME at both staging seams; see {@link publishStagedSync}. */
  assertDestination?: (destination: string) => void;
  /** Asked of the DIRECTORY before the staged sibling is removed; see {@link publishStagedSync}. */
  assertStagedIn?: (destination: string) => void;
}): void {
  const existing = options.preserveExistingMode
    ? fs.statSync(options.destination, { throwIfNoEntry: false })
    : undefined;
  const preservedMode = existing?.isFile() ? existing.mode & 0o777 : undefined;
  const mode = preservedMode ?? options.mode;
  publishStagedSync({
    destination: options.destination,
    contents: options.contents,
    // With NO mode asked, the create asks the host's full `0666` and lets the umask price it down, which is
    // what a generic caller has always gotten: a mode-less publish of a shared artifact landed 0644 under
    // umask 022. A caller that wants a private file ASKS for it, as a state record does.
    createMode: mode ?? 0o666,
    // A file CREATE ANDs its mode with the umask, so a mode that has to be EXACT is SAID on the open
    // descriptor before the entry exists and no reader sees a wider file. Preserving an existing mode is
    // always exact. An asked-for mode is NOT, which is what a generic caller has always relied on: with
    // `mode` 0600 under umask 0200 it gets 0400, and only a private owner asks for the exact number.
    exactMode: preservedMode ?? (options.exactMode ? mode : undefined),
    publish: options.publish,
    assertDestination: options.assertDestination,
    assertStagedIn: options.assertStagedIn,
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

/**
 * The identity of the entry an open descriptor reaches, or `undefined` where the host will not say it.
 *
 * Best effort on purpose: the identity only lets a cleanup compare the name it would remove with the entry the
 * create reached, so failing the whole publish over this lookup would trade a real write for tidying evidence.
 */
function identityOfEntryBestEffort(descriptor: number): string | undefined {
  try {
    return identityOf(fs.fstatSync(descriptor, { bigint: true }));
  } catch {
    return undefined;
  }
}

/**
 * Removes the sibling a publish created, and ONLY that entry. Called once the exclusive create has returned,
 * which is the moment the name — this pid and a fresh UUID — became this call's.
 *
 * Two asks remain, each answering one way the name could have stopped being this call's:
 *
 * - The entry standing there IS the entry this call created: the `lstat` of the NAME must answer the identity
 *   `fstat` gave for the open descriptor. No identity, or a DIFFERENT one, is somebody ELSE's to keep.
 * - The caller's staged-directory guard still passes. A state publish hands the same judgment the commit asks,
 *   so a directory renamed away and made again while bytes were staged is not tidied by this call.
 *
 * A cleanup never throws either way: a leftover sibling is evidence, not a failed write.
 */
function removeTempBestEffort(
  destination: string,
  temporaryPath: string,
  ours: string | undefined,
  stillOurs: ((destination: string) => void) | undefined,
): void {
  try {
    const standing = lstatEntry(temporaryPath);
    if (standing === undefined) return;
    if (ours === undefined || identityOf(standing) !== ours) {
      const reason = ours === undefined ? 'identity_unproven' : 'entry_replaced';
      emitDiagnostic({
        level: 'warn',
        phase: 'atomic_file_cleanup_skipped',
        data: { destination, temporaryPath, reason },
      });
      return;
    }
    try {
      stillOurs?.(destination);
    } catch {
      emitDiagnostic({
        level: 'warn',
        phase: 'atomic_file_cleanup_skipped',
        data: { destination, temporaryPath, reason: 'parent_authority_lost' },
      });
      return;
    }
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

/**
 * The ONE staging owner every atomic publish goes through: create the sibling exclusively, write it through
 * that descriptor, close the descriptor, commit, and clean up.
 *
 * The exclusive create is the CLAIM: nothing stood on that name a moment ago, so from the moment it returns the
 * name belongs to this call, and every later path cleans up to it. The descriptor is closed on every path,
 * including a failed identity lookup, so no fault at the seam strands one in a long-lived daemon. The first
 * error any step reports is the one thrown: a later close failure is evidence about the close, not the write.
 */
function publishStagedSync(options: {
  destination: string;
  contents: string | Uint8Array;
  /** The mode the CREATE asks for; the umask prices it down unless {@link exactMode} says otherwise. */
  createMode: number;
  /** The mode MADE exact on the open descriptor, after the create and before the entry is visible. */
  exactMode?: number;
  publish?: AtomicPublishMode;
  /** Proves the destination is still this call's to replace; asked again immediately before the commit. */
  assertDestination?: (destination: string) => void;
  /** Proves the staged sibling's DIRECTORY is still this call's judged ground; asked again before removal. */
  assertStagedIn?: (destination: string) => void;
  /** Makes the staged BYTES durable on the sibling before the commit. */
  fsyncContents?: boolean;
  /** Makes the containing directory durable after the commit, where the filesystem supports it. */
  syncDirectory?: boolean;
}): void {
  const { destination } = options;
  const temporaryPath = createAtomicPublishTempPath(path.dirname(destination), destination);
  const descriptor = fs.openSync(temporaryPath, 'wx', options.createMode);
  // Asked BEFORE anything can fail, and asked best effort: an identity lookup that errors costs this call the
  // extra proof about the sibling's name, never the bytes it came to write.
  const ours = identityOfEntryBestEffort(descriptor);
  let failed = false;
  let primaryError: unknown;
  const failWith = (error: unknown): void => {
    if (failed) return;
    failed = true;
    primaryError = error;
  };
  try {
    options.assertDestination?.(destination);
    fs.writeFileSync(
      descriptor,
      options.contents,
      typeof options.contents === 'string' ? 'utf8' : undefined,
    );
    if (options.exactMode !== undefined) fs.fchmodSync(descriptor, options.exactMode);
    if (options.fsyncContents) fs.fsyncSync(descriptor);
  } catch (error) {
    failWith(error);
  }
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    failWith(error);
  }
  if (failed) {
    removeTempBestEffort(destination, temporaryPath, ours, options.assertStagedIn);
    throw primaryError;
  }
  try {
    options.assertDestination?.(destination);
    if (options.publish === 'link-exclusive') {
      fs.linkSync(temporaryPath, destination);
    } else {
      fs.renameSync(temporaryPath, destination);
    }
    if (options.syncDirectory) syncDirectoryBestEffort(path.dirname(destination));
  } catch (error) {
    failWith(error);
    removeTempBestEffort(destination, temporaryPath, ours, options.assertStagedIn);
    throw primaryError;
  }
  // A commit that got the sibling onto the destination leaves nothing of ours behind; the lookup below then
  // finds no entry, which is absence, and absence is nothing to remove.
  removeTempBestEffort(destination, temporaryPath, ours, options.assertStagedIn);
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

export type DurableFilePublishMode = 'replace' | 'link-exclusive';

/** Publishes complete UTF-8 contents with a durable file and directory fence. */
export function publishDurableFileSync(options: {
  destination: string;
  contents: string;
  mode?: number;
  publish?: DurableFilePublishMode;
}): void {
  publishStagedSync({
    destination: options.destination,
    contents: options.contents,
    createMode: options.mode ?? 0o600,
    publish: options.publish,
    fsyncContents: true,
    syncDirectory: true,
    // A durable publish replaces a name it does not judge by the ancestry walk, so it asks the one thing it
    // can: that no link or special file stands at the destination, twice, either side of the commit.
    assertDestination: assertSafeDestination,
  });
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
