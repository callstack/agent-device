import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestHost } from '../host-environment.fixtures.ts';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(async (_cmd: string, args: readonly string[]) => {
    const outputPath = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(outputPath, 'compiled');
    return { stdout: '', stderr: '', exitCode: 0 };
  }),
}));

import { runCmd } from '@agent-device/host-kit/command';
import { compileSwiftSourceText } from './swift-cache.ts';

const mockRunCmd = vi.mocked(runCmd);

/**
 * Some other local user, never the one running the suite: CI runs as `nobody` (65534). The same rule lives in
 * test-kit's host-ownership fixtures, which this package cannot import because test-kit depends on it.
 */
const FOREIGN_UID = (process.getuid?.() ?? -1) === 65534 ? 65533 : 65534;

let tmpDir: string;
let cacheRoot: string;

beforeEach(() => {
  // Physical spelling: the ancestry walk resolves links such as macOS's /var, and judges the names it reaches.
  tmpDir = fs.realpathSync(mkdtempForTestSync('agent-device-swift-cache-trust-'));
  cacheRoot = path.join(tmpDir, 'swift-cache');
  vi.stubEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', cacheRoot);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const compile = () =>
  compileSwiftSourceText({ host: createTestHost(), source: 'print(1)', cacheName: 'helper' });

/** Publishes the entry once, then replaces it with whatever `plant` leaves at its name. */
async function plantCachedExecutable(plant: (executablePath: string) => void): Promise<string> {
  const executablePath = await compile();
  fs.rmSync(executablePath);
  plant(executablePath);
  vi.clearAllMocks();
  return executablePath;
}

/** Reports `target` as owned by another local user; modes and every other path stay what the host says. */
function reportForeignOwner(target: string): void {
  const realLstat = fs.lstatSync.bind(fs);
  vi.spyOn(fs, 'lstatSync').mockImplementation(((name: never, ...rest: never[]) => {
    const stats = realLstat(name, ...rest);
    if (String(name) !== target || stats === undefined) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      uid: typeof stats.uid === 'bigint' ? BigInt(FOREIGN_UID) : FOREIGN_UID,
    });
  }) as typeof fs.lstatSync);
}

test('a private cache root is created owner-only and its executable is reused', async () => {
  const first = await compile();
  const second = await compile();

  expect(second).toBe(first);
  expect(mockRunCmd).toHaveBeenCalledOnce();
  expect(fs.statSync(cacheRoot).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(cacheRoot, 'bin')).mode & 0o777).toBe(0o700);
  expect(fs.statSync(first).mode & 0o777).toBe(0o755);
});

test('a cached executable another local user owns is compiled over, not reused', async () => {
  const executablePath = await plantCachedExecutable((name) => {
    fs.writeFileSync(name, 'planted', { mode: 0o755 });
  });
  reportForeignOwner(executablePath);

  await expect(compile()).resolves.toBe(executablePath);

  expect(mockRunCmd).toHaveBeenCalledOnce();
  expect(fs.readFileSync(executablePath, 'utf8')).toBe('compiled');
});

test('a group-writable cached executable is compiled over, not reused', async () => {
  const executablePath = await plantCachedExecutable((name) => {
    fs.writeFileSync(name, 'planted');
    fs.chmodSync(name, 0o775);
  });

  await expect(compile()).resolves.toBe(executablePath);

  expect(mockRunCmd).toHaveBeenCalledOnce();
  expect(fs.readFileSync(executablePath, 'utf8')).toBe('compiled');
  expect(fs.statSync(executablePath).mode & 0o022).toBe(0);
});

test('a link planted in place of the cached executable is replaced, never followed', async () => {
  const target = path.join(tmpDir, 'elsewhere');
  fs.writeFileSync(target, 'planted', { mode: 0o755 });
  const executablePath = await plantCachedExecutable((name) => fs.symlinkSync(target, name));

  await expect(compile()).resolves.toBe(executablePath);

  expect(mockRunCmd).toHaveBeenCalledOnce();
  expect(fs.lstatSync(executablePath).isFile()).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toBe('planted');
});

test('a cache root another local user owns is refused with the cache override in the hint', async () => {
  fs.mkdirSync(cacheRoot, { mode: 0o700 });
  reportForeignOwner(cacheRoot);

  await expect(compile()).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'swift_cache_untrusted',
      exposure: 'foreign_owned',
      ancestor: cacheRoot,
      hint: expect.stringContaining('AGENT_DEVICE_SWIFT_CACHE_DIR'),
    },
  });
  expect(mockRunCmd).not.toHaveBeenCalled();
  expect(fs.readdirSync(cacheRoot)).toEqual([]);
});
