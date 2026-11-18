import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { trimEdgeDashes } from '@agent-device/kernel/collections';
import { AppError } from '@agent-device/kernel/errors';
import {
  commandDeveloperDir,
  runCmd,
  withCommandHost,
  type ExecOptions,
  type ExecResult,
} from '@agent-device/host-kit/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import {
  acquireProcessLock,
  expandUserHomePath,
  prepareScriptDestination,
  scriptAncestryReason,
  withProcessLock,
  type ProcessLockRelease,
} from '@agent-device/host-kit/file';
const LOCK_RETRY_DELAY_MS = 25;
// swift-driver runs each frontend job in its own process group. It stops them on SIGINT, but
// SIGKILL or SIGTERM leaves them compiling with no parent.
const SWIFTC_STOP = { signal: 'SIGINT', graceMs: 2_000 } as const;
// The compiler is launched by absolute path with a fixed PATH: an inherited PATH entry another user can write
// would otherwise choose the `xcrun` that runs as this user.
const XCRUN = '/usr/bin/xcrun';
const COMPILER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
// Without an explicit SDK, xcrun adds /usr/local/include and /usr/local/lib to the search paths, which another
// account may own on a shared Mac.
const COMPILER_ARGS = ['--sdk', 'macosx', 'swiftc'] as const;
// The admin group on macOS, which may write /Applications itself on a stock install.
const MACOS_ADMIN_GID = 80;

/**
 * The layout version. Each version lives in its own directory under the cache root, so nothing an earlier
 * release compiled, or left as compiler state, is ever reused.
 */
const SWIFT_CACHE_VERSION = '3';

const SWIFT_CACHE_UNTRUSTED_REASON = 'swift_cache_untrusted';

/** The directories of one cache version; every one of them sits inside the private version directory. */
type SwiftCacheDirectory = 'bin' | 'home' | 'module-cache';

const SWIFT_CACHE_OVERRIDE_HINT =
  'set AGENT_DEVICE_SWIFT_CACHE_DIR to a directory you own that only you can write, outside shared directories ' +
  'such as /tmp. Only owner and mode bits are checked, not ACLs: keeping ACLs on the cache directory closed is ' +
  'your responsibility.';

/**
 * What to do about a refusal. A group-writable cache root or ancestor is the one the caller can close in place.
 * The path is named as text, never pasted into a command, where a space in it would name another directory.
 */
function swiftCacheHint(exposure: unknown, ancestor: unknown): string {
  if (exposure === 'shared_group_writable' && typeof ancestor === 'string') {
    return `Remove group write access (chmod g-w) from this directory: ${ancestor}. Or ${SWIFT_CACHE_OVERRIDE_HINT}`;
  }
  return `Use a cache directory nobody else can change: ${SWIFT_CACHE_OVERRIDE_HINT}`;
}

/**
 * The directory compiled helpers land in for `env`: `AGENT_DEVICE_SWIFT_CACHE_DIR`, or this user's cache
 * directory. It is never a shared temp directory, where another local user could create the name first.
 */
export function getSwiftCacheRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.AGENT_DEVICE_SWIFT_CACHE_DIR?.trim();
  if (configured) return path.resolve(configured);
  const home = expandUserHomePath('~', { env });
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'agent-device', 'swift-cache');
  }
  // XDG says a relative XDG_CACHE_HOME is invalid and is ignored.
  const xdgCache = env.XDG_CACHE_HOME?.trim();
  const cacheBase = xdgCache && path.isAbsolute(xdgCache) ? xdgCache : path.join(home, '.cache');
  return path.join(cacheBase, 'agent-device', 'swift-cache');
}

/** A cache directory as it was judged: its physical path, and the identity its own `lstat` answered. */
type PreparedSwiftCacheDirectory = Readonly<{
  spelled: string;
  directory: string;
  identity: string;
}>;

/**
 * Readies one directory of the current cache version: a real directory directly inside the version directory,
 * owned by this uid and owner-only. Nothing is ever deleted: an exposed directory is refused, and the hint names
 * it for the user to remove.
 */
function prepareSwiftCacheDirectory(
  env: NodeJS.ProcessEnv,
  name: SwiftCacheDirectory,
): PreparedSwiftCacheDirectory {
  const cacheRoot = getSwiftCacheRoot(env);
  const spelled = path.join(cacheRoot, `v${SWIFT_CACHE_VERSION}`, name);
  return untrustedAsSwiftCacheError(spelled, () => {
    const directory = path.join(prepareSwiftCacheVersionDirectory(cacheRoot), name);
    createPrivateDirectory(directory);
    return { spelled, directory, identity: judgeOwnedDirectory(directory) };
  });
}

/**
 * The version directory is the boundary. The cache root is judged first by the walk, and an executable cache
 * takes no sticky pass-through there: in a sticky shared directory a cleanup can remove the cache and another
 * account can claim its name before a helper runs. The version directory itself must then be a real directory
 * directly beneath that judged root, never a link the walk would resolve.
 */
function prepareSwiftCacheVersionDirectory(cacheRoot: string): string {
  const versionName = `v${SWIFT_CACHE_VERSION}`;
  // Judged before anything is created, so no level is made under ground the cache would then refuse.
  refuseUntrustedCacheAncestry(cacheRoot, untrustedLevelFrom(nearestExistingDirectory(cacheRoot)));
  // The walk judges and creates the PARENT of the name it is given; the version directory is never resolved by it.
  const { directory: root } = prepareScriptDestination(path.join(cacheRoot, versionName));
  // Judged again over the completed chain the walk answers.
  refuseUntrustedCacheAncestry(cacheRoot, untrustedLevelFrom(root));
  const versionDirectory = path.join(root, versionName);
  createPrivateDirectory(versionDirectory);
  judgeOwnedDirectory(versionDirectory);
  return versionDirectory;
}

/** The physical path of the nearest directory at or above `directory` that already exists. */
function nearestExistingDirectory(directory: string): string {
  for (let level = directory; ; level = path.dirname(level)) {
    try {
      return fs.realpathSync.native(level);
    } catch {
      if (level === path.dirname(level)) return level;
    }
  }
}

function refuseUntrustedCacheAncestry(cacheRoot: string, ancestor: string | undefined): void {
  if (ancestor !== undefined) {
    const stats = fs.lstatSync(ancestor);
    const exposure = !stats.isDirectory()
      ? 'not_a_directory'
      : stats.mode & 0o002
        ? 'world_writable'
        : stats.mode & 0o020
          ? 'shared_group_writable'
          : 'foreign_owned';
    throw untrustedSwiftCache(cacheRoot, undefined, {
      exposure,
      ancestor,
      hint: swiftCacheHint(exposure, ancestor),
    });
  }
}

/** Creates a directory at 0700 when it is missing; what already stands there is judged by the caller. */
function createPrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Refuses anything but an owner-only directory this uid owns, and answers its identity. This code creates every
 * cache directory at 0700, so anything else there means someone changed it: the user removes it, never this code.
 */
function judgeOwnedDirectory(directory: string): string {
  const stats = fs.lstatSync(directory, { bigint: true });
  const exposure = stats.isSymbolicLink()
    ? 'planted_link'
    : !stats.isDirectory()
      ? 'not_a_directory'
      : Number(stats.uid) !== process.getuid?.()
        ? 'foreign_owned'
        : Number(stats.mode) & 0o077
          ? 'not_owner_only'
          : undefined;
  if (exposure) {
    throw untrustedSwiftCache(directory, undefined, {
      exposure,
      ancestor: directory,
      // No command is built from the path: a pasted, unquoted path with a space would name another directory.
      hint:
        'Point AGENT_DEVICE_SWIFT_CACHE_DIR at a new directory that only you can write. agent-device never ' +
        `deletes the refused directory; remove it yourself once you no longer need it: ${directory}. Do not ` +
        'chmod it: that clears this refusal but keeps whatever was written while it was open. ' +
        'Only owner and mode bits are checked, not ACLs: keeping ACLs on the cache directory closed is your ' +
        'responsibility.',
    });
  }
  return `${stats.dev}:${stats.ino}`;
}

/**
 * The physical path of a prepared cache directory, after confirming it is still the directory that was judged:
 * one removed and recreated since then, by anyone, is refused.
 */
function confirmSwiftCacheDirectory(prepared: PreparedSwiftCacheDirectory): string {
  const stats = fs.lstatSync(prepared.directory, { bigint: true, throwIfNoEntry: false });
  if (!stats?.isDirectory() || `${stats.dev}:${stats.ino}` !== prepared.identity) {
    throw untrustedSwiftCache(prepared.spelled, undefined, {
      exposure: 'parent_replaced',
      ancestor: prepared.directory,
      hint: swiftCacheHint(undefined, undefined),
    });
  }
  return prepared.directory;
}

/**
 * Whether the cache entry is an executable this user published: a regular file, not a link, owned by this uid and
 * writable by nobody else. Anything else is a miss, and the compile renames its own output over that name.
 */
function isReusableSwiftExecutable(filePath: string): boolean {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  return (
    stats !== undefined &&
    stats.isFile() &&
    stats.uid === process.getuid?.() &&
    (stats.mode & 0o022) === 0 &&
    (stats.mode & 0o100) !== 0
  );
}

export function isUntrustedSwiftCacheError(error: unknown): error is AppError {
  return error instanceof AppError && error.details?.reason === SWIFT_CACHE_UNTRUSTED_REASON;
}

function untrustedAsSwiftCacheError<T>(directory: string, judge: () => T): T {
  try {
    return judge();
  } catch (error) {
    throw asSwiftCacheFailure(directory, error);
  }
}

/** The async form of {@link untrustedAsSwiftCacheError}, for a whole cache operation. */
async function withinSwiftCache<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw asSwiftCacheFailure(directory, error);
  }
}

/**
 * The refusal a cache failure stands for. An ancestry refusal, and a filesystem operation this user may not
 * perform, such as in a cache root another account created first, mean a cache that is not this user's to use.
 * Typed errors, the compiler's among them, keep their own path.
 */
function asSwiftCacheFailure(directory: string, error: unknown): unknown {
  if (error instanceof AppError) {
    if (scriptAncestryReason(error) === undefined) return error;
    const { exposure, ancestor } = error.details ?? {};
    return untrustedSwiftCache(directory, error, {
      exposure,
      ancestor,
      hint: swiftCacheHint(exposure, ancestor),
    });
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return untrustedSwiftCache(directory, error, {
      errno: code,
      hint: swiftCacheHint(undefined, undefined),
    });
  }
  return error;
}

function untrustedSwiftCache(
  directory: string,
  cause: unknown,
  details: Record<string, unknown>,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Refusing to use the Swift helper cache directory ${directory}: it is not private to this user.`,
    { reason: SWIFT_CACHE_UNTRUSTED_REASON, ...details, directory },
    cause,
  );
}

/**
 * The environment a compiled helper runs with, constructed rather than inherited: the cache's own home and module
 * cache, a fixed PATH and the host's locale. No other inherited variable reaches a helper, so no loader variable
 * (`DYLD_*`) can make a private, unchanged binary load someone else's code, on a cache hit or a fresh compile.
 */
function buildSwiftToolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const locale = Object.entries(env).filter(([name]) => name === 'LANG' || name.startsWith('LC_'));
  return {
    ...Object.fromEntries(locale),
    HOME: prepareSwiftCacheDirectory(env, 'home').directory,
    CLANG_MODULE_CACHE_PATH: prepareSwiftCacheDirectory(env, 'module-cache').directory,
    PATH: COMPILER_PATH,
  };
}

/**
 * Launches a compiled helper with the constructed helper environment, under an empty request overlay, so neither
 * the host's other variables nor a request's own `DEVELOPER_DIR` reach it. Every helper launch goes through here.
 */
export async function runSwiftHelper(
  host: HostEnvironment,
  executablePath: string,
  args: readonly string[],
  options: Omit<ExecOptions, 'env'> = {},
): Promise<ExecResult> {
  return await withCommandHost(
    { host, requestEnv: {} },
    async () =>
      await runCmd(executablePath, args, { ...options, env: buildSwiftToolEnv(host.env) }),
  );
}

/**
 * The environment the compiler runs with, built from an allowlist: the helper environment, this compile's private
 * staging directory as every temp directory, and the judged toolchain selection. Nothing else inherited reaches
 * xcrun, swiftc, clang or ld, so no variable can choose a loader, search path, linker or driver library.
 */
function swiftCompilerEnv(
  env: NodeJS.ProcessEnv,
  stagingDirectory: string,
  developerDir: string | undefined,
): NodeJS.ProcessEnv {
  return {
    ...buildSwiftToolEnv(env),
    ...(developerDir === undefined ? {} : { DEVELOPER_DIR: trustedDeveloperDir(developerDir) }),
    TMPDIR: stagingDirectory,
    TEMP: stagingDirectory,
    TMP: stagingDirectory,
  };
}

/**
 * The toolchain selection a command spawned for `host` gets: a request's own `DEVELOPER_DIR` for the same host wins
 * over the host's, and an explicitly empty one selects `xcode-select`.
 */
async function selectedDeveloperDir(host: HostEnvironment): Promise<string | undefined> {
  return await withCommandHost({ host, requestEnv: undefined }, async () => commandDeveloperDir());
}

/**
 * The selected Developer directory, resolved once: an absolute path whose resolved directory and every directory
 * above it are owned by root or this uid and closed to the group and others. The one exception is `/Applications`
 * itself as a stock macOS install leaves it: root-owned, writable by the admin group.
 */
function trustedDeveloperDir(selection: string): string {
  // Normalized before and after resolving: a link without the .app suffix can still resolve to a bundle.
  const spelled = path.isAbsolute(selection)
    ? realpathIfPresent(effectiveDeveloperDir(selection))
    : undefined;
  const resolved = spelled && realpathIfPresent(effectiveDeveloperDir(spelled));
  const ancestor = resolved === undefined ? selection : untrustedLevelFrom(resolved);
  if (resolved !== undefined && ancestor === undefined) return resolved;
  throw new AppError(
    'COMMAND_FAILED',
    `Refusing to compile Swift helpers with DEVELOPER_DIR=${selection}: ${ancestor} is not a directory only root or this user can change.`,
    {
      reason: SWIFT_CACHE_UNTRUSTED_REASON,
      exposure: 'untrusted_developer_dir',
      ancestor,
      hint:
        'Unset DEVELOPER_DIR so the selected Xcode is used, or point it at an Xcode Developer directory, given ' +
        'as an absolute path, that root or you own along with every directory above it.',
    },
  );
}

/**
 * The directory xcrun actually uses for a selection: an Xcode bundle (`…/Xcode.app`) selects its
 * `Contents/Developer`, so that whole path, `Contents` included, is what gets judged and passed on.
 */
function effectiveDeveloperDir(selection: string): string {
  return path.basename(selection).endsWith('.app')
    ? path.join(selection, 'Contents', 'Developer')
    : selection;
}

/**
 * The canonical path, from the filesystem's own spelling: on a case-insensitive volume `/applications` and
 * `/Applications` are one directory, and only the native answer spells it the way the exact checks expect.
 */
function realpathIfPresent(selection: string): string | undefined {
  try {
    return fs.realpathSync.native(selection);
  } catch {
    return undefined;
  }
}

/**
 * The first level, from `directory` up to `/`, that another user could change, or `undefined`: every level must be
 * a directory root or this uid owns that the group and others cannot write, sticky or not. The one exception is
 * `/Applications` itself as a stock macOS install leaves it: root-owned, writable by the admin group.
 */
function untrustedLevelFrom(directory: string): string | undefined {
  for (let level = directory; ; level = path.dirname(level)) {
    const stats = fs.lstatSync(level);
    const owned = stats.uid === 0 || stats.uid === process.getuid?.();
    const stockApplications =
      level === '/Applications' && stats.uid === 0 && stats.gid === MACOS_ADMIN_GID;
    const writableMask = stockApplications ? 0o002 : 0o022;
    if (!stats.isDirectory() || !owned || stats.mode & writableMask) return level;
    if (level === path.dirname(level)) return undefined;
  }
}

/** A Swift source compiled into a helper, under the file name the compiler is given. */
export type EmbeddedSwiftSource = Readonly<{ fileName: string; text: string }>;

/**
 * Compiles a helper from sources shipped inside the JavaScript build, in the order given. The cache key is
 * derived from those bytes, and the compiler reads them from this compile's private staging directory, so no
 * source found on disk, or a different version of it, is ever what gets compiled.
 */
export async function compileSwiftSources(params: {
  host: HostEnvironment;
  cacheName: string;
  sources: readonly EmbeddedSwiftSource[];
  timeoutMs?: number;
}): Promise<string> {
  const cacheName = sanitizeCacheName(params.cacheName);
  const key = hashParts([
    SWIFT_CACHE_VERSION,
    process.platform,
    process.arch,
    // The fixed compiler arguments are part of what is compiled: a release that changes them gets new entries.
    ...COMPILER_ARGS,
    ...params.sources.flatMap(({ fileName, text }) => [fileName, text]),
  ]);
  return await ensureSwiftExecutable({
    host: params.host,
    sources: params.sources,
    entryName: `${cacheName}-${key}`,
    timeoutMs: params.timeoutMs,
  });
}

export async function compileSwiftSourceText(params: {
  host: HostEnvironment;
  source: string;
  cacheName: string;
  timeoutMs?: number;
  /** Cancels the compile: kills `swiftc`, or stops waiting for another process's compile. */
  signal?: AbortSignal;
}): Promise<string> {
  const cacheName = sanitizeCacheName(params.cacheName);
  const key = hashParts([
    SWIFT_CACHE_VERSION,
    process.platform,
    process.arch,
    ...COMPILER_ARGS,
    params.source,
  ]);
  return await ensureSwiftExecutable({
    host: params.host,
    sources: [{ fileName: `${cacheName}-${key}.swift`, text: params.source }],
    entryName: `${cacheName}-${key}`,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
}

/**
 * Reuses or compiles one helper and answers its physical path. The entry, its lock and the compile's temp
 * directory all sit in the `bin` just judged inside the owner-only version directory. After the lock wait, and
 * again before the rename, `bin` is confirmed to be that same directory.
 */
async function ensureSwiftExecutable(params: {
  host: HostEnvironment;
  sources: readonly EmbeddedSwiftSource[];
  entryName: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const bin = prepareSwiftCacheDirectory(params.host.env, 'bin');
  const entryIn = (directory: string) => path.join(directory, params.entryName);
  const executablePath = entryIn(bin.directory);
  return await withinSwiftCache(bin.spelled, async () => {
    if (isReusableSwiftExecutable(executablePath)) {
      return executablePath;
    }
    const timeoutMs = params.timeoutMs ?? 120_000;
    await withProcessLock({
      acquire: () => acquireSwiftCacheLock(`${executablePath}.lock`, timeoutMs, params.signal),
      task: async () => {
        // Another process may have published the executable while this one waited for the lock.
        if (isReusableSwiftExecutable(entryIn(confirmSwiftCacheDirectory(bin)))) {
          return;
        }
        const tempDir = fs.mkdtempSync(
          path.join(bin.directory, `.${params.entryName}.${process.pid}.`),
        );
        const tempExecutablePath = path.join(tempDir, params.entryName);
        let failure: { error: unknown } | undefined;
        try {
          // Source text is written inside this compile's own private directory, so no name another process
          // can reach stands between the text and the compiler.
          const sourcePaths = params.sources.map(({ fileName, text }) =>
            writeSourceText(tempDir, fileName, text),
          );
          const env = swiftCompilerEnv(
            params.host.env,
            tempDir,
            await selectedDeveloperDir(params.host),
          );
          // An empty request overlay: the request's own DEVELOPER_DIR was judged above, and must not replace
          // the judged value after the fact.
          await withCommandHost(
            { host: params.host, requestEnv: {} },
            async () =>
              await runCmd(XCRUN, [...COMPILER_ARGS, ...sourcePaths, '-o', tempExecutablePath], {
                timeoutMs,
                signal: params.signal,
                kill: SWIFTC_STOP,
                env,
              }),
          );
          publishableExecutable(tempExecutablePath);
          fs.renameSync(tempExecutablePath, entryIn(confirmSwiftCacheDirectory(bin)));
        } catch (error) {
          failure = { error };
          throw error;
        } finally {
          removeStagingDirectory(tempDir, failure);
        }
      },
    });
    return executablePath;
  });
}

/**
 * Removes a compile's staging directory. When the compile already failed, that failure stays the answer: a
 * cleanup failure is attached to it as secondary detail instead of replacing it.
 */
function removeStagingDirectory(directory: string, failure: { error: unknown } | undefined): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (cleanupError) {
    if (failure === undefined) throw cleanupError;
    if (failure.error instanceof AppError) {
      failure.error.details = {
        ...failure.error.details,
        stagingCleanupError:
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      };
    }
  }
}

/**
 * Makes the compile output 0755 through a descriptor that refuses a final link: `swiftc` creates it through the
 * umask, and a group-writable result would never be reused.
 */
function publishableExecutable(filePath: string): void {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw untrustedSwiftCache(path.dirname(filePath), undefined, {
        exposure: 'not_a_regular_file',
        ancestor: filePath,
        hint: swiftCacheHint(undefined, undefined),
      });
    }
    fs.fchmodSync(descriptor, 0o755);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function acquireSwiftCacheLock(
  lockDir: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProcessLockRelease> {
  try {
    return await acquireProcessLock({
      lockDirPath: lockDir,
      owner: {
        pid: process.pid,
        startTime: readProcessStartTime(process.pid),
        acquiredAtMs: Date.now(),
      },
      timeoutMs,
      pollMs: LOCK_RETRY_DELAY_MS,
      signal,
      description: `Swift cache lock: ${lockDir} (${timeoutMs}ms)`,
    });
  } catch (error) {
    if (error instanceof AppError && error.details?.reason === 'process_lock_timeout') {
      throw new AppError('COMMAND_FAILED', error.message, {
        ...error.details,
        lockDir,
        timeoutMs,
      });
    }
    throw error;
  }
}

function writeSourceText(directory: string, fileName: string, text: string): string {
  const sourcePath = path.join(directory, fileName);
  fs.writeFileSync(sourcePath, text, { flag: 'wx', mode: 0o600 });
  return sourcePath;
}

function sanitizeCacheName(value: string): string {
  return trimEdgeDashes(value.replaceAll(/[^A-Za-z0-9._-]/g, '-')) || 'swift-helper';
}

function hashParts(parts: Array<string | number | Buffer>): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(Buffer.isBuffer(part) ? part : String(part));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
