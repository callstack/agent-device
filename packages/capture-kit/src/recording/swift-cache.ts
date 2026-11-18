import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimEdgeDashes } from '@agent-device/kernel/collections';
import { AppError } from '@agent-device/kernel/errors';
import { commandDeveloperDir, runCmd, withCommandHost } from '@agent-device/host-kit/command';
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
// Inherited overrides that would choose another loader, SDK, toolchain, search path or driver tool; the helpers
// build against the macOS SDK named on the command line. Trace and diagnostic settings stay.
const COMPILER_ENV_OVERRIDES =
  /^(DYLD_.*|SDKROOT|TOOLCHAINS|DEVELOPER_DIR|CPATH|C_INCLUDE_PATH|OBJC_INCLUDE_PATH|CPLUS_INCLUDE_PATH|OBJCPLUS_INCLUDE_PATH|LIBRARY_PATH|SWIFT_DRIVER_SWIFT_FRONTEND_EXEC|SWIFT_DRIVER_CLANG_EXEC|ADDITIONAL_SWIFT_DRIVER_FLAGS|SWIFT_OVERLOAD_PREBUILT_MODULE_CACHE_PATH)$/;
// Without an explicit SDK, xcrun adds /usr/local/include and /usr/local/lib to the search paths, which another
// account may own on a shared Mac.
const COMPILER_ARGS = ['--sdk', 'macosx', 'swiftc'] as const;
// The admin group on macOS, which may write /Applications itself on a stock install.
const MACOS_ADMIN_GID = 80;
const RECORDING_SCRIPT_SUBDIRECTORY = 'apple/runner/AgentDeviceRunner/RecordingScripts';

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
  // The walk judges and creates the PARENT of the name it is given; the version directory is never resolved by it.
  const { directory: root } = prepareScriptDestination(path.join(cacheRoot, versionName));
  for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
    const stats = fs.lstatSync(ancestor);
    if (!stats.isDirectory() || stats.mode & 0o022) {
      const exposure = !stats.isDirectory()
        ? 'not_a_directory'
        : stats.mode & 0o002
          ? 'world_writable'
          : 'shared_group_writable';
      throw untrustedSwiftCache(cacheRoot, undefined, {
        exposure,
        ancestor,
        hint: swiftCacheHint(exposure, ancestor),
      });
    }
    if (ancestor === path.dirname(ancestor)) break;
  }
  const versionDirectory = path.join(root, versionName);
  createPrivateDirectory(versionDirectory);
  judgeOwnedDirectory(versionDirectory);
  return versionDirectory;
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
 * Where a recording helper script can live, in the order a checkout, a source build, and a
 * published package each answer from.
 */
export function buildRecordingScriptPathCandidates(
  scriptName: string,
  moduleDir: string,
  projectRoot: string,
  cwd: string,
): string[] {
  const sourceScriptPath = `${RECORDING_SCRIPT_SUBDIRECTORY}/${scriptName}`;
  const packagedScriptPath = `dist/${sourceScriptPath}`;
  return [
    path.resolve(moduleDir, scriptName),
    path.resolve(projectRoot, sourceScriptPath),
    path.resolve(moduleDir, `../${sourceScriptPath}`),
    path.resolve(moduleDir, `../../${sourceScriptPath}`),
    path.resolve(moduleDir, `../../../${sourceScriptPath}`),
    path.resolve(projectRoot, packagedScriptPath),
    path.resolve(cwd, sourceScriptPath),
  ];
}

/**
 * Resolves one recording helper script: checkout, built package, or working-directory fallback.
 * The caller names the project root it trusts, so this module stays free of host metadata lookup;
 * the working directory defaults to the command host's.
 */
export function resolveRecordingScriptPath(
  scriptName: string,
  projectRoot: string,
  cwd: string,
  moduleDir = path.dirname(fileURLToPath(import.meta.url)),
): string {
  const scriptCandidates = buildRecordingScriptPathCandidates(
    scriptName,
    moduleDir,
    projectRoot,
    cwd,
  );
  for (const candidate of scriptCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new AppError('COMMAND_FAILED', `Missing recording helper script: ${scriptName}`, {
    hint: `Ensure ${RECORDING_SCRIPT_SUBDIRECTORY} is present in this checkout or bundled under dist/${RECORDING_SCRIPT_SUBDIRECTORY} in the package.`,
    scriptName,
    searchedPaths: scriptCandidates,
  });
}

/** The environment `swiftc` and the compiled helpers run with: their home and module cache are the cache's own. */
export function buildSwiftToolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    HOME: prepareSwiftCacheDirectory(env, 'home').directory,
    CLANG_MODULE_CACHE_PATH: prepareSwiftCacheDirectory(env, 'module-cache').directory,
  };
}

/**
 * The environment the compiler runs with: the cache's own home and module cache, a fixed PATH, no inherited
 * loader, SDK, toolchain, search-path or driver override, and this compile's private staging directory as every
 * temp directory, so no intermediate lands where another user could replace it mid-build. The toolchain is the
 * effective selection, resolved and judged here, and passed on exactly as judged.
 */
function swiftCompilerEnv(
  env: NodeJS.ProcessEnv,
  stagingDirectory: string,
  developerDir: string | undefined,
): NodeJS.ProcessEnv {
  const inherited = Object.entries(buildSwiftToolEnv(env)).filter(
    ([name]) => !COMPILER_ENV_OVERRIDES.test(name),
  );
  return {
    ...Object.fromEntries(inherited),
    ...(developerDir === undefined ? {} : { DEVELOPER_DIR: trustedDeveloperDir(developerDir) }),
    PATH: COMPILER_PATH,
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
  const resolved = path.isAbsolute(selection)
    ? realpathIfPresent(effectiveDeveloperDir(selection))
    : undefined;
  const ancestor = resolved === undefined ? selection : untrustedDeveloperDirLevel(resolved);
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

/** The first level, from the resolved directory up, that another user could change, or `undefined`. */
function untrustedDeveloperDirLevel(resolved: string): string | undefined {
  for (let level = resolved; ; level = path.dirname(level)) {
    const stats = fs.lstatSync(level);
    const owned = stats.uid === 0 || stats.uid === process.getuid?.();
    const stockApplications =
      level === '/Applications' && stats.uid === 0 && stats.gid === MACOS_ADMIN_GID;
    const writableMask = stockApplications ? 0o002 : 0o022;
    if (!stats.isDirectory() || !owned || stats.mode & writableMask) return level;
    if (level === path.dirname(level)) return undefined;
  }
}

export async function compileSwiftSourceFile(params: {
  host: HostEnvironment;
  sourcePath: string;
  /** Additional compilation units (shared helpers) compiled into the same executable. */
  extraSourcePaths?: string[];
  cacheName?: string;
  timeoutMs?: number;
}): Promise<string> {
  const sourcePaths = [params.sourcePath, ...(params.extraSourcePaths ?? [])];
  const sources = sourcePaths.map((sourcePath) => ({
    sourcePath,
    stat: fs.statSync(sourcePath),
    source: fs.readFileSync(sourcePath),
  }));
  const cacheName = sanitizeCacheName(
    params.cacheName ?? path.basename(params.sourcePath, path.extname(params.sourcePath)),
  );
  const key = hashParts([
    SWIFT_CACHE_VERSION,
    process.platform,
    process.arch,
    ...sources.flatMap(({ sourcePath, stat, source }) => [
      path.resolve(sourcePath),
      stat.size,
      source,
    ]),
  ]);
  return await ensureSwiftExecutable({
    host: params.host,
    source: { paths: sourcePaths },
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
  const key = hashParts([SWIFT_CACHE_VERSION, process.platform, process.arch, params.source]);
  return await ensureSwiftExecutable({
    host: params.host,
    source: { text: params.source, fileName: `${cacheName}-${key}.swift` },
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
  source: Readonly<{ paths: string[] }> | Readonly<{ text: string; fileName: string }>;
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
          const sourcePaths =
            'paths' in params.source
              ? params.source.paths
              : [writeSourceText(tempDir, params.source.fileName, params.source.text)];
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
  fs.writeFileSync(sourcePath, text, { flag: 'wx' });
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
