import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../exec.ts', () => ({
  runCmd: vi.fn(async (_cmd: string, args: string[]) => {
    const outputPath = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(outputPath, 'compiled');
    fs.chmodSync(outputPath, 0o755);
    return { stdout: '', stderr: '', exitCode: 0 };
  }),
}));

import { runCmd } from '../exec.ts';
import { compileSwiftSourceFile, compileSwiftSourceText } from '../swift-cache.ts';

const mockRunCmd = vi.mocked(runCmd);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-swift-cache-test-'));
  vi.stubEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', path.join(tmpDir, 'swift-cache'));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('compileSwiftSourceFile compiles to a unique temp executable before publishing cache entry', async () => {
  const sourcePath = writeSourceFile('print("hello")');

  const executablePath = await compileSwiftSourceFile({
    cacheName: 'recording-helper',
    sourcePath,
  });

  const compileCall = mockRunCmd.mock.calls[0]!;
  const outputPath = compileCall[1][compileCall[1].indexOf('-o') + 1]!;

  expect(outputPath).not.toBe(executablePath);
  expect(path.dirname(outputPath)).toContain(path.join('swift-cache', 'bin'));
  expect(path.basename(outputPath)).toBe(path.basename(executablePath));
  expect(fs.statSync(executablePath).mode & 0o111).not.toBe(0);
  expect(fs.existsSync(outputPath)).toBe(false);
});

test('concurrent file-backed helper compiles for the same cache key reuse the winning executable', async () => {
  const sourcePath = writeSourceFile();

  await expectConcurrentCacheReuse(() =>
    compileSwiftSourceFile({
      sourcePath,
      cacheName: 'recording-overlay',
    }),
  );
});

test('stale cache locks are removed before compiling', async () => {
  const { sourcePath, executablePath, lockDir } = await createBlockedCacheEntry();
  const staleTime = new Date(Date.now() - 1_000);
  fs.utimesSync(lockDir, staleTime, staleTime);

  await expect(
    compileSwiftSourceFile({
      sourcePath,
      cacheName: 'recording-overlay',
      timeoutMs: 100,
    }),
  ).resolves.toBe(executablePath);

  expect(fs.existsSync(lockDir)).toBe(false);
  expect(mockRunCmd).toHaveBeenCalledTimes(1);
});

test('cache lock timeout reports the lock path', async () => {
  const { sourcePath, lockDir } = await createBlockedCacheEntry();
  const futureTime = new Date(Date.now() + 60_000);
  fs.utimesSync(lockDir, futureTime, futureTime);

  await expect(
    compileSwiftSourceFile({
      sourcePath,
      cacheName: 'recording-overlay',
      timeoutMs: 1,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: `Timed out waiting for Swift cache lock: ${lockDir} (1ms)`,
    details: {
      lockDir,
      timeoutMs: 1,
      hint: expect.stringContaining(`remove "${lockDir}"`),
    },
  });

  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('compileSwiftSourceText resolves a cache name with a long interior dash run in sub-second time', async () => {
  // Regression pin for the polynomial-regex ReDoS fix in `sanitizeCacheName`'s edge-dash
  // trim. The interior dashes are never touched by the trim, so a correct sanitizer never
  // needs to inspect this whole run — only a backtracking one pays for its length.
  const value = `x${'-'.repeat(100_000)}x`;

  const start = Date.now();
  // The cache name is long enough to exceed the filesystem's path-component limit, so the
  // call is expected to reject once it reaches disk I/O; that happens only *after* the
  // (now fast) sanitize step this test pins, so timing the settle either way still proves
  // no catastrophic backtracking occurred.
  await compileSwiftSourceText({ source: 'print(1)', cacheName: value }).catch(() => {});
  const elapsedMs = Date.now() - start;

  expect(elapsedMs).toBeLessThan(1_000);
});

test('compileSwiftSourceText falls back to swift-helper when the cache name sanitizes to nothing', async () => {
  const executablePath = await compileSwiftSourceText({
    source: 'print(1)',
    cacheName: '---',
  });

  expect(path.basename(executablePath).startsWith('swift-helper-')).toBe(true);
  expect(fs.statSync(executablePath).mode & 0o111).not.toBe(0);
});

function writeSourceFile(source = 'print("recording")'): string {
  const sourcePath = path.join(tmpDir, 'recording-overlay.swift');
  fs.writeFileSync(sourcePath, source);
  return sourcePath;
}

async function createBlockedCacheEntry() {
  const sourcePath = writeSourceFile();
  const executablePath = await compileSwiftSourceFile({
    sourcePath,
    cacheName: 'recording-overlay',
  });
  const lockDir = `${executablePath}.lock`;
  fs.rmSync(executablePath);
  fs.mkdirSync(lockDir);
  vi.clearAllMocks();
  return { executablePath, lockDir, sourcePath };
}

async function expectConcurrentCacheReuse(compile: () => Promise<string>): Promise<void> {
  let releaseCompile: () => void = () => {};
  const compileStarted = new Promise<void>((resolve) => {
    mockRunCmd.mockImplementationOnce(async (_cmd: string, args: string[]) => {
      resolve();
      await new Promise<void>((release) => {
        releaseCompile = release;
      });
      const outputPath = args[args.indexOf('-o') + 1]!;
      fs.writeFileSync(outputPath, 'compiled once');
      fs.chmodSync(outputPath, 0o755);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
  });

  const firstCompile = compile();
  await compileStarted;
  const originalMkdirSync = fs.mkdirSync;
  const lockAttempted = new Promise<void>((resolve) => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation((dirPath, options) => {
      if (typeof dirPath === 'string' && dirPath.endsWith('.lock')) {
        resolve();
        mkdirSpy.mockRestore();
      }
      return originalMkdirSync(dirPath, options);
    });
  });
  const secondCompile = compile();

  await lockAttempted;
  expect(mockRunCmd).toHaveBeenCalledTimes(1);

  releaseCompile();
  const [firstExecutable, secondExecutable] = await Promise.all([firstCompile, secondCompile]);

  expect(secondExecutable).toBe(firstExecutable);
  expect(fs.readFileSync(firstExecutable, 'utf8')).toBe('compiled once');
  expect(mockRunCmd).toHaveBeenCalledTimes(1);
}
