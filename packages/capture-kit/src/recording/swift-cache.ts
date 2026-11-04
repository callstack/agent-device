import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimEdgeDashes } from '@agent-device/kernel/collections';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd, withRestrictedCommandEnvironment } from '@agent-device/host-kit/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import {
  acquireProcessLock,
  publishFileSync,
  type ProcessLockRelease,
} from '@agent-device/host-kit/file';

const SWIFT_CACHE_VERSION = '3';
const SWIFT_SOURCE_TEXT_CACHE_VERSION = '4';
const LOCK_RETRY_DELAY_MS = 25;
// swift-driver runs each frontend job in its own process group. It stops them on SIGINT, but
// SIGKILL or SIGTERM leaves them compiling with no parent.
const SWIFTC_STOP = { signal: 'SIGINT', graceMs: 2_000 } as const;
const RECORDING_SCRIPT_SUBDIRECTORY = 'apple/runner/AgentDeviceRunner/RecordingScripts';

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

export function buildSwiftToolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const root = getSwiftCacheRoot(env);
  const homePath = path.join(root, 'home');
  const moduleCachePath = path.join(root, 'module-cache');
  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(moduleCachePath, { recursive: true });
  return {
    ...env,
    HOME: homePath,
    CLANG_MODULE_CACHE_PATH: moduleCachePath,
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
  const executablePath = path.join(
    getSwiftCacheRoot(params.host.env),
    'bin',
    `${cacheName}-${key}`,
  );
  await ensureSwiftExecutable({
    host: params.host,
    sources: sources.map(({ sourcePath, source }) => ({
      name: path.basename(sourcePath),
      contents: source,
    })),
    executablePath,
    timeoutMs: params.timeoutMs,
  });
  return executablePath;
}

type SwiftSourceTextInput = Readonly<{
  host: HostEnvironment;
  source: string;
  cacheName: string;
}>;

function swiftSourceTextPaths(params: SwiftSourceTextInput) {
  const cacheName = sanitizeCacheName(params.cacheName);
  const key = hashParts([
    SWIFT_SOURCE_TEXT_CACHE_VERSION,
    process.platform,
    process.arch,
    params.source,
  ]);
  const cacheRoot = getSwiftCacheRoot(params.host.env);
  const executablePath = path.join(cacheRoot, 'bin', `${cacheName}-${key}`);

  return { executablePath };
}

/** Reads an already published executable without acquiring a lock or starting a compiler. */
export function readCompiledSwiftSourceText(params: SwiftSourceTextInput): string | undefined {
  const { executablePath } = swiftSourceTextPaths(params);
  return isExecutableFile(executablePath) ? executablePath : undefined;
}

export async function compileSwiftSourceText(
  params: SwiftSourceTextInput & {
    timeoutMs?: number;
    /** Cancels the compile: kills `swiftc`, or stops waiting for another process's compile. */
    signal?: AbortSignal;
  },
): Promise<string> {
  const { executablePath } = swiftSourceTextPaths(params);

  await ensureSwiftExecutable({
    host: params.host,
    sources: [{ name: `${sanitizeCacheName(params.cacheName)}.swift`, contents: params.source }],
    executablePath,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });
  return executablePath;
}

/** The directory compiled helpers land in for `env`: what a cached helper path is valid for. */
export function getSwiftCacheRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.AGENT_DEVICE_SWIFT_CACHE_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.tmpdir(), 'agent-device-swift-cache');
}

/** Creates a unique cache-owned work area. Its record remains until its owner can prove cleanup. */
export function createSwiftAttempt(
  env: NodeJS.ProcessEnv,
  kind: 'compiler' | 'overlay' | 'validator',
) {
  const attempts = path.join(getSwiftCacheRoot(env), 'attempts');
  fs.mkdirSync(attempts, { recursive: true });
  const directory = fs.mkdtempSync(path.join(attempts, `${kind}-`));
  const work = path.join(directory, 'work');
  fs.mkdirSync(work);
  const home = path.join(work, 'home');
  const tmp = path.join(work, 'tmp');
  const moduleCache = path.join(work, 'module-cache');
  const xdgCache = path.join(work, 'xdg-cache');
  for (const dir of [home, tmp, moduleCache, xdgCache]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(directory, 'pending.json'), JSON.stringify({ version: 1, kind }), {
    flag: 'wx',
  });
  const toolEnv: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'DEVELOPER_DIR',
    'SDKROOT',
    'TOOLCHAINS',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
  ]) {
    if (env[key] !== undefined) toolEnv[key] = env[key];
  }
  Object.assign(toolEnv, {
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    CLANG_MODULE_CACHE_PATH: moduleCache,
    SWIFT_MODULECACHE_PATH: moduleCache,
  });
  return { directory, work, env: toolEnv };
}

/** Prevents a request environment from replacing an attempt's private writable paths. */
export async function withSwiftAttempt<T>(
  attempt: ReturnType<typeof createSwiftAttempt>,
  run: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  return await withRestrictedCommandEnvironment({ cwd: attempt.work, env: attempt.env }, run);
}

async function ensureSwiftExecutable(params: {
  host: HostEnvironment;
  sources: Array<{ name: string; contents: string | Buffer }>;
  executablePath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  if (isExecutableFile(params.executablePath)) {
    return;
  }

  const executableDir = path.dirname(params.executablePath);
  fs.mkdirSync(executableDir, { recursive: true });
  const timeoutMs = params.timeoutMs ?? 120_000;
  const release = await acquireSwiftCacheLock(
    `${params.executablePath}.lock`,
    timeoutMs,
    params.signal,
  );
  const cleanupFailures: unknown[] = [];
  let taskFailure: unknown;
  let taskFailed = false;
  try {
    await (async () => {
      // Another process may have published the executable while this one waited for the lock.
      if (isExecutableFile(params.executablePath)) {
        return;
      }
      const attempt = createSwiftAttempt(params.host.env, 'compiler');
      const tempExecutablePath = path.join(attempt.work, path.basename(params.executablePath));
      try {
        const sourcePaths = params.sources.map((source, index) => {
          const sourceDir = path.join(attempt.work, 'sources', String(index));
          fs.mkdirSync(sourceDir, { recursive: true });
          const sourcePath = path.join(sourceDir, source.name);
          fs.writeFileSync(sourcePath, source.contents);
          return sourcePath;
        });
        await withSwiftAttempt(attempt, (env) =>
          runCmd(
            'xcrun',
            [
              '--no-cache',
              'swiftc',
              ...sourcePaths,
              '-module-cache-path',
              path.join(attempt.work, 'module-cache'),
              '-sdk-module-cache-path',
              path.join(attempt.work, 'module-cache'),
              '-Xcc',
              `-fmodules-cache-path=${path.join(attempt.work, 'module-cache')}`,
              '-o',
              tempExecutablePath,
            ],
            {
              cwd: attempt.work,
              timeoutMs,
              signal: params.signal,
              kill: SWIFTC_STOP,
              env,
            },
          ),
        );
        const snapshot = snapshotSwiftExecutable(tempExecutablePath);
        publishFileSync({
          destination: params.executablePath,
          contents: snapshot.contents,
          mode: snapshot.mode,
        });
      } finally {
        try {
          fs.rmSync(attempt.work, { recursive: true, force: true });
        } catch (error) {
          cleanupFailures.push(
            new AppError(
              'COMMAND_FAILED',
              'Swift temporary output removal failed',
              { reason: 'swift_cache_temp_removal_failed' },
              error,
            ),
          );
        }
      }
    })();
  } catch (error) {
    taskFailed = true;
    taskFailure = error;
  }
  try {
    await release();
  } catch (error) {
    cleanupFailures.push(
      new AppError(
        'COMMAND_FAILED',
        'Swift cache lock release failed',
        { reason: 'swift_cache_lock_release_failed' },
        error,
      ),
    );
  }
  if (cleanupFailures.length) {
    throw new AppError(
      'COMMAND_FAILED',
      'Swift cache cleanup failed',
      { reason: 'swift_cache_cleanup_failed' },
      new AggregateError(taskFailed ? [taskFailure, ...cleanupFailures] : cleanupFailures),
    );
  }
  if (taskFailed) throw taskFailure;
}

function snapshotSwiftExecutable(source: string): { contents: Buffer; mode: number } {
  const fd = fs.openSync(source, 'r');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size === 0n || !(before.mode & 0o111n)) {
      throw new AppError('COMMAND_FAILED', 'Swift compiler did not produce an executable');
    }
    const contents = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(contents.length) !== after.size
    ) {
      throw new AppError('COMMAND_FAILED', 'Swift compiler output changed while being copied', {
        reason: 'swift_cache_output_changed',
      });
    }
    return { contents, mode: Number(after.mode & 0o777n) };
  } finally {
    fs.closeSync(fd);
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

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
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
