import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestHost } from '../host-environment.fixtures.ts';
import { mkdtempUnsharedForTestSync } from '../tmp-dir.fixtures.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(async (_cmd: string, args: readonly string[]) => {
    const outputPath = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(outputPath, 'compiled');
    return { stdout: '', stderr: '', exitCode: 0 };
  }),
}));

import { runCmd } from '@agent-device/host-kit/command';
import { compileSwiftSourceText, getSwiftCacheRoot } from './swift-cache.ts';

const mockRunCmd = vi.mocked(runCmd);

/**
 * Some other local user, never the one running the suite: CI runs as `nobody` (65534). The same rule is written
 * in test-kit's `host-ownership.fixtures.ts` and host-kit's `internal/atomic-file-host.fixtures.ts`; test-kit
 * depends on this package, so it keeps its own copy — change all three together.
 */
const FOREIGN_UID = (process.getuid?.() ?? -1) === 65534 ? 65533 : 65534;

let tmpDir: string;
let cacheRoot: string;
let versionDir: string;
let binDir: string;

beforeEach(() => {
  // Physical spelling: the ancestry walk resolves links such as macOS's /var, and judges the names it reaches.
  tmpDir = fs.realpathSync(mkdtempUnsharedForTestSync('agent-device-swift-cache-trust-'));
  cacheRoot = path.join(tmpDir, 'swift-cache');
  versionDir = path.join(cacheRoot, 'v3');
  binDir = path.join(versionDir, 'bin');
  vi.stubEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', cacheRoot);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const compile = (env?: NodeJS.ProcessEnv) =>
  compileSwiftSourceText({
    host: env ? { env, cwd: tmpDir } : createTestHost(),
    source: 'print(1)',
    cacheName: 'helper',
  });

const untrusted = (details: Record<string, unknown> = {}) => ({
  code: 'COMMAND_FAILED',
  details: {
    reason: 'swift_cache_untrusted',
    hint: expect.stringContaining('AGENT_DEVICE_SWIFT_CACHE_DIR'),
    ...details,
  },
});

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

function modeOf(pathname: string): number {
  return fs.statSync(pathname).mode & 0o777;
}

test('a private versioned root is created owner-only and its executable is reused', async () => {
  const first = await compile();
  const second = await compile();

  expect(second).toBe(first);
  expect(path.dirname(first)).toBe(binDir);
  expect(mockRunCmd).toHaveBeenCalledOnce();
  expect(modeOf(versionDir)).toBe(0o700);
  expect(modeOf(binDir)).toBe(0o700);
  expect(modeOf(first)).toBe(0o755);
});

test('an executable from an earlier cache layout is never run, even under the same name', async () => {
  const name = path.basename(
    await compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(tmpDir, 'probe') }),
  );
  // The previous layout kept executables, compiler state and sources straight under the root.
  const planted = path.join(cacheRoot, 'bin', name);
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, 'planted', { mode: 0o755 });
  vi.clearAllMocks();

  const executablePath = await compile();

  expect(executablePath).toBe(path.join(binDir, name));
  expect(mockRunCmd).toHaveBeenCalledOnce();
  expect(fs.readFileSync(planted, 'utf8')).toBe('planted');
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
  expect(modeOf(executablePath) & 0o022).toBe(0);
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

test('something other than a regular file at the entry name is never handed back as the helper', async () => {
  // Owned here and closed to others, so only the regular-file check tells it apart from a helper. A link
  // cannot stand in on Linux, where every link reads as mode 0777 and the write check refuses it first.
  await plantCachedExecutable((name) => fs.mkdirSync(name, { mode: 0o755 }));

  await expect(compile()).rejects.toThrow();
  expect(mockRunCmd).toHaveBeenCalledOnce();
});

test('source text is written exclusively, never through a name already standing in the temp directory', async () => {
  const name = path.basename(await plantCachedExecutable(() => {}));
  const target = path.join(tmpDir, 'victim');
  fs.writeFileSync(target, 'untouched');
  const realMkdtemp = fs.mkdtempSync.bind(fs);
  vi.spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string) => {
    const directory = realMkdtemp(prefix);
    fs.symlinkSync(target, path.join(directory, `${name}.swift`));
    return directory;
  }) as typeof fs.mkdtempSync);

  await expect(compile()).rejects.toMatchObject({ code: 'EEXIST' });
  expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('a cache root another local user owns is refused with the cache override in the hint', async () => {
  fs.mkdirSync(cacheRoot, { mode: 0o700 });
  reportForeignOwner(cacheRoot);

  await expect(compile()).rejects.toMatchObject(
    untrusted({ exposure: 'foreign_owned', ancestor: cacheRoot }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
  expect(fs.readdirSync(cacheRoot)).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)(
  'a cache root this user may not create is refused as untrusted, not as a raw permission error',
  async () => {
    const locked = path.join(tmpDir, 'locked');
    fs.mkdirSync(locked, { mode: 0o500 });

    await expect(
      compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(locked, 'swift-cache') }),
    ).rejects.toMatchObject(untrusted({ errno: 'EACCES' }));
    expect(mockRunCmd).not.toHaveBeenCalled();
  },
);

test.each(['bin', 'home', 'module-cache'])(
  'an owned %s directory wider than 0700 is closed to its owner before it is used',
  async (name) => {
    await plantCachedExecutable(() => {});
    fs.chmodSync(path.join(versionDir, name), 0o770);

    await compile();

    expect(modeOf(path.join(versionDir, name))).toBe(0o700);
    expect(mockRunCmd).toHaveBeenCalledOnce();
  },
);

test.each(['home', 'module-cache'])(
  'a compiler %s directory another local user owns is refused before swiftc runs',
  async (name) => {
    await plantCachedExecutable(() => {});
    reportForeignOwner(path.join(versionDir, name));

    await expect(compile()).rejects.toMatchObject(
      untrusted({ exposure: 'foreign_owned', ancestor: path.join(versionDir, name) }),
    );
    expect(mockRunCmd).not.toHaveBeenCalled();
  },
);

test.each(['bin', 'home', 'module-cache'])(
  'a %s link planted inside the version directory is refused, never followed out of it',
  async (name) => {
    fs.mkdirSync(versionDir, { recursive: true, mode: 0o700 });
    const outside = path.join(tmpDir, `outside-${name}`);
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.symlinkSync(outside, path.join(versionDir, name));

    await expect(compile()).rejects.toMatchObject(
      untrusted({ exposure: 'planted_link', ancestor: path.join(versionDir, name) }),
    );
    expect(mockRunCmd).not.toHaveBeenCalled();
    expect(fs.readdirSync(outside)).toEqual([]);
  },
);

test('an owned cached file without owner execute is compiled over, not reused', async () => {
  const executablePath = await plantCachedExecutable((name) => {
    fs.writeFileSync(name, 'planted', { mode: 0o644 });
  });

  await expect(compile()).resolves.toBe(executablePath);

  expect(mockRunCmd).toHaveBeenCalledOnce();
  expect(fs.readFileSync(executablePath, 'utf8')).toBe('compiled');
});

test('a warmed bin that was removed and recreated by another local user is refused', async () => {
  const executablePath = await compile();
  fs.rmSync(binDir, { recursive: true });
  fs.mkdirSync(binDir, { mode: 0o700 });
  // A file this user owns can still be put there, for example as a hard link to one of theirs.
  fs.writeFileSync(executablePath, 'planted', { mode: 0o755 });
  reportForeignOwner(binDir);
  vi.clearAllMocks();

  await expect(compile()).rejects.toMatchObject(
    untrusted({ exposure: 'foreign_owned', ancestor: binDir }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('a bin replaced while swiftc runs is refused before the rename', async () => {
  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    const outputPath = args[args.indexOf('-o') + 1]!;
    fs.renameSync(binDir, path.join(versionDir, 'old-bin'));
    // The new bin carries a compile output at the same spelling, so only the directory identity differs.
    fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(outputPath, 'compiled');
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await expect(compile()).rejects.toMatchObject(untrusted({ exposure: 'parent_replaced' }));
  expect(fs.readdirSync(binDir)).toEqual([]);
});

test('under umask 002 the compile lock still sits in a bin nobody else can enter', async () => {
  const previousUmask = process.umask(0o002);
  let lockParentMode: number | undefined;
  let lockDir = '';
  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    const outputPath = args[args.indexOf('-o') + 1]!;
    lockDir = path.join(binDir, `${path.basename(outputPath)}.lock`);
    expect(fs.statSync(lockDir).isDirectory()).toBe(true);
    lockParentMode = modeOf(path.dirname(lockDir));
    fs.writeFileSync(outputPath, 'compiled');
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  try {
    await compile();
  } finally {
    process.umask(previousUmask);
  }

  expect(lockParentMode).toBe(0o700);
  expect(modeOf(versionDir)).toBe(0o700);
});

test('the default root is the user cache directory, never the shared temp directory', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const onPlatform = (value: string, env: NodeJS.ProcessEnv) => {
    Object.defineProperty(process, 'platform', { ...platform, value });
    try {
      return getSwiftCacheRoot(env);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  };

  expect(onPlatform('darwin', { HOME: '/home/u' })).toBe(
    '/home/u/Library/Caches/agent-device/swift-cache',
  );
  expect(onPlatform('linux', { HOME: '/home/u', XDG_CACHE_HOME: '/xdg' })).toBe(
    '/xdg/agent-device/swift-cache',
  );
  expect(onPlatform('linux', { HOME: '/home/u', XDG_CACHE_HOME: 'relative' })).toBe(
    '/home/u/.cache/agent-device/swift-cache',
  );
  expect(onPlatform('linux', { HOME: '/home/u', AGENT_DEVICE_SWIFT_CACHE_DIR: '/override' })).toBe(
    '/override',
  );
});

test.each([
  ['1777', 'world_writable'],
  ['1770', 'shared_group_writable'],
])(
  'a cache under a sticky shared directory (mode %s) is refused, not passed through',
  async (mode, exposure) => {
    const shared = path.join(tmpDir, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, Number.parseInt(mode, 8));

    await expect(
      compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(shared, 'swift-cache') }),
    ).rejects.toMatchObject(
      untrusted({
        exposure,
        ancestor: shared,
        hint: expect.stringContaining(
          exposure === 'shared_group_writable'
            ? `chmod g-w ${shared}`
            : 'AGENT_DEVICE_SWIFT_CACHE_DIR',
        ),
      }),
    );
    expect(mockRunCmd).not.toHaveBeenCalled();
  },
);

test('an existing 0755 cache is closed to its owner, so a umask 002 lock is unreachable for others', async () => {
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
  for (const level of [cacheRoot, versionDir, binDir]) fs.chmodSync(level, 0o755);
  const previousUmask = process.umask(0o002);
  let lockDir = '';
  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    const outputPath = args[args.indexOf('-o') + 1]!;
    lockDir = path.join(binDir, `${path.basename(outputPath)}.lock`);
    expect(fs.statSync(lockDir).isDirectory()).toBe(true);
    fs.writeFileSync(outputPath, 'compiled');
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  try {
    await compile();
  } finally {
    process.umask(previousUmask);
  }

  expect(path.relative(versionDir, lockDir).startsWith('..')).toBe(false);
  expect(modeOf(versionDir)).toBe(0o700);
});

test('a version directory another local user owns is refused', async () => {
  fs.mkdirSync(versionDir, { recursive: true, mode: 0o700 });
  reportForeignOwner(versionDir);

  await expect(compile()).rejects.toMatchObject(
    untrusted({ exposure: 'foreign_owned', ancestor: versionDir }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test.skipIf(process.getuid?.() === 0).each([
  ['0500', 'the lock cannot be created'],
  ['0600', 'the cached entry cannot be looked up'],
])('an owned bin at %s is refused as untrusted when %s', async (mode) => {
  await plantCachedExecutable(() => {});
  fs.chmodSync(binDir, Number.parseInt(mode, 8));
  try {
    await expect(compile()).rejects.toMatchObject(untrusted({ errno: 'EACCES' }));
  } finally {
    fs.chmodSync(binDir, 0o700);
  }
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('a bin replaced while waiting for the lock is refused, even with a helper at the name', async () => {
  const executablePath = await plantCachedExecutable(() => {});
  const lockDir = `${executablePath}.lock`;
  fs.mkdirSync(lockDir);
  // The parent process stands in for another live process that holds the lock while it compiles.
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.ppid, startTime: null, acquiredAtMs: Date.now() }),
  );

  const compiled = compile();
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.renameSync(binDir, path.join(versionDir, 'old-bin'));
  fs.mkdirSync(binDir, { mode: 0o700 });
  fs.writeFileSync(executablePath, 'planted', { mode: 0o755 });

  await expect(compiled).rejects.toMatchObject(untrusted({ exposure: 'parent_replaced' }));
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('the compile output is made executable through its descriptor, never through a swapped link', async () => {
  const victim = path.join(tmpDir, 'victim');
  fs.writeFileSync(victim, 'untouched', { mode: 0o600 });
  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    fs.symlinkSync(victim, args[args.indexOf('-o') + 1]!);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await expect(compile()).rejects.toMatchObject({ code: 'ELOOP' });
  expect(modeOf(victim)).toBe(0o600);
  expect(fs.readdirSync(binDir)).toEqual([]);
});
