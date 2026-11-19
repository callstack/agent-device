import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from './diagnostics.ts';

/**
 * What this process may rely on when it judges ground: who it is, as the kernel answers. The rule reads no
 * account database, so the answer does not depend on which name services run (ADR 0016). Every judgment below
 * decides over the fields of one `lstat`, so each is testable on its values.
 */
export type ScriptDestinationTrust = Readonly<{ uid: number; privateAncestry?: boolean }>;

/**
 * How strictly a caller's destination is judged. `privateAncestry` is for executable state, such as the Swift
 * helper cache: no directory the walk traverses may be group- or world-writable, sticky or not, because a
 * sticky shared directory lets another user claim a name a cleaner removed (ADR 0016).
 */
export type ScriptDestinationOptions = Readonly<{ privateAncestry?: boolean }>;

function scriptTrust(options: ScriptDestinationOptions): ScriptDestinationTrust {
  return { uid: process.getuid?.() ?? -1, privateAncestry: options.privateAncestry === true };
}

/**
 * The fields of a directory, or of a link, that the ancestry rule reads. The group id is deliberately absent,
 * for the account-file reason ADR 0016 states.
 */
export type DirectoryAuthority = Readonly<{ uid: number; mode: number }>;

export type LinkAuthority = Readonly<{ uid: number }>;

/** The ways a step can be unsafe; `untrustedGroundWording` words each one for the caller. */
export type ScriptAncestryExposure =
  | 'foreign_owned'
  | 'world_writable'
  | 'shared_group_writable'
  | 'shared_parent'
  | 'planted_link'
  | 'link_loop_exceeded'
  | 'not_a_directory'
  | 'entry_appeared'
  | 'relative_destination'
  | 'unnamed_entry'
  | 'unresolvable_parent'
  | 'unreachable_parent'
  | 'parent_replaced';

/**
 * Whether this user can rely on a destination being inside `directory`, and why not if they cannot. The
 * ownership-first order, the group-writable refusal, and the one sticky-bit exception are ADR 0016's; the
 * exception holds only for PASSING THROUGH, so {@link othersCreateEntriesIn} is asked separately before a name
 * is created.
 */
export function untrustedAncestryExposure(
  directory: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): ScriptAncestryExposure | undefined {
  if (directory.uid !== 0 && directory.uid !== trust.uid) return 'foreign_owned';
  if (directory.mode & 0o1000 && !trust.privateAncestry) return undefined;
  if (directory.mode & 0o002) return 'world_writable';
  if (directory.mode & 0o020) return 'shared_group_writable';
  return undefined;
}

/**
 * Whether other local users can add an entry here, which is how the destination's own name becomes theirs. A
 * directory somebody else owns counts whatever its mode says: the sticky bit shields other people's entries
 * (ADR 0016).
 */
export function othersCreateEntriesIn(
  directory: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): boolean {
  if (directory.uid !== 0 && directory.uid !== trust.uid) return true;
  if (directory.mode & 0o002) return true;
  return Boolean(directory.mode & 0o020);
}

/**
 * Whether a link on the path is one another local user could have put there, or could replace, and whose
 * target is therefore theirs to choose (ADR 0016).
 */
export function untrustedLinkExposure(
  link: LinkAuthority,
  home: DirectoryAuthority,
  trust: ScriptDestinationTrust,
): ScriptAncestryExposure | undefined {
  if (!othersCreateEntriesIn(home, trust)) return undefined;
  if (home.mode & 0o1000 && (link.uid === 0 || link.uid === trust.uid)) return undefined;
  return 'planted_link';
}

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
 * Publishes a session script, and nothing else: {@link publishFileSync} at {@link SCRIPT_FILE_MODE}, with the
 * destination-ancestry rule asked through {@link prepareScriptDestination}. A recording is a transcript of what
 * someone did here, so it is private, and the mode is asked EXACT: the umask of a shared checkout would
 * otherwise narrow it away from what the rule publishes everywhere else.
 */
export function publishScriptFileSync(options: {
  destination: string;
  contents: string;
  publish?: AtomicPublishMode;
}): string {
  // The entry is the one the rule authorized, never the caller's spelling: a `..` or a link sends the entry
  // elsewhere, and a temporary sibling beside that spelling is one another local user can reach (ADR 0016).
  const { entry } = prepareScriptDestination(options.destination);
  publishFileSync({
    destination: entry,
    contents: options.contents,
    mode: SCRIPT_FILE_MODE,
    publish: options.publish,
    exactMode: true,
  });
  return entry;
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

/** A recording holds literals a `fill` did not parameterize (ADR 0017), so it is written private. */
const SCRIPT_FILE_MODE = 0o600;

/**
 * A directory a publish creates is itself judged on the way to a later version, so it is created at the mode
 * the rule accepts under every umask — the shared-checkout umask 002 would otherwise leave it 0775 and refuse.
 */
const SCRIPT_DIR_MODE = 0o700;

/**
 * Readies a script destination and reports the PHYSICAL directory to create the entry in, in ADR 0016's order:
 * walk, refuse before anything is created, create what is missing, walk the completed chain again, answer.
 */
export function prepareScriptDestination(
  destination: string,
  options: ScriptDestinationOptions = {},
): ScriptDestination {
  return scriptDestination(destination, true, options);
}

/**
 * ADR 0016's judgment of one destination. `create` says whether the caller needs the missing tail created:
 * a walk that stops short is an answer for that caller and a refusal for the other.
 */
function scriptDestination(
  destination: string,
  create: boolean,
  options: ScriptDestinationOptions = {},
): ScriptDestination {
  if (process.platform === 'win32') {
    return windowsScriptDestination(destination, create);
  }
  // A relative spelling is refused first, whatever its last segment, because that is what makes it unjudgeable.
  const spelled = spelledParent(destination);
  const name = scriptEntryNameOrRefuse(destination);
  const trust = scriptTrust(options);
  // The walk answers the COMPLETED chain, so this is the one place the CREATION question is asked: below the
  // walk the missing directories are this call's own to create, and asking it before creation would refuse
  // `mkdir -p <sticky shared>/recordings`, where those levels are 0700 of this call's own (ADR 0016).
  const arrived = walkSpelledParent(spelled, destination, trust, create);
  if (othersCreateEntriesIn(arrived.authority, trust)) {
    throw scriptAncestryFailure(destination, arrived.deepest, 'shared_parent');
  }
  return authorizedEntry(arrived.deepest, arrived.identity, name);
}

function windowsScriptDestination(destination: string, create: boolean): ScriptDestination {
  const rules = path.win32;
  const root = requireWindowsScriptVolume(destination, destination);
  const name = entryNameOrRefuse(destination, rules);
  const directory = rules.dirname(rules.normalize(destination));
  requireWindowsScriptDirectory(destination, root);
  if (directory === root) return authorizedEntry(directory, 'windows', name);
  if (create) createWindowsScriptParents(destination, root, directory);
  else requireWindowsScriptDirectory(destination, directory);
  return authorizedEntry(directory, 'windows', name);
}

function createWindowsScriptParents(destination: string, root: string, directory: string): void {
  const missing: string[] = [];
  let parent = directory;
  // Start at the requested parent so a traverse-only ancestor needs no attribute read.
  while (parent !== root && !makeWindowsScriptDirectory(destination, parent)) {
    missing.push(parent);
    parent = path.win32.dirname(parent);
  }
  if (parent === root) throw scriptAncestryFailure(destination, root, 'unreachable_parent');
  for (const child of missing.reverse()) {
    if (!makeWindowsScriptDirectory(destination, child)) {
      throw scriptAncestryFailure(destination, child, 'unreachable_parent');
    }
  }
}

function makeWindowsScriptDirectory(destination: string, directory: string): boolean {
  try {
    fs.mkdirSync(directory, { mode: SCRIPT_DIR_MODE });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    if (code !== 'EEXIST') throw error;
    requireWindowsScriptDirectory(destination, directory);
  }
  return true;
}

function requireWindowsScriptDirectory(destination: string, directory: string): void {
  let stats: fs.Stats | undefined;
  try {
    stats = fs.statSync(directory, { throwIfNoEntry: false });
  } catch (error) {
    if (!isWindowsShareUnavailable(directory, error)) throw error;
  }
  if (!stats) throw scriptAncestryFailure(destination, directory, 'unreachable_parent');
  if (!stats.isDirectory()) throw scriptAncestryFailure(destination, directory, 'not_a_directory');
}

/** Windows reports a deleted share as a connection reset through libuv. */
export function isWindowsShareUnavailable(file: string, error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    /^[\\/]{2}/.test(file) &&
    (error as NodeJS.ErrnoException | undefined)?.code === 'ECONNRESET'
  );
}

function authorizedEntry(
  directory: string,
  identity: string | undefined,
  name: string,
): ScriptDestination {
  return { directory, identity, name, entry: hostPathRules().join(directory, name) };
}

/**
 * The name a spelled script destination's entry is created under, or a refusal when its last segment names
 * none. Both the preflight that expands a caller's spelling and the publication itself ask this one helper,
 * before anything touches the filesystem (ADR 0016).
 */
export function scriptEntryNameOrRefuse(spelled: string): string {
  const rules = hostPathRules();
  if (rules === path.win32 && /^[\\/]|^[a-z]:/i.test(spelled)) {
    requireWindowsScriptVolume(spelled, spelled);
  }
  return entryNameOrRefuse(spelled, rules);
}

function entryNameOrRefuse(spelled: string, rules: path.PlatformPath): string {
  const name = scriptEntryName(spelled, rules);
  if (name === undefined) throw unnamedEntryFailure(spelled, rules);
  return name;
}

/** Returns the drive or complete ordinary UNC root of a Windows script path. */
export function requireWindowsScriptVolume(spelled: string, candidate: string): string {
  const drive = /^[a-z]:[\\/]/i.test(candidate);
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(candidate);
  if (
    drive ||
    (unc &&
      unc.slice(1).every((part) => !/[:?*<>"|]|[. ]$/.test(part) && !hasControlCharacter(part)))
  ) {
    return path.win32.parse(path.win32.normalize(candidate)).root;
  }
  throw new AppError(
    'INVALID_ARGS',
    `Refusing to save the script at ${spelled}: ${candidate} lacks a supported Windows volume.`,
    {
      reason: 'script_ancestor_untrusted',
      exposure: 'windows_path_form',
      path: spelled,
      ancestor: candidate,
      hint: 'Use an absolute drive-letter path or an ordinary Windows network share path.',
    },
  );
}

/** The path rules of the host this runs on, read when asked, the way the destination rule reads its platform. */
export function hostPathRules(): path.PlatformPath {
  return process.platform === 'win32' ? path.win32 : path.posix;
}

/**
 * The refusal for a spelling {@link scriptEntryName} names no entry for. A Windows directory holding a `:` is
 * the PATH's fault, not its last name's, so that refusal names the directory and says what to change there.
 */
export function unnamedEntryFailure(spelled: string, rules: path.PlatformPath): AppError {
  const parent = rules.dirname(spelled);
  if (rules.sep === '\\' && holdsColonAfterRoot(rules.normalize(parent), rules)) {
    return new AppError(
      'INVALID_ARGS',
      `Refusing to save the script under ${parent}: a Windows path cannot hold \`:\` after its drive, and a directory in it does.`,
      {
        reason: SCRIPT_ANCESTRY_REASONS[0],
        exposure: 'unnamed_entry',
        path: spelled,
        ancestor: parent,
        hint: 'Remove the `:` from the directory names in the script path.',
      },
    );
  }
  return scriptAncestryFailure(spelled, parent, 'unnamed_entry');
}

/** Whether a name holds a character below U+0020, which Windows refuses in a file name. */
function hasControlCharacter(name: string): boolean {
  return [...name].some((character) => character.charCodeAt(0) < 0x20);
}

/** Whether a Windows path holds a `:` past its root, where only a stream separator would put one. */
function holdsColonAfterRoot(normalized: string, rules: path.PlatformPath): boolean {
  return normalized.slice(rules.parse(normalized).root.length).includes(':');
}

/**
 * The one entry a script destination's spelling names under `rules`, or `undefined` when its last segment
 * names none: empty, a root, `.`, `..`, a spelling holding a NUL, or the bare `~` a home expansion turns
 * into a directory. A trailing separator names the same entry it always has. The split is root-aware: a
 * basename would turn the share of a bare UNC root into a file name.
 */
export function scriptEntryName(spelled: string, rules: path.PlatformPath): string | undefined {
  // A lone surrogate is written as U+FFFD, so the file created would be another name than the one judged.
  const bareHome = rules.sep === '\\' ? /^~[\\/]*$/ : /^~\/*$/;
  if (spelled.includes('\0') || /\p{Surrogate}/u.test(spelled) || bareHome.test(spelled)) {
    return undefined;
  }
  // The raw last segment first: a normalization folds a final `.` or `..` away.
  const { base } = rules.parse(spelled);
  if (base === '' || base === '.' || base === '..' || exceedsNameMax(base, rules)) return undefined;
  return rules.sep === '\\' ? windowsEntryName(rules.normalize(spelled), rules) : base;
}

/**
 * Whether a name is longer than one directory entry can hold: 255 UTF-8 bytes on the common POSIX filesystems,
 * 255 UTF-16 units on NTFS. Refused before anything is created, instead of failing after its parent was made.
 */
function exceedsNameMax(name: string, rules: path.PlatformPath): boolean {
  return (rules.sep === '\\' ? name.length : Buffer.byteLength(name)) > NAME_MAX;
}

const NAME_MAX = 255;

/**
 * The Windows answer, read from the spelling as the publisher's own joins normalize it, so a doubled separator
 * cannot hide a root. A device-namespace path, an extended UNC root that `parse` reads as names, a reserved
 * device name, and a stream after a `:` all name something other than one file.
 */
function windowsEntryName(normalized: string, rules: path.PlatformPath): string | undefined {
  // The device namespace, and an extended prefix that names anything but a drive or a UNC share.
  if (/^\\\\\.\\/.test(normalized)) return undefined;
  if (/^\\\\\?\\/.test(normalized) && !/^\\\\\?\\(?:[A-Z]:\\|UNC\\)/i.test(normalized))
    return undefined;
  if (/^\\\\\?\\UNC(?:\\[^\\]+){0,2}\\?$/i.test(normalized)) return undefined;
  // An IPC share, ordinary or extended, opens a named pipe or a mailslot, not a file: `pipe`, `IPC$` (the SMB
  // named-pipe share) and `mailslot`. The same names below an ordinary share are ordinary directories.
  if (/^\\\\(?:\?\\UNC\\)?[^\\]+\\(?:pipe|IPC\$|mailslot)(?:\\|$)/i.test(normalized)) {
    return undefined;
  }
  const { base } = rules.parse(normalized);
  if (base === '' || holdsColonAfterRoot(normalized, rules)) return undefined;
  // Microsoft's naming rules: no reserved character or control character, no trailing dot or space, and no
  // reserved device name, with or without an extension.
  if (/[<>:"/\\|?*]/.test(base) || hasControlCharacter(base) || /[. ]$/.test(base))
    return undefined;
  // Only ASCII spaces fall away before the comparison; a no-break space is part of the name.
  const stem = base.split('.')[0]?.replace(/ +$/, '') ?? '';
  return /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)$/i.test(stem)
    ? undefined
    : base;
}

/**
 * The entry a script is created as: the PHYSICAL directory the rule judged, that directory's identity as the
 * walk's own `lstat` answered it — what {@link confirmScriptDestination} compares before a rename — and the
 * validated name. `entry` is the one path a publisher creates.
 */
export type ScriptDestination = Readonly<{
  directory: string;
  identity: string | undefined;
  name: string;
  entry: string;
}>;

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

/**
 * Judges a destination that is already in place, creating nothing, and reports its entry: what a caller
 * answers about a version it published before (ADR 0016).
 */
export function judgeScriptDestination(destination: string): ScriptDestination {
  return scriptDestination(destination, false);
}

/**
 * Confirms a destination host-kit ANSWERED earlier, and reports the entry to create. The one check a caller
 * that stages bytes owes, for the reason ADR 0016 states. The entry is authorized only when this walk reaches
 * the same directory.
 */
export function confirmScriptDestination(
  destination: string,
  prepared: ScriptDestination,
): ScriptDestination {
  const current = scriptDestination(destination, false);
  // The directory is compared too: Windows answers one constant identity for every directory.
  if (current.identity !== prepared.identity || current.directory !== prepared.directory) {
    throw scriptAncestryFailure(destination, current.directory, 'parent_replaced');
  }
  return current;
}

/**
 * The parent of `destination` exactly as the caller spells it, refusing a RELATIVE destination on every
 * platform, Windows included, where no walk runs to catch it (ADR 0016).
 */
function spelledParent(destination: string): string {
  const parent = path.dirname(destination);
  if (!path.isAbsolute(parent)) {
    throw scriptAncestryFailure(destination, parent, 'relative_destination');
  }
  return parent;
}

/** Where the walk stands: a judged directory, the identity its own `lstat` answered, names left to resolve. */
type WalkState = Readonly<{
  deepest: string;
  authority: DirectoryAuthority;
  identity: string;
  /** Path components left to resolve, nearest first. */
  queue: readonly string[];
  /** Link targets expanded so far. */
  hops: number;
}>;

/**
 * The ground a walk answered: the PHYSICAL directory the entry is created in, with the authority and identity
 * it was judged under, so the caller never asks the host about ground the walk already read.
 */
type WalkGround = Readonly<{
  deepest: string;
  authority: DirectoryAuthority;
  /** That directory's identity, as this walk's `lstat` of it answered. */
  identity: string;
}>;

/** The tail a walk stopped below: the nearest judged directory and the spelled names absent beneath it. */
type ShortTail = Readonly<{
  /** The nearest directory the walk did judge; the destination's name is absent below it. */
  deepest: string;
  /** The spelled names below `deepest`, the first of them absent. */
  missing: readonly string[];
  /** Whether a `..` is queued behind that name, so creating cannot resolve the chain. */
  unresolvable: boolean;
}>;

/**
 * Walks the spelled parent exactly as the kernel resolves a path — the resolution ADR 0016 describes: no
 * `realpath`, `..` applied to the directory physically stood in, a link's raw components queued ahead of the
 * rest, hops capped at {@link MAX_SCRIPT_PATH_LINK_HOPS}. It throws at the first step another local user could
 * steer; `destination` appears only in the refusal that names it.
 *
 * A caller that creates gets the ANSWER FOR THE COMPLETED CHAIN: the walk stops at the first absent name, makes
 * that tail inside the directory it judged, and judges the chain again from the root, because creating is the
 * one moment ground below this call's feet changes. Anything still short then is a refusal.
 */
function walkSpelledParent(
  parent: string,
  destination: string,
  trust: ScriptDestinationTrust,
  create: boolean,
): WalkGround {
  const refuse = (ancestor: string, exposure: ScriptAncestryExposure): never => {
    throw scriptAncestryFailure(destination, ancestor, exposure);
  };
  let state = standOn('/', pathComponents(parent), trust, 0, refuse);
  let created = false;
  // Every step consumes a component, and every link hop counts against a fixed limit, so this ends.
  for (;;) {
    const [component, ...rest] = state.queue;
    // The only ending that ARRIVES: an empty queue, every name the parent spelled resolved and judged.
    if (component === undefined) {
      return { deepest: state.deepest, authority: state.authority, identity: state.identity };
    }
    // `..` is the parent of the directory PHYSICALLY stood in, not of the spelling: where `work` is a link,
    // `.../work/../x` steps back from the link's target and lands beside it.
    if (component === '..') {
      state = standOn(path.dirname(state.deepest), rest, trust, state.hops, refuse);
      continue;
    }
    const step = stepIntoEntry(state, component, rest, trust, refuse);
    if (step.ended === 'short') {
      const { deepest, missing, unresolvable } = step;
      // Nothing stands below here. A caller that creates makes that tail and is judged again; a step back out
      // of a directory that is not there is something no amount of creating resolves.
      if (!create || created || unresolvable) {
        throw scriptAncestryFailure(
          destination,
          deepest,
          unresolvable ? 'unresolvable_parent' : 'unreachable_parent',
        );
      }
      createMissingLevels(destination, deepest, missing, trust);
      created = true;
      state = standOn('/', pathComponents(parent), trust, 0, refuse);
      continue;
    }
    state = step.state;
  }
}

/** Where one named entry leaves the walk: standing on a judged directory, or short of the chain. */
type EntryStep =
  | Readonly<{ ended: 'stand'; state: WalkState }>
  | (ShortTail & Readonly<{ ended: 'short' }>);

/**
 * Resolves one named entry inside the directory the walk stands in, judged by this call's own `lstat` of the
 * NAME (ADR 0016).
 */
function stepIntoEntry(
  state: WalkState,
  component: string,
  rest: readonly string[],
  trust: ScriptDestinationTrust,
  refuse: (ancestor: string, exposure: ScriptAncestryExposure) => never,
): EntryStep {
  const entry = path.join(state.deepest, component);
  const stats = lstatEntry(entry);
  if (stats === undefined) {
    return {
      ended: 'short',
      deepest: state.deepest,
      missing: [component, ...rest],
      unresolvable: rest.includes('..'),
    };
  }
  if (stats.isSymbolicLink()) return hopThroughLink(state, entry, stats, rest, trust, refuse);
  if (!stats.isDirectory()) refuse(entry, 'not_a_directory');
  const authority = directoryAuthority(stats);
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) refuse(entry, exposure);
  return {
    ended: 'stand',
    state: {
      deepest: entry,
      authority,
      identity: identityOf(stats),
      queue: rest,
      hops: state.hops,
    },
  };
}

/** One hop: the link is judged where it stands, and its target's components enter the queue. */
function hopThroughLink(
  state: WalkState,
  link: string,
  stats: fs.BigIntStats,
  rest: readonly string[],
  trust: ScriptDestinationTrust,
  refuse: (ancestor: string, exposure: ScriptAncestryExposure) => never,
): EntryStep {
  const exposure = untrustedLinkExposure({ uid: Number(stats.uid) }, state.authority, trust);
  if (exposure) refuse(link, exposure);
  if (state.hops >= MAX_SCRIPT_PATH_LINK_HOPS) refuse(link, 'link_loop_exceeded');
  const target = fs.readlinkSync(link);
  // A relative target continues from the directory that HOLDS the link, and its components are queued RAW
  // rather than joined: ADR 0016.
  const home = path.isAbsolute(target) ? '/' : path.dirname(link);
  return {
    ended: 'stand',
    state: standOn(home, [...pathComponents(target), ...rest], trust, state.hops + 1, refuse),
  };
}

/**
 * Stands the walk on `directory`, judged from this call's own `lstat` of it, or refuses it. A name come back
 * around through a `..` or an alias is judged again, and reaches the judgment it had on the first visit
 * (ADR 0016).
 */
function standOn(
  directory: string,
  queue: readonly string[],
  trust: ScriptDestinationTrust,
  hops: number,
  refuse: (ancestor: string, exposure: ScriptAncestryExposure) => never,
): WalkState {
  const stats = lstatEntry(directory);
  if (stats === undefined || !stats.isDirectory()) refuse(directory, 'not_a_directory');
  const authority = directoryAuthority(stats);
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) refuse(directory, exposure);
  return { deepest: directory, authority, identity: identityOf(stats), queue, hops };
}

/** Owner and mode of the ENTRY one `lstat` answer describes. */
function directoryAuthority(stats: fs.BigIntStats): DirectoryAuthority {
  return { uid: Number(stats.uid), mode: Number(stats.mode) };
}

/**
 * The device and inode an `lstat` answer names. BIGINT stats: a numeric `ino` cannot hold every inode a
 * filesystem hands out, so two distinct large inodes would collapse onto one identity.
 */
function identityOf(stats: fs.BigIntStats): string {
  return `${stats.dev}:${stats.ino}`;
}

/** The only lookup this rule makes: `lstat` with bigint ids, absence as `undefined`. */
function lstatEntry(pathname: string): fs.BigIntStats | undefined {
  return fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
}

/** The names of `directory`, every `.` resolved away the way the kernel does. */
function pathComponents(directory: string): string[] {
  return directory.split('/').filter((component) => component.length > 0 && component !== '.');
}

/**
 * How many link targets one walk expands before it refuses, kept BELOW the smallest limit the supported
 * kernels apply (macOS 32, Linux 40) so this rule reaches its own limit first and answers with its own reason.
 */
export const MAX_SCRIPT_PATH_LINK_HOPS = 30;

/** `lstat` where absence is `undefined` and any other failure is the caller's to answer for. */
function lstatIfPresent(pathname: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Why each exposure makes that ground unsafe, in the caller's terms. */
const untrustedGroundWording: Record<ScriptAncestryExposure, string> = {
  foreign_owned: 'another local user owns that part of the path.',
  world_writable: 'any local user can write that part of the path.',
  shared_group_writable:
    'the group can write that part of the path, and agent-device cannot tell who else belongs to that group.',
  shared_parent: 'another local user could create the script file there first.',
  planted_link: 'another local user could have put that symbolic link there, or could replace it.',
  link_loop_exceeded:
    'that part of the path follows more symbolic links than the system allows, so where the script would land is not established.',
  not_a_directory: 'a directory was expected there, and something else stands in the way.',
  entry_appeared:
    'a directory the script path needs was missing when the path was checked and appeared before this save could create it.',
  unnamed_entry:
    'the script path has to end in one file name of at most 255 bytes, not `.`, `..`, `~`, a root, or nothing at all, and it cannot hold a NUL.',
  relative_destination:
    'the script path has to be absolute, so the directories it names are the ones that get checked.',
  unresolvable_parent:
    'the script path names a directory that does not exist and steps back out of it with `..`, so where the script would land is not established.',
  unreachable_parent:
    'the directory the script path names does not exist, so the script has nowhere to be written.',
  parent_replaced:
    'that directory was replaced while the script was staged, so the script may not be created in what stands there now.',
};

/**
 * The typed reasons a destination-ancestry refusal answers with, named here rather than spelled again by
 * whoever reads them.
 */
const SCRIPT_ANCESTRY_REASONS = ['script_ancestor_untrusted', 'script_ancestry_replaced'] as const;

/** A reason this rule answers with, or `undefined` for an error that came from somewhere else. */
export function scriptAncestryReason(error: unknown): string | undefined {
  if (!(error instanceof AppError)) return undefined;
  const reason = error.details?.reason;
  return typeof reason === 'string' &&
    (SCRIPT_ANCESTRY_REASONS as readonly string[]).includes(reason)
    ? reason
    : undefined;
}

function scriptAncestryFailure(
  destination: string,
  ancestor: string,
  exposure: ScriptAncestryExposure,
): AppError {
  // A path that names no file is the caller's input to correct; every other refusal is about the ground.
  return new AppError(
    exposure === 'unnamed_entry' ? 'INVALID_ARGS' : 'COMMAND_FAILED',
    `Refusing to save the script under ${ancestor}: ${untrustedGroundWording[exposure]}`,
    {
      reason:
        exposure === 'parent_replaced' ? SCRIPT_ANCESTRY_REASONS[1] : SCRIPT_ANCESTRY_REASONS[0],
      exposure,
      path: destination,
      ancestor,
      hint: ancestryHint(exposure, ancestor),
    },
  );
}

/** What to do about it. A group-writable directory is the one refusal the caller can fix in place. */
function ancestryHint(exposure: ScriptAncestryExposure, ancestor: string): string {
  if (exposure === 'parent_replaced') {
    return 'Re-record with open --save-script, or save under a directory nobody else can write.';
  }
  if (exposure === 'unnamed_entry') {
    return 'End the script path in a valid file name, such as `--save-script=./workflows/journey.ad`.';
  }
  if (exposure === 'shared_group_writable') {
    return `Close the directory to its group with \`chmod g-w ${ancestor}\`, or save the script under a directory only you can write.`;
  }
  return 'Save the script under a directory you own that only you can write, and keep the path out of directories other users own.';
}

/**
 * Creates the tail the walk found missing, ONE LEVEL AT A TIME, inside the directory the walk judged, for the
 * one-name-at-a-time reason ADR 0016 states. A name that arrived since the walk looked is judged here, not
 * refused and not trusted, because two processes saving into the same new directory meet at that entry.
 */
function createMissingLevels(
  destination: string,
  established: string,
  missing: readonly string[],
  trust: ScriptDestinationTrust,
): void {
  let parent = established;
  for (const name of missing) {
    parent = createMissingLevel(destination, parent, name, trust);
  }
}

/**
 * Creates one missing level inside `parent`, or adopts the entry that appeared in its place, and reports the
 * directory the next name is created in.
 */
function createMissingLevel(
  destination: string,
  parent: string,
  name: string,
  trust: ScriptDestinationTrust,
): string {
  const level = path.join(parent, name);
  let created = true;
  try {
    fs.mkdirSync(level, { mode: SCRIPT_DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    created = false;
  }
  // The `lstat` of the NAME, after the creation attempt, is the judgment either way: what this call made
  // and what arrived beside it are read the same way and judged by the same rule.
  const seen = lstatEntry(level);
  if (seen === undefined || !seen.isDirectory()) {
    throw scriptAncestryFailure(destination, level, created ? 'not_a_directory' : 'entry_appeared');
  }
  const authority = directoryAuthority(seen);
  const exposure = untrustedAncestryExposure(authority, trust);
  if (exposure) throw scriptAncestryFailure(destination, level, exposure);
  if (created) {
    // `mkdir` ANDs its mode with the umask, and a umask can take an OWNER bit away: umask 200 would leave
    // this level 0500, where this call could not create the name below it. One `chmod` makes the level the
    // mode this rule creates, whatever the host's umask is.
    fs.chmodSync(level, SCRIPT_DIR_MODE);
    return level;
  }
  // Somebody else's directory: the one place this rule asks whether OTHER users could add a name here.
  if (othersCreateEntriesIn(authority, trust)) {
    throw scriptAncestryFailure(destination, level, 'shared_parent');
  }
  return level;
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
