import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createTestHost } from '../host-environment.fixtures.ts';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import { createRequestCanceledError, isRequestCanceledError } from '@agent-device/kernel/errors';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(async (_cmd: string, args: readonly string[]) => {
    const outputPath = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(outputPath, 'compiled');
    fs.chmodSync(outputPath, 0o755);
    return { stdout: '', stderr: '', exitCode: 0 };
  }),
}));

import { runCmd } from '@agent-device/host-kit/command';
import {
  buildRecordingScriptPathCandidates,
  compileSwiftSourceFile,
  compileSwiftSourceText,
  readCompiledSwiftSourceText,
} from './swift-cache.ts';

const mockRunCmd = vi.mocked(runCmd);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempForTestSync('agent-device-swift-cache-test-');
  vi.stubEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', path.join(tmpDir, 'swift-cache'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('compileSwiftSourceFile compiles to a unique temp executable before publishing cache entry', async () => {
  const sourcePath = writeSourceFile('print("hello")');

  const executablePath = await compileSwiftSourceFile({
    host: createTestHost(),
    cacheName: 'recording-helper',
    sourcePath,
  });

  const compileCall = mockRunCmd.mock.calls[0]!;
  const outputPath = compileCall[1][compileCall[1].indexOf('-o') + 1]!;

  expect(outputPath).not.toBe(executablePath);
  expect(path.dirname(outputPath)).toContain(path.join('swift-cache', 'attempts'));
  expect(path.basename(outputPath)).toBe(path.basename(executablePath));
  expect(fs.statSync(executablePath).mode & 0o111).not.toBe(0);
  expect(fs.existsSync(outputPath)).toBe(false);
});

test('refuses publication when the compiler output changes during its snapshot', async () => {
  let output = '';
  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    output = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(output, 'compiled', { mode: 0o755 });
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const read = fs.readFileSync;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((target, options) => {
    const result = read(target, options as never);
    if (typeof target === 'number' && output) fs.appendFileSync(output, 'late');
    return result;
  }) as typeof fs.readFileSync);
  try {
    await expect(
      compileSwiftSourceText({ host: createTestHost(), source: 'print(1)', cacheName: 'changing' }),
    ).rejects.toMatchObject({ details: { reason: 'swift_cache_output_changed' } });
    expect(fs.readdirSync(path.join(tmpDir, 'swift-cache', 'bin'))).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test('concurrent file-backed helper compiles for the same cache key reuse the winning executable', async () => {
  const sourcePath = writeSourceFile();

  await expectConcurrentCacheReuse(() =>
    compileSwiftSourceFile({ host: createTestHost(), sourcePath, cacheName: 'recording-overlay' }),
  );
});

test('extra source paths participate in the cache key and reach the compiler', async () => {
  const sourcePath = writeSourceFile();
  const supportPath = path.join(tmpDir, 'RecordingExportSupport.swift');
  fs.writeFileSync(supportPath, 'enum Support {}');
  const changedSupportPath = path.join(tmpDir, 'OtherSupport.swift');
  fs.writeFileSync(changedSupportPath, 'enum OtherSupport {}');

  const [withSupport, withSupportAgain, withChangedSupport] = await Promise.all([
    compileSwiftSourceFile({
      host: createTestHost(),
      sourcePath,
      extraSourcePaths: [supportPath],
      cacheName: 'recording-overlay',
    }),
    compileSwiftSourceFile({
      host: createTestHost(),
      sourcePath,
      extraSourcePaths: [supportPath],
      cacheName: 'recording-overlay',
    }),
    compileSwiftSourceFile({
      host: createTestHost(),
      sourcePath,
      extraSourcePaths: [changedSupportPath],
      cacheName: 'recording-overlay',
    }),
  ]);

  expect(withSupportAgain).toBe(withSupport);
  expect(withChangedSupport).not.toBe(withSupport);
  const compiledPaths = mockRunCmd.mock.calls.map((call) =>
    call[1].slice(2, 4).map((item) => path.basename(item)),
  );
  expect(compiledPaths).toContainEqual(['recording-overlay.swift', 'RecordingExportSupport.swift']);
  expect(compiledPaths).toContainEqual(['recording-overlay.swift', 'OtherSupport.swift']);
});

test('cache locks with a proven dead owner are recovered before compiling', async () => {
  const { sourcePath, executablePath, lockDir } = await createBlockedCacheEntry();
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({
      pid: 999_999_999,
      startTime: null,
      acquiredAtMs: Date.now(),
    }),
  );

  await expect(
    compileSwiftSourceFile({
      host: createTestHost(),
      sourcePath,
      cacheName: 'recording-overlay',
      timeoutMs: 100,
    }),
  ).resolves.toBe(executablePath);

  expect(fs.existsSync(lockDir)).toBe(false);
  expect(mockRunCmd).toHaveBeenCalledTimes(1);
});

test('an ownerless cache lock is retained with verified-recovery guidance regardless of age', async () => {
  const { sourcePath, lockDir } = await createBlockedCacheEntry();
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);

  await expect(
    compileSwiftSourceFile({
      host: createTestHost(),
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
      hint: expect.stringContaining('confirming all users of this state directory have stopped'),
    },
  });

  expect(mockRunCmd).not.toHaveBeenCalled();
  expect(fs.existsSync(lockDir)).toBe(true);
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
  await compileSwiftSourceText({
    host: createTestHost(),
    source: 'print(1)',
    cacheName: value,
  }).catch(() => {});
  const elapsedMs = Date.now() - start;

  expect(elapsedMs).toBeLessThan(1_000);
});

test('a compile timeout preserves the error and cleans unpublished output and its lock', async () => {
  const timeout = new Error('compile timed out');
  mockRunCmd.mockRejectedValueOnce(timeout);

  await expect(
    compileSwiftSourceText({
      host: createTestHost(),
      source: 'print(1)',
      cacheName: 'timed-out',
      timeoutMs: 75,
    }),
  ).rejects.toBe(timeout);
  expect(mockRunCmd.mock.calls[0]![2]).toMatchObject({
    timeoutMs: 75,
    kill: { signal: 'SIGINT', graceMs: 2_000 },
  });
  expect(fs.readdirSync(path.join(tmpDir, 'swift-cache', 'bin'))).toEqual([]);
});

test('a canceled compile kills swiftc through its signal and leaves no temp output', async () => {
  const cancel = new AbortController();
  mockRunCmd.mockImplementationOnce(
    async (_cmd, _args, options) =>
      await new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(createRequestCanceledError()));
      }),
  );

  const compiled = compileSwiftSourceText({
    host: createTestHost(),
    source: 'print(1)',
    cacheName: 'canceled',
    signal: cancel.signal,
  });
  await vi.waitFor(() => expect(mockRunCmd).toHaveBeenCalledOnce());
  cancel.abort();

  await expect(compiled).rejects.toSatisfy(isRequestCanceledError);
  expect(mockRunCmd.mock.calls[0]![2]).toMatchObject({
    signal: cancel.signal,
    kill: { signal: 'SIGINT' },
  });
  expect(fs.readdirSync(path.join(tmpDir, 'swift-cache', 'bin'))).toEqual([]);
});

test('a canceled wait on another process compile stops waiting and leaves its lock alone', async () => {
  const compile = (signal?: AbortSignal) =>
    compileSwiftSourceText({
      host: createTestHost(),
      source: 'print(1)',
      cacheName: 'held-elsewhere',
      signal,
    });
  const executablePath = await compile();
  fs.rmSync(executablePath);
  const lockDir = `${executablePath}.lock`;
  fs.mkdirSync(lockDir);
  vi.clearAllMocks();
  // The parent process stands in for another live process that holds the lock while it compiles.
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.ppid, startTime: null, acquiredAtMs: Date.now() }),
  );
  const cancel = new AbortController();

  const compiled = compile(cancel.signal);
  // Let the wait poll the held lock a few times before it is canceled.
  await new Promise((resolve) => setTimeout(resolve, 100));
  cancel.abort();

  await expect(compiled).rejects.toSatisfy(isRequestCanceledError);
  expect(mockRunCmd).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(lockDir, 'owner.json'))).toBe(true);
});

test('compileSwiftSourceText falls back to swift-helper when the cache name sanitizes to nothing', async () => {
  const executablePath = await compileSwiftSourceText({
    host: createTestHost(),
    source: 'print(1)',
    cacheName: '---',
  });

  expect(path.basename(executablePath).startsWith('swift-helper-')).toBe(true);
  expect(fs.statSync(executablePath).mode & 0o111).not.toBe(0);
});

test('a failed compile and an unverified lock release retain both errors', async () => {
  const sourcePath = writeSourceFile();
  const buildFailure = new Error('swiftc: error: build failed');
  let lockDir = '';
  mockRunCmd.mockImplementationOnce(async (_cmd: string, args: readonly string[]) => {
    const outputPath = args[args.indexOf('-o') + 1]!;
    const executablePath = path.join(tmpDir, 'swift-cache', 'bin', path.basename(outputPath));
    lockDir = `${executablePath}.lock`;
    // A record that cannot be read is a release that cannot prove ownership.
    const ownerFile = path.join(lockDir, 'owner.json');
    fs.rmSync(ownerFile);
    fs.mkdirSync(ownerFile);
    throw buildFailure;
  });

  const error = await compileSwiftSourceFile({
    host: createTestHost(),
    sourcePath,
    cacheName: 'recording-overlay',
  }).catch((error: unknown) => error);
  expect(error).toMatchObject({ details: { reason: 'swift_cache_cleanup_failed' } });
  expect((error as Error).cause).toBeInstanceOf(AggregateError);
  expect(((error as Error).cause as AggregateError).errors).toEqual([
    buildFailure,
    expect.any(Error),
  ]);
  // The release really could not verify itself: the lock is still standing.
  expect(fs.existsSync(lockDir)).toBe(true);
});

function writeSourceFile(source = 'print("recording")'): string {
  const sourcePath = path.join(tmpDir, 'recording-overlay.swift');
  fs.writeFileSync(sourcePath, source);
  return sourcePath;
}

async function createBlockedCacheEntry() {
  const sourcePath = writeSourceFile();
  const executablePath = await compileSwiftSourceFile({
    host: createTestHost(),
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
    mockRunCmd.mockImplementationOnce(async (_cmd: string, args: readonly string[]) => {
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
  const originalReadFileSync = fs.readFileSync;
  const lockAttempted = new Promise<void>((resolve) => {
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      options?: Parameters<typeof fs.readFileSync>[1],
    ) => {
      if (typeof filePath === 'string' && filePath.endsWith(`.lock${path.sep}owner.json`)) {
        resolve();
        readSpy.mockRestore();
      }
      return originalReadFileSync(filePath, options);
    }) as typeof fs.readFileSync);
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

test('recording script candidates include packaged dist apple-runner source', () => {
  const packageRoot = path.join(tmpDir, 'package');
  const scriptPath = path.join(
    packageRoot,
    'dist/apple/runner/AgentDeviceRunner/RecordingScripts/recording-overlay.swift',
  );
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, 'print("overlay")\n');

  const candidates = buildRecordingScriptPathCandidates(
    'recording-overlay.swift',
    path.join(packageRoot, 'dist/src'),
    packageRoot,
    tmpDir,
  );
  const firstExisting = candidates.find((candidate) => fs.existsSync(candidate));

  expect(firstExisting).toBe(scriptPath);
});

test('the cache root and tool environment come from the host it is given, not the process', async () => {
  const hostCacheDir = path.join(tmpDir, 'host-cache');

  const executablePath = await compileSwiftSourceText({
    host: {
      env: {
        AGENT_DEVICE_SWIFT_CACHE_DIR: hostCacheDir,
        DEVELOPER_DIR: '/host/developer',
        FROM_HOST: 'no',
      },
      cwd: tmpDir,
    },
    source: 'print("host")',
    cacheName: 'host-helper',
  });

  expect(path.dirname(executablePath)).toBe(path.join(hostCacheDir, 'bin'));
  expect(mockRunCmd.mock.calls[0]?.[2]?.env).toMatchObject({
    DEVELOPER_DIR: '/host/developer',
    HOME: expect.stringContaining(path.join(hostCacheDir, 'attempts')),
  });
  expect(mockRunCmd.mock.calls[0]?.[2]?.env).not.toHaveProperty('FROM_HOST');
});

test('reads only a published executable for the exact source and cache, without compiling', async () => {
  const input = { host: createTestHost(), source: 'print("prepared")', cacheName: 'prepared' };
  expect(readCompiledSwiftSourceText(input)).toBeUndefined();
  expect(mockRunCmd).not.toHaveBeenCalled();
  const executable = await compileSwiftSourceText(input);
  mockRunCmd.mockClear();
  expect(readCompiledSwiftSourceText(input)).toBe(executable);
  expect(readCompiledSwiftSourceText({ ...input, source: 'print("changed")' })).toBeUndefined();
  expect(
    readCompiledSwiftSourceText({
      ...input,
      host: {
        ...input.host,
        env: { AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(tmpDir, 'other-cache') },
      },
    }),
  ).toBeUndefined();
  fs.chmodSync(executable, 0o644);
  expect(readCompiledSwiftSourceText(input)).toBeUndefined();
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('a temp removal failure survives a canceled compile', async () => {
  const removalFailure = new Error('removal failed');
  const cancelFailure = createRequestCanceledError();
  mockRunCmd.mockRejectedValueOnce(cancelFailure);
  const original = fs.rmSync;
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((target, options) => {
    if (
      typeof target === 'string' &&
      path.basename(target) === 'work' &&
      target.includes(`${path.sep}attempts${path.sep}`)
    )
      throw removalFailure;
    return original(target, options);
  }) as typeof fs.rmSync);
  try {
    const error = await compileSwiftSourceText({
      host: createTestHost(),
      source: 'print(1)',
      cacheName: 'removal',
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ details: { reason: 'swift_cache_cleanup_failed' } });
    expect(((error as Error).cause as AggregateError).errors).toEqual([
      cancelFailure,
      expect.objectContaining({
        details: { reason: 'swift_cache_temp_removal_failed' },
        cause: removalFailure,
      }),
    ]);
  } finally {
    spy.mockRestore();
  }
});

test('simultaneous temp removal and lock release failures preserve all evidence', async () => {
  const compileFailure = new Error('compile failed');
  const removalFailure = new Error('temp removal failed');
  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    const output = args[args.indexOf('-o') + 1]!;
    const lock = path.join(tmpDir, 'swift-cache', 'bin', `${path.basename(output)}.lock`);
    const owner = path.join(lock, 'owner.json');
    fs.rmSync(owner);
    fs.mkdirSync(owner);
    throw compileFailure;
  });
  const original = fs.rmSync;
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((target, options) => {
    if (
      typeof target === 'string' &&
      path.basename(target) === 'work' &&
      target.includes(`${path.sep}attempts${path.sep}`)
    )
      throw removalFailure;
    return original(target, options);
  }) as typeof fs.rmSync);
  try {
    const error = await compileSwiftSourceText({
      host: createTestHost(),
      source: 'print(2)',
      cacheName: 'both',
    }).catch((error: unknown) => error);
    expect(((error as Error).cause as AggregateError).errors).toEqual([
      compileFailure,
      expect.objectContaining({
        details: { reason: 'swift_cache_temp_removal_failed' },
        cause: removalFailure,
      }),
      expect.objectContaining({
        details: { reason: 'swift_cache_lock_release_failed' },
        cause: expect.any(Error),
      }),
    ]);
  } finally {
    spy.mockRestore();
  }
});

test('successful compilation still reports failure to remove temporary output', async () => {
  const removalFailure = new Error('temp removal failed');
  const original = fs.rmSync;
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((target, options) => {
    if (
      typeof target === 'string' &&
      path.basename(target) === 'work' &&
      target.includes(`${path.sep}attempts${path.sep}`)
    )
      throw removalFailure;
    return original(target, options);
  }) as typeof fs.rmSync);
  try {
    const error = await compileSwiftSourceText({
      host: createTestHost(),
      source: 'print(3)',
      cacheName: 'successful',
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ details: { reason: 'swift_cache_cleanup_failed' } });
    expect(((error as Error).cause as AggregateError).errors).toEqual([
      expect.objectContaining({
        details: { reason: 'swift_cache_temp_removal_failed' },
        cause: removalFailure,
      }),
    ]);
  } finally {
    spy.mockRestore();
  }
});

test('an interrupted source write is repaired before a later prepare compiles it', async () => {
  const input = {
    host: createTestHost(),
    source: 'print("partial")\nprint("complete")\n',
    cacheName: 'interrupted',
  };
  const failure = new Error('interrupted source write');
  const write = fs.writeFileSync;
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((target, data, options) => {
    if (typeof target === 'string' && target.endsWith(`${path.sep}interrupted.swift`)) {
      write(target, 'print("partial")\n');
      throw failure;
    }
    return write(target, data, options);
  }) as typeof fs.writeFileSync);
  try {
    await expect(compileSwiftSourceText(input)).rejects.toBe(failure);
  } finally {
    spy.mockRestore();
  }
  expect(fs.existsSync(path.join(tmpDir, 'swift-cache', 'sources'))).toBe(false);
  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    const source = fs.readFileSync(args[2]!, 'utf8');
    const output = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(output, source);
    fs.chmodSync(output, 0o755);
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const executable = await compileSwiftSourceText(input);
  expect(fs.readFileSync(executable, 'utf8')).toBe(input.source);
});

test('a retry compiles a new private source and reuses its published executable', async () => {
  const input = { host: createTestHost(), source: 'print("complete")', cacheName: 'retry' };
  let firstSource = '';
  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    firstSource = args[2]!;
    throw new Error('compiler failed');
  });
  await expect(compileSwiftSourceText(input)).rejects.toThrow('compiler failed');
  let secondSource = '';
  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    secondSource = args[2]!;
    const output = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(output, fs.readFileSync(secondSource));
    fs.chmodSync(output, 0o755);
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const executable = await compileSwiftSourceText(input);
  expect(firstSource).not.toBe(secondSource);
  expect(fs.readFileSync(executable, 'utf8')).toBe(input.source);
  mockRunCmd.mockClear();
  expect(readCompiledSwiftSourceText(input)).toBe(executable);
  expect(await compileSwiftSourceText(input)).toBe(executable);
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('concurrent text-backed prepares reuse the winning executable', async () => {
  const input = { host: createTestHost(), source: 'print("concurrent")', cacheName: 'concurrent' };
  await expectConcurrentCacheReuse(() => compileSwiftSourceText(input));
});

test('does not reuse a potentially poisoned executable from the previous text cache identity', async () => {
  const input = { host: createTestHost(), source: 'print("canonical")', cacheName: 'legacy' };
  const hash = createHash('sha256');
  for (const part of ['3', process.platform, process.arch, input.source]) {
    hash.update(part);
    hash.update('\0');
  }
  const oldPath = path.join(
    tmpDir,
    'swift-cache',
    'bin',
    `legacy-${hash.digest('hex').slice(0, 16)}`,
  );
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.writeFileSync(oldPath, 'poisoned', { mode: 0o755 });
  expect(readCompiledSwiftSourceText(input)).toBeUndefined();
  const executable = await compileSwiftSourceText(input);
  expect(executable).not.toBe(oldPath);
  expect(mockRunCmd).toHaveBeenCalledOnce();
  expect(fs.readFileSync(oldPath, 'utf8')).toBe('poisoned');
});

test('does not reuse a file-backed executable published under the previous cache identity', async () => {
  const sourcePath = writeSourceFile('print("canonical")');
  const source = fs.readFileSync(sourcePath);
  const hash = createHash('sha256');
  for (const part of [
    '2',
    process.platform,
    process.arch,
    path.resolve(sourcePath),
    source.length,
    source,
  ]) {
    hash.update(Buffer.isBuffer(part) ? part : String(part));
    hash.update('\0');
  }
  const oldPath = path.join(
    tmpDir,
    'swift-cache',
    'bin',
    `legacy-file-${hash.digest('hex').slice(0, 16)}`,
  );
  fs.mkdirSync(path.dirname(oldPath), { recursive: true });
  fs.writeFileSync(oldPath, 'previous executable', { mode: 0o755 });
  const executable = await compileSwiftSourceFile({
    host: createTestHost(),
    sourcePath,
    cacheName: 'legacy-file',
  });
  expect(executable).not.toBe(oldPath);
  expect(mockRunCmd).toHaveBeenCalledOnce();
  expect(fs.readFileSync(executable, 'utf8')).toBe('compiled');
});
