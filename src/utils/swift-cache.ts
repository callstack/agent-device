import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from './exec.ts';
import { acquireProcessLock } from './process-lock.ts';
import { readProcessStartTime } from './host-process.ts';

const SWIFT_CACHE_VERSION = '2';
const LOCK_RETRY_DELAY_MS = 25;

export function buildSwiftToolEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const root = getSwiftCacheRoot();
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
  const executablePath = path.join(getSwiftCacheRoot(), 'bin', `${cacheName}-${key}`);
  await ensureSwiftExecutable({
    sourcePaths,
    executablePath,
    timeoutMs: params.timeoutMs,
  });
  return executablePath;
}

export async function compileSwiftSourceText(params: {
  source: string;
  cacheName: string;
  timeoutMs?: number;
}): Promise<string> {
  const cacheName = sanitizeCacheName(params.cacheName);
  const key = hashParts([SWIFT_CACHE_VERSION, process.platform, process.arch, params.source]);
  const sourcePath = path.join(getSwiftCacheRoot(), 'sources', `${cacheName}-${key}.swift`);
  const executablePath = path.join(getSwiftCacheRoot(), 'bin', `${cacheName}-${key}`);

  await ensureSwiftExecutable({
    sourcePaths: [sourcePath],
    executablePath,
    sourceText: params.source,
    timeoutMs: params.timeoutMs,
  });
  return executablePath;
}

function getSwiftCacheRoot(): string {
  const configured = process.env.AGENT_DEVICE_SWIFT_CACHE_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.tmpdir(), 'agent-device-swift-cache');
}

async function ensureSwiftExecutable(params: {
  sourcePaths: string[];
  executablePath: string;
  sourceText?: string;
  timeoutMs?: number;
}): Promise<void> {
  if (isExecutableFile(params.executablePath)) {
    return;
  }

  const executableDir = path.dirname(params.executablePath);
  fs.mkdirSync(executableDir, { recursive: true });
  const lockDir = `${params.executablePath}.lock`;
  const releaseLock = await acquireSwiftCacheLock(
    lockDir,
    params.executablePath,
    params.timeoutMs ?? 120_000,
  );
  if (!releaseLock) {
    return;
  }

  const tempDir = fs.mkdtempSync(
    path.join(executableDir, `.${path.basename(params.executablePath)}.${process.pid}.`),
  );
  const tempExecutablePath = path.join(tempDir, path.basename(params.executablePath));
  try {
    if (isExecutableFile(params.executablePath)) {
      return;
    }
    const [primarySourcePath] = params.sourcePaths;
    if (params.sourceText !== undefined && primarySourcePath && !fs.existsSync(primarySourcePath)) {
      fs.mkdirSync(path.dirname(primarySourcePath), { recursive: true });
      fs.writeFileSync(primarySourcePath, params.sourceText);
    }
    await runCmd('xcrun', ['swiftc', ...params.sourcePaths, '-o', tempExecutablePath], {
      timeoutMs: params.timeoutMs ?? 120_000,
      env: buildSwiftToolEnv(),
    });
    fs.renameSync(tempExecutablePath, params.executablePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    await releaseLock();
  }
}

async function acquireSwiftCacheLock(
  lockDir: string,
  executablePath: string,
  timeoutMs: number,
): Promise<(() => Promise<void>) | null> {
  if (isExecutableFile(executablePath)) {
    return null;
  }
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
      ownerGraceMs: timeoutMs,
      description: `Swift cache lock: ${lockDir} (${timeoutMs}ms)`,
    });
  } catch (error) {
    if (
      error instanceof AppError &&
      error.message.startsWith('Timed out waiting for Swift cache lock:')
    ) {
      throw new AppError('COMMAND_FAILED', error.message, {
        ...error.details,
        lockDir,
        timeoutMs,
        hint: `Another agent-device process may still be compiling this Swift helper. Retry shortly; if no agent-device process is active, remove "${lockDir}" and retry.`,
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

/**
 * Linear-time edge trim. The regex form (`/^-+|-+$/g`) backtracks
 * polynomially on long dash runs (CodeQL js/polynomial-redos), and cache
 * names are derived from caller-supplied strings.
 */
function trimEdgeDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

function hashParts(parts: Array<string | number | Buffer>): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(Buffer.isBuffer(part) ? part : String(part));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
