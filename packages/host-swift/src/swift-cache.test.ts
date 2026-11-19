import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createTestHost } from './host-environment.fixtures.ts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempUnsharedForTestSync } from './unshared-tmp-dir.fixtures.ts';
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
import { compileSwiftSources } from './swift-cache.ts';

const mockRunCmd = vi.mocked(runCmd);

let tmpDir = '';

beforeEach((context) => {
  tmpDir = mkdtempUnsharedForTestSync('agent-device-swift-cache-test-', context);
  vi.stubEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', path.join(tmpDir, 'swift-cache'));
  vi.clearAllMocks();
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

test('compileSwiftSources compiles to a unique temp executable before publishing cache entry', async () => {
  const executablePath = await compileSwiftSources({
    host: createTestHost(),
    cacheName: 'recording-helper',
    sources: [embedded('print("hello")')],
  });

  const compileCall = mockRunCmd.mock.calls[0]!;
  const outputPath = compileCall[1][compileCall[1].indexOf('-o') + 1]!;

  expect(outputPath).not.toBe(executablePath);
  expect(path.dirname(outputPath)).toContain(path.join('swift-cache', 'v3', 'bin'));
  expect(path.basename(outputPath)).toBe(path.basename(executablePath));
  expect(fs.statSync(executablePath).mode & 0o111).not.toBe(0);
  expect(fs.existsSync(outputPath)).toBe(false);
});

test('concurrent embedded-source helper compiles for the same cache key reuse the winning executable', async () => {
  await expectConcurrentCacheReuse(() =>
    compileSwiftSources({
      host: createTestHost(),
      sources: [embedded()],
      cacheName: 'recording-overlay',
    }),
  );
});

test('every embedded source participates in the cache key and reaches the compiler, staged in order', async () => {
  const support = embedded('enum Support {}', 'RecordingExportSupport.swift');
  // Same file name, different bytes: the key follows what is compiled, not what it is called.
  const changedSupport = embedded('enum OtherSupport {}', 'RecordingExportSupport.swift');
  const compile = (sources: { fileName: string; text: string }[]) =>
    compileSwiftSources({ host: createTestHost(), sources, cacheName: 'recording-overlay' });

  const [withSupport, withSupportAgain, withChangedSupport] = await Promise.all([
    compile([embedded(), support]),
    compile([embedded(), support]),
    compile([embedded(), changedSupport]),
  ]);

  expect(withSupportAgain).toBe(withSupport);
  expect(withChangedSupport).not.toBe(withSupport);
  const staged = mockRunCmd.mock.calls.map(([, args]) => {
    const sourcePaths = args.filter((arg) => arg.endsWith('.swift'));
    // Each staged source sits in that compile's private staging directory, beside its output.
    expect(
      sourcePaths.every(
        (sourcePath) => path.dirname(sourcePath) === path.dirname(args[args.indexOf('-o') + 1]!),
      ),
    ).toBe(true);
    return sourcePaths.map((sourcePath) => path.basename(sourcePath));
  });
  expect(staged).toContainEqual(['recording-overlay.swift', 'RecordingExportSupport.swift']);
});

test('staged sources are written owner-only, whatever the umask', async () => {
  const previousUmask = process.umask(0o022);
  const modes: number[] = [];
  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    for (const sourcePath of args.filter((arg) => arg.endsWith('.swift'))) {
      modes.push(fs.statSync(sourcePath).mode & 0o777);
    }
    fs.writeFileSync(args[args.indexOf('-o') + 1]!, 'compiled');
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  try {
    await compileSwiftSources({
      host: createTestHost(),
      sources: [embedded()],
      cacheName: 'recording-overlay',
    });
  } finally {
    process.umask(previousUmask);
  }

  expect(modes).toEqual([0o600]);
});

test('cache locks with a proven dead owner are recovered before compiling', async () => {
  const { sources, executablePath, lockDir } = await createBlockedCacheEntry();
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({
      pid: 999_999_999,
      startTime: null,
      acquiredAtMs: Date.now(),
    }),
  );

  await expect(
    compileSwiftSources({
      host: createTestHost(),
      sources,
      cacheName: 'recording-overlay',
      timeoutMs: 100,
    }),
  ).resolves.toBe(executablePath);

  expect(fs.existsSync(lockDir)).toBe(false);
  expect(mockRunCmd).toHaveBeenCalledTimes(1);
});

test('an ownerless cache lock is retained with verified-recovery guidance regardless of age', async () => {
  const { sources, lockDir } = await createBlockedCacheEntry();
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);

  await expect(
    compileSwiftSources({
      host: createTestHost(),
      sources,
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

test('compileSwiftSources resolves a cache name with a long interior dash run in sub-second time', async () => {
  // Regression pin for the polynomial-regex ReDoS fix in `sanitizeCacheName`'s edge-dash
  // trim. The interior dashes are never touched by the trim, so a correct sanitizer never
  // needs to inspect this whole run — only a backtracking one pays for its length.
  const value = `x${'-'.repeat(100_000)}x`;

  const start = Date.now();
  // The cache name is long enough to exceed the filesystem's path-component limit, so the
  // call is expected to reject once it reaches disk I/O; that happens only *after* the
  // (now fast) sanitize step this test pins, so timing the settle either way still proves
  // no catastrophic backtracking occurred.
  await compileSwiftSources({
    host: createTestHost(),
    sources: [{ fileName: 'helper.swift', text: 'print(1)' }],
    cacheName: value,
  }).catch(() => {});
  const elapsedMs = Date.now() - start;

  expect(elapsedMs).toBeLessThan(1_000);
});

test('a canceled compile kills swiftc through its signal and leaves no temp output', async () => {
  const cancel = new AbortController();
  mockRunCmd.mockImplementationOnce(
    async (_cmd, _args, options) =>
      await new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(createRequestCanceledError()));
      }),
  );

  const compiled = compileSwiftSources({
    host: createTestHost(),
    sources: [{ fileName: 'helper.swift', text: 'print(1)' }],
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
  expect(fs.readdirSync(path.join(tmpDir, 'swift-cache', 'v3', 'bin'))).toEqual([]);
});

test('a canceled wait on another process compile stops waiting and leaves its lock alone', async () => {
  const compile = (signal?: AbortSignal) =>
    compileSwiftSources({
      host: createTestHost(),
      sources: [{ fileName: 'helper.swift', text: 'print(1)' }],
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

test('compileSwiftSources falls back to swift-helper when the cache name sanitizes to nothing', async () => {
  const executablePath = await compileSwiftSources({
    host: createTestHost(),
    sources: [{ fileName: 'helper.swift', text: 'print(1)' }],
    cacheName: '---',
  });

  expect(path.basename(executablePath).startsWith('swift-helper-')).toBe(true);
  expect(fs.statSync(executablePath).mode & 0o111).not.toBe(0);
});

test('a compile that failed is reported over a cache lock that could not be given back', async () => {
  const buildFailure = new Error('swiftc: error: build failed');
  let lockDir = '';
  mockRunCmd.mockImplementationOnce(async (_cmd: string, args: readonly string[]) => {
    // The temp executable sits one directory under the cache entry, and the lock beside it.
    const outputPath = args[args.indexOf('-o') + 1]!;
    const executablePath = path.join(
      path.dirname(path.dirname(outputPath)),
      path.basename(outputPath),
    );
    lockDir = `${executablePath}.lock`;
    // A record that cannot be read is a release that cannot prove ownership.
    const ownerFile = path.join(lockDir, 'owner.json');
    fs.rmSync(ownerFile);
    fs.mkdirSync(ownerFile);
    throw buildFailure;
  });

  await expect(
    compileSwiftSources({
      host: createTestHost(),
      sources: [embedded()],
      cacheName: 'recording-overlay',
    }),
  ).rejects.toBe(buildFailure);
  // The release really could not verify itself: the lock is still standing.
  expect(fs.existsSync(lockDir)).toBe(true);
});

function embedded(text = 'print("recording")', fileName = 'recording-overlay.swift') {
  return { fileName, text };
}

async function createBlockedCacheEntry() {
  const sources = [embedded()];
  const executablePath = await compileSwiftSources({
    host: createTestHost(),
    sources,
    cacheName: 'recording-overlay',
  });
  const lockDir = `${executablePath}.lock`;
  fs.rmSync(executablePath);
  fs.mkdirSync(lockDir);
  vi.clearAllMocks();
  return { executablePath, lockDir, sources };
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

test('the cache root and tool environment come from the host it is given, not the process', async () => {
  const hostCacheDir = path.join(tmpDir, 'host-cache');

  const executablePath = await compileSwiftSources({
    host: {
      env: { AGENT_DEVICE_SWIFT_CACHE_DIR: hostCacheDir, LANG: 'host-locale' },
      cwd: tmpDir,
    },
    sources: [{ fileName: 'helper.swift', text: 'print("host")' }],
    cacheName: 'host-helper',
  });

  expect(path.dirname(executablePath)).toBe(path.join(hostCacheDir, 'v3', 'bin'));
  expect(mockRunCmd.mock.calls[0]?.[2]?.env).toMatchObject({
    LANG: 'host-locale',
    HOME: path.join(hostCacheDir, 'v3', 'home'),
  });
});

/** An entry name as a release that keyed entries without the compiler arguments spelled it. */
function entryKeyedWithoutCompilerArguments(cacheName: string, parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of ['3', process.platform, process.arch, ...parts])
    hash.update(part).update('\0');
  return `${cacheName}-${hash.digest('hex').slice(0, 16)}`;
}

test('an executable keyed without the compiler arguments is never reused', async () => {
  const cacheRoot = path.join(tmpDir, 'swift-cache');
  const binDir = path.join(cacheRoot, 'v3', 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  for (const level of [cacheRoot, path.dirname(binDir), binDir]) fs.chmodSync(level, 0o700);
  const planted = path.join(
    binDir,
    entryKeyedWithoutCompilerArguments('sources', ['main.swift', 'print(2)']),
  );
  fs.writeFileSync(planted, 'built with other flags', { mode: 0o755 });

  const helper = await compileSwiftSources({
    host: createTestHost(),
    cacheName: 'sources',
    sources: [{ fileName: 'main.swift', text: 'print(2)' }],
  });

  expect(helper).not.toBe(planted);
  expect(mockRunCmd).toHaveBeenCalledOnce();
});
