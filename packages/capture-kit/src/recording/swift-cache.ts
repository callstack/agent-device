import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { trimEdgeDashes } from '@agent-device/kernel/collections';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import type { Deadline } from '@agent-device/host-kit/retry';
import { runCmd } from '@agent-device/host-kit/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import {
  createSwiftAttempt,
  getSwiftCacheRoot,
  releaseSwiftAttempt,
  withSwiftAttempt,
} from './swift-attempt.ts';
export { getSwiftCacheRoot } from './swift-attempt.ts';

import { acquireProcessLock, type ProcessLockRelease } from '@agent-device/host-kit/file';

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
  signal?: AbortSignal;
  deadline?: Deadline;
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
    signal: params.signal,
    deadline: params.deadline,
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

async function ensureSwiftExecutable(params: {
  host: HostEnvironment;
  sources: Array<{ name: string; contents: string | Buffer }>;
  executablePath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  deadline?: Deadline;
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
        await snapshotSwiftExecutable(
          tempExecutablePath,
          params.executablePath,
          attempt,
          params.signal,
          params.deadline,
        );
      } finally {
        try {
          releaseSwiftAttempt(attempt);
        } catch (error) {
          cleanupFailures.push(
            new AppError(
              'COMMAND_FAILED',
              'Swift attempt sealing failed',
              {
                reason: 'swift_cache_temp_removal_failed',
                attemptId: path.basename(attempt.directory),
                code: (error as NodeJS.ErrnoException)?.code,
              },
              error,
            ),
          );
        }
      }
    })();
  } catch (error) {
    taskFailed = true;
    taskFailure =
      params.signal?.aborted && !isRequestCanceledError(error)
        ? createRequestCanceledError(undefined, error)
        : error;
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
    if (params.signal?.aborted || isRequestCanceledError(taskFailure)) {
      const details = taskFailure instanceof AppError ? taskFailure.details : undefined;
      const previous = Array.isArray(details?.cleanupFailures) ? details.cleanupFailures : [];
      throw createRequestCanceledError(
        {
          ...details,
          cleanupFailures: [
            ...previous,
            ...cleanupFailures.map((failure) =>
              failure instanceof AppError
                ? failure.details
                : { reason: 'swift_cache_cleanup_failed' },
            ),
          ],
        },
        new AggregateError(taskFailed ? [taskFailure, ...cleanupFailures] : cleanupFailures),
      );
    }
    throw new AppError(
      'COMMAND_FAILED',
      'Swift cache cleanup failed',
      { reason: 'swift_cache_cleanup_failed' },
      new AggregateError(taskFailed ? [taskFailure, ...cleanupFailures] : cleanupFailures),
    );
  }
  if (taskFailed) throw taskFailure;
}

async function snapshotSwiftExecutable(
  source: string,
  destination: string,
  attempt: ReturnType<typeof createSwiftAttempt>,
  signal?: AbortSignal,
  deadline?: Deadline,
): Promise<void> {
  const proofFd = fs.openSync(source, 'r');
  let inputFd: number | undefined;
  let outputFd: number | undefined;
  try {
    const before = fs.fstatSync(proofFd, { bigint: true });
    if (!before.isFile() || before.size === 0n || !(before.mode & 0o111n)) {
      throw new AppError('COMMAND_FAILED', 'Swift compiler did not produce an executable');
    }
    inputFd = fs.openSync(source, 'r');
    const opened = fs.fstatSync(inputFd, { bigint: true });
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new AppError('COMMAND_FAILED', 'Swift compiler output changed while being copied', {
        reason: 'swift_cache_output_changed',
      });
    }
    const snapshot = path.join(attempt.directory, 'executable-snapshot');
    outputFd = fs.openSync(snapshot, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
    const snapshotStat = fs.fstatSync(outputFd, { bigint: true });
    const snapshotIdentity = attempt.record.executableSnapshot;
    if (
      !snapshotIdentity ||
      !snapshotStat.isFile() ||
      snapshotStat.size !== 0n ||
      String(snapshotStat.dev) !== snapshotIdentity.device ||
      String(snapshotStat.ino) !== snapshotIdentity.inode
    )
      throw new AppError('COMMAND_FAILED', 'Invalid Swift executable snapshot');
    fs.fchmodSync(outputFd, Number(before.mode & 0o777n));
    const reader = fs.createReadStream(source, { fd: inputFd, autoClose: true });
    inputFd = undefined;
    let writer: fs.WriteStream;
    try {
      writer = fs.createWriteStream(snapshot, { fd: outputFd, autoClose: true });
    } catch (error) {
      reader.destroy();
      await finished(reader).catch(() => {});
      throw error;
    }
    outputFd = undefined;
    await pipeline(reader, writer, { signal });
    const after = fs.fstatSync(proofFd, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(reader.bytesRead) !== after.size ||
      BigInt(writer.bytesWritten) !== after.size
    ) {
      throw new AppError('COMMAND_FAILED', 'Swift compiler output changed while being copied', {
        reason: 'swift_cache_output_changed',
      });
    }
    if (signal?.aborted) throw createRequestCanceledError();
    if (deadline?.isExpired())
      throw new AppError('COMMAND_FAILED', 'Swift compilation deadline expired', {
        reason: 'swift_cache_deadline_expired',
      });
    await fs.promises.rename(snapshot, destination);
  } finally {
    if (outputFd !== undefined) fs.closeSync(outputFd);
    if (inputFd !== undefined) fs.closeSync(inputFd);
    fs.closeSync(proofFd);
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
