import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimEdgeDashes } from '@agent-device/kernel/collections';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import {
  acquireProcessLock,
  confirmScriptDestination,
  expandUserHomePath,
  prepareScriptDestination,
  scriptAncestryReason,
  withProcessLock,
  type ProcessLockRelease,
  type ScriptDestination,
} from '@agent-device/host-kit/file';
const LOCK_RETRY_DELAY_MS = 25;
// swift-driver runs each frontend job in its own process group. It stops them on SIGINT, but
// SIGKILL or SIGTERM leaves them compiling with no parent.
const SWIFTC_STOP = { signal: 'SIGINT', graceMs: 2_000 } as const;
const RECORDING_SCRIPT_SUBDIRECTORY = 'apple/runner/AgentDeviceRunner/RecordingScripts';

/**
 * The layout version. Each version lives in its own directory under the cache root, so nothing an earlier
 * release compiled, or left as compiler state, is ever reused.
 */
export const SWIFT_CACHE_VERSION = '3';

export const SWIFT_CACHE_UNTRUSTED_REASON = 'swift_cache_untrusted';

/** The directories of one cache version; every one of them sits inside the private version directory. */
export type SwiftCacheDirectory = 'bin' | 'home' | 'module-cache';

const SWIFT_CACHE_OVERRIDE_HINT =
  'set AGENT_DEVICE_SWIFT_CACHE_DIR to a directory you own that only you can write. Only owner and mode bits ' +
  'are checked: ACLs on an override directory are yours to keep closed.';

/** What to do about a refusal. A group-writable directory is the one the caller can close in place. */
function swiftCacheHint(exposure: unknown, ancestor: unknown): string {
  if (exposure === 'shared_group_writable' && typeof ancestor === 'string') {
    return `Close the directory to its group with \`chmod g-w ${ancestor}\`, or ${SWIFT_CACHE_OVERRIDE_HINT}`;
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

/** A cache directory as the ancestry rule judged it, with the version directory judged first. */
export type PreparedSwiftCacheDirectory = Readonly<{
  spelled: string;
  prepared: ScriptDestination;
}>;

/**
 * Readies one directory of the current cache version. Every level from `/` down is judged by host-kit's ancestry
 * rule, and missing levels are created 0700 one at a time. The version directory is judged as a destination of
 * its own, so it is the one trust boundary: nobody else can add an entry in it, or anywhere below it.
 */
export function prepareSwiftCacheDirectory(
  env: NodeJS.ProcessEnv,
  name: SwiftCacheDirectory,
): PreparedSwiftCacheDirectory {
  const versionDir = path.join(getSwiftCacheRoot(env), `v${SWIFT_CACHE_VERSION}`);
  const spelled = path.join(versionDir, name);
  return untrustedAsSwiftCacheError(spelled, () => {
    // The rule judges the PARENT of the destination it is given; the placeholder name is never created.
    prepareScriptDestination(path.join(versionDir, 'entry'));
    return { spelled, prepared: prepareScriptDestination(path.join(spelled, 'entry')) };
  });
}

/**
 * The physical path of a prepared cache directory, after confirming it is still the directory the rule judged:
 * a directory removed and recreated since then, by anyone, is refused.
 */
export function confirmSwiftCacheDirectory(directory: PreparedSwiftCacheDirectory): string {
  return untrustedAsSwiftCacheError(directory.spelled, () =>
    confirmScriptDestination(path.join(directory.spelled, 'entry'), directory.prepared),
  );
}

/**
 * Whether the cache entry is an executable this user published: a regular file, not a link, owned by this uid and
 * writable by nobody else. Anything else is a miss, and the compile renames its own output over that name.
 */
export function isReusableSwiftExecutable(filePath: string): boolean {
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
    if (error instanceof AppError && scriptAncestryReason(error) !== undefined) {
      const { exposure, ancestor } = error.details ?? {};
      throw untrustedSwiftCache(directory, error, {
        exposure,
        ancestor,
        hint: swiftCacheHint(exposure, ancestor),
      });
    }
    // A level this user may not create or read, such as a cache root another account created first.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw untrustedSwiftCache(directory, error, {
        errno: code,
        hint: swiftCacheHint(undefined, undefined),
      });
    }
    throw error;
  }
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
    HOME: prepareSwiftCacheDirectory(env, 'home').prepared.directory,
    CLANG_MODULE_CACHE_PATH: prepareSwiftCacheDirectory(env, 'module-cache').prepared.directory,
  };
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
 * directory all sit in the judged `bin` of the private version directory, and `bin` is confirmed unchanged
 * before the reuse check and again before the rename.
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
  const executablePath = entryIn(confirmSwiftCacheDirectory(bin));
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
        path.join(path.dirname(executablePath), `.${params.entryName}.${process.pid}.`),
      );
      const tempExecutablePath = path.join(tempDir, params.entryName);
      try {
        // Source text is written inside this compile's own private directory, so no name another process can
        // reach stands between the text and the compiler.
        const sourcePaths =
          'paths' in params.source
            ? params.source.paths
            : [writeSourceText(tempDir, params.source.fileName, params.source.text)];
        await runCmd('xcrun', ['swiftc', ...sourcePaths, '-o', tempExecutablePath], {
          timeoutMs,
          signal: params.signal,
          kill: SWIFTC_STOP,
          env: buildSwiftToolEnv(params.host.env),
        });
        // `swiftc` creates its output through the umask; a group-writable result would never be reused.
        fs.chmodSync(tempExecutablePath, 0o755);
        fs.renameSync(tempExecutablePath, entryIn(confirmSwiftCacheDirectory(bin)));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  });
  return executablePath;
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
