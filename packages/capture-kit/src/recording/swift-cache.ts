import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimEdgeDashes } from '@agent-device/kernel/collections';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import {
  acquireProcessLock,
  prepareScriptDestination,
  scriptAncestryReason,
  withProcessLock,
  type ProcessLockRelease,
} from '@agent-device/host-kit/file';

const SWIFT_CACHE_VERSION = '2';
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
  prepareSwiftCacheDirectory(homePath);
  prepareSwiftCacheDirectory(moduleCachePath);
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
    source: { paths: sourcePaths },
    executablePath,
    timeoutMs: params.timeoutMs,
  });
  return executablePath;
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
  const executablePath = path.join(
    getSwiftCacheRoot(params.host.env),
    'bin',
    `${cacheName}-${key}`,
  );

  await ensureSwiftExecutable({
    host: params.host,
    source: { text: params.source, fileName: `${cacheName}-${key}.swift` },
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

/**
 * Readies one directory of the Swift cache. Every level from `/` down is judged by host-kit's ancestry rule, and
 * missing levels are created private one at a time, so the directory and everything above it is ground only this
 * user (or root) can change. That is what lets a cached executable be reused and run without a later swap.
 */
function prepareSwiftCacheDirectory(directory: string): void {
  try {
    // The rule judges the PARENT of the destination it is given; the placeholder name is never created.
    prepareScriptDestination(path.join(directory, 'entry'));
  } catch (error) {
    if (scriptAncestryReason(error) === undefined) throw error;
    const details = (error as AppError).details;
    throw new AppError(
      'COMMAND_FAILED',
      `Refusing to use the Swift helper cache directory ${directory}: another local user could change ${String(details?.ancestor)}.`,
      {
        reason: 'swift_cache_untrusted',
        exposure: details?.exposure,
        ancestor: details?.ancestor,
        directory,
        hint: 'Set AGENT_DEVICE_SWIFT_CACHE_DIR to a directory you own that only you can write.',
      },
      error,
    );
  }
}

async function ensureSwiftExecutable(params: {
  host: HostEnvironment;
  source: Readonly<{ paths: string[] }> | Readonly<{ text: string; fileName: string }>;
  executablePath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const executableDir = path.dirname(params.executablePath);
  prepareSwiftCacheDirectory(executableDir);
  if (isReusableExecutable(params.executablePath)) {
    return;
  }

  const timeoutMs = params.timeoutMs ?? 120_000;
  await withProcessLock({
    acquire: () => acquireSwiftCacheLock(`${params.executablePath}.lock`, timeoutMs, params.signal),
    task: async () => {
      // Another process may have published the executable while this one waited for the lock.
      if (isReusableExecutable(params.executablePath)) {
        return;
      }
      const tempDir = fs.mkdtempSync(
        path.join(executableDir, `.${path.basename(params.executablePath)}.${process.pid}.`),
      );
      const tempExecutablePath = path.join(tempDir, path.basename(params.executablePath));
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
        fs.renameSync(tempExecutablePath, params.executablePath);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  });
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

/**
 * Whether the cache entry is an executable this user published: a regular file, not a link, owned by this uid and
 * writable by nobody else. Anything else is a miss, and the compile renames its own output over that name.
 */
function isReusableExecutable(filePath: string): boolean {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  return (
    stats !== undefined &&
    stats.isFile() &&
    stats.uid === process.getuid?.() &&
    (stats.mode & 0o022) === 0 &&
    (stats.mode & 0o100) !== 0
  );
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
