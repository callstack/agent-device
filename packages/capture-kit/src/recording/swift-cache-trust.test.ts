import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestHost } from '../host-environment.fixtures.ts';
import { mkdtempUnsharedForTestSync } from '../unshared-tmp-dir.fixtures.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(async (_cmd: string, args: readonly string[]) => {
    const outputPath = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(outputPath, 'compiled');
    return { stdout: '', stderr: '', exitCode: 0 };
  }),
}));

import { runCmd, withCommandHost } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { buildSwiftToolEnv, compileSwiftSourceText, getSwiftCacheRoot } from './swift-cache.ts';

const mockRunCmd = vi.mocked(runCmd);

/**
 * Some other local user, never the one running the suite: CI runs as `nobody` (65534). The same rule is written
 * in test-kit's `host-ownership.fixtures.ts` and host-kit's `internal/atomic-file-host.fixtures.ts`; test-kit
 * depends on this package, so it keeps its own copy — change all three together.
 */
const FOREIGN_UID = (process.getuid?.() ?? -1) === 65534 ? 65533 : 65534;

let tmpDir = '';
let cacheRoot: string;
let versionDir: string;
let binDir: string;

beforeEach((context) => {
  tmpDir = mkdtempUnsharedForTestSync('agent-device-swift-cache-trust-', context);
  cacheRoot = path.join(tmpDir, 'swift-cache');
  versionDir = path.join(cacheRoot, 'v3');
  binDir = path.join(versionDir, 'bin');
  vi.stubEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', cacheRoot);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
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

/** The hint names the refused directory as text and offers the override, never a command built from the path. */
function refusalHintNaming(directory: string) {
  return expect.toSatisfy(
    (hint: string) =>
      hint.includes('AGENT_DEVICE_SWIFT_CACHE_DIR') &&
      hint.includes(directory) &&
      !hint.includes('rm -rf'),
  );
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
  'an owned group-writable %s directory is refused with a hint naming it, never rebuilt',
  async (name) => {
    await plantCachedExecutable(() => {});
    const directory = path.join(versionDir, name);
    fs.writeFileSync(path.join(directory, 'kept'), 'kept');
    fs.chmodSync(directory, 0o770);

    await expect(compile()).rejects.toMatchObject(
      untrusted({
        exposure: 'not_owner_only',
        ancestor: directory,
        hint: refusalHintNaming(directory),
      }),
    );
    expect(mockRunCmd).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toContain('kept');
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
            ? `Remove group write access (chmod g-w) from this directory: ${shared}.`
            : 'AGENT_DEVICE_SWIFT_CACHE_DIR',
        ),
      }),
    );
    expect(mockRunCmd).not.toHaveBeenCalled();
  },
);

test('an existing 0755 version directory is refused, so a umask 002 lock never lands in it', async () => {
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(versionDir, 0o755);
  const previousUmask = process.umask(0o002);
  try {
    await expect(compile()).rejects.toMatchObject(
      untrusted({
        exposure: 'not_owner_only',
        ancestor: versionDir,
        hint: refusalHintNaming(versionDir),
      }),
    );
  } finally {
    process.umask(previousUmask);
  }

  expect(fs.readdirSync(binDir)).toEqual([]);
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('a version directory that is a link is refused, and what it names is untouched', async () => {
  const target = path.join(tmpDir, 'linked-version');
  fs.mkdirSync(path.join(target, 'bin'), { recursive: true, mode: 0o755 });
  fs.chmodSync(target, 0o755);
  fs.writeFileSync(path.join(target, 'bin', 'kept'), 'kept');
  fs.mkdirSync(cacheRoot, { mode: 0o700 });
  fs.symlinkSync(target, versionDir);

  await expect(compile()).rejects.toMatchObject(
    untrusted({ exposure: 'planted_link', ancestor: versionDir }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
  expect(modeOf(target)).toBe(0o755);
  expect(fs.readdirSync(target)).toEqual(['bin']);
  expect(fs.readdirSync(path.join(target, 'bin'))).toEqual(['kept']);
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

test('a group-writable module-cache holding a planted link is refused, and the link target is untouched', async () => {
  await plantCachedExecutable(() => {});
  const moduleCache = path.join(versionDir, 'module-cache');
  const outside = path.join(tmpDir, 'outside-module-cache');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(path.join(outside, 'kept'), 'kept');
  fs.chmodSync(moduleCache, 0o770);
  fs.symlinkSync(outside, path.join(moduleCache, 'planted'));

  await expect(compile()).rejects.toMatchObject(
    untrusted({
      exposure: 'not_owner_only',
      ancestor: moduleCache,
      hint: refusalHintNaming(moduleCache),
    }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
  expect(fs.readdirSync(outside)).toEqual(['kept']);
  expect(fs.readFileSync(path.join(outside, 'kept'), 'utf8')).toBe('kept');
});

test('a group-writable bin holding a leftover lock is refused, and the lock is left for the user', async () => {
  const executablePath = await plantCachedExecutable(() => {});
  const staleLock = `${executablePath}.lock`;
  fs.mkdirSync(staleLock);
  fs.chmodSync(binDir, 0o770);

  await expect(compile()).rejects.toMatchObject(
    untrusted({
      exposure: 'not_owner_only',
      ancestor: binDir,
      hint: refusalHintNaming(binDir),
    }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
  expect(fs.existsSync(staleLock)).toBe(true);
});

test.skipIf(process.getuid?.() === 0)(
  'a staging cleanup that fails keeps the compiler failure as the answer',
  async () => {
    const compilerFailure = new AppError('COMMAND_FAILED', 'swiftc: error: build failed', {
      reason: 'swift_compile_failed',
    });
    let stagingDir = '';
    mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
      const outputPath = args[args.indexOf('-o') + 1]!;
      stagingDir = path.dirname(outputPath);
      fs.writeFileSync(outputPath, 'partial');
      // The staging directory can no longer have its entries removed.
      fs.chmodSync(stagingDir, 0o500);
      throw compilerFailure;
    });

    try {
      await expect(compile()).rejects.toBe(compilerFailure);
      expect(compilerFailure.details).toMatchObject({
        reason: 'swift_compile_failed',
        stagingCleanupError: expect.stringMatching(/EACCES|EPERM|ENOTEMPTY/),
      });
    } finally {
      if (stagingDir) fs.chmodSync(stagingDir, 0o700);
    }
  },
);

test('a refused directory whose path holds a space and a quote is named exactly, with no command built from it', async () => {
  const awkwardRoot = path.join(tmpDir, "Docs Cache 'q'", 'swift-cache');
  const awkwardBin = path.join(awkwardRoot, 'v3', 'bin');
  await compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: awkwardRoot });
  fs.chmodSync(awkwardBin, 0o770);
  vi.clearAllMocks();

  await expect(compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: awkwardRoot })).rejects.toMatchObject(
    untrusted({
      exposure: 'not_owner_only',
      ancestor: awkwardBin,
      hint: refusalHintNaming(awkwardBin),
    }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('a regular file planted at home is refused, never used as the compiler home', async () => {
  await plantCachedExecutable(() => {});
  const home = path.join(versionDir, 'home');
  fs.rmSync(home, { recursive: true });
  fs.writeFileSync(home, 'planted', { mode: 0o600 });

  await expect(compile()).rejects.toMatchObject(
    untrusted({ exposure: 'not_a_directory', ancestor: home }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('a group-writable ancestor whose path holds a space and a quote is named exactly, with no command built from it', async () => {
  const shared = path.join(tmpDir, "Shared Dir 'q'");
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o770);

  await expect(
    compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(shared, 'swift-cache') }),
  ).rejects.toMatchObject(
    untrusted({
      exposure: 'shared_group_writable',
      ancestor: shared,
      hint: expect.toSatisfy(
        (hint: string) =>
          hint.includes(`directory: ${shared}.`) && !hint.includes(`chmod g-w ${shared}`),
      ),
    }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
});

/** The compiler launch the cache made: its executable, the staging directory of its output, and its env. */
function compilerLaunch() {
  const [cmd, args, options] = mockRunCmd.mock.calls[0]!;
  const outputPath = args[args.indexOf('-o') + 1]!;
  return { cmd, staging: path.dirname(outputPath), env: options?.env ?? {} };
}

test('the compiler gets this compile private staging directory as every temp directory, not an inherited shared one', async () => {
  const sharedTmp = path.join(tmpDir, 'shared-tmp');
  fs.mkdirSync(sharedTmp);
  fs.chmodSync(sharedTmp, 0o1777);

  await compile({
    AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot,
    TMPDIR: sharedTmp,
    TEMP: sharedTmp,
    TMP: sharedTmp,
  });

  const { staging, env } = compilerLaunch();
  expect(path.dirname(staging)).toBe(binDir);
  expect({ TMPDIR: env.TMPDIR, TEMP: env.TEMP, TMP: env.TMP }).toEqual({
    TMPDIR: staging,
    TEMP: staging,
    TMP: staging,
  });
});

// Variables the compiler toolchain or the loader would honor, and names nobody has thought of yet.
const UNNAMED_HOST_VARIABLES = {
  COMPILER_PATH: '/tmp/planted-bin',
  CCC_OVERRIDE_OPTIONS: '+-fuse-ld=/tmp/planted-ld',
  SWIFT_DRIVER_SWIFTSCAN_LIB: '/tmp/planted-swiftscan.dylib',
  SWIFT_DRIVER_TOOLCHAIN_CASPLUGIN_LIB: '/tmp/planted-cas.dylib',
  DYLD_INSERT_LIBRARIES: '/tmp/planted.dylib',
  SDKROOT: '/tmp/planted.sdk',
  SOME_FUTURE_TOOLCHAIN_OVERRIDE: 'planted',
};

test('the compiler environment is exactly the allowlist, whatever the host sets', async () => {
  await compile({
    AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot,
    PATH: `${path.join(tmpDir, 'planted-bin')}:/usr/bin`,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    ...UNNAMED_HOST_VARIABLES,
  });

  const { cmd, env } = compilerLaunch();
  expect(cmd).toBe('/usr/bin/xcrun');
  expect(mockRunCmd.mock.calls[0]![1].slice(0, 3)).toEqual(['--sdk', 'macosx', 'swiftc']);
  expect(Object.keys(env).sort()).toEqual(
    ['CLANG_MODULE_CACHE_PATH', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TEMP', 'TMP', 'TMPDIR'].sort(),
  );
  expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
});

/**
 * Launches a cached helper the way the validator, overlay and frame decoder do, at the real subprocess boundary,
 * and answers the variable names the helper process saw. The stand-in helper is a script run by this test's own
 * Node, not a shell or /usr/bin/env, which macOS strips loader variables from before they could show.
 */
async function helperProcessEnvNames(
  executablePath: string,
  hostEnv: NodeJS.ProcessEnv,
): Promise<string[]> {
  const { runCmd: spawnForReal } = await vi.importActual<
    typeof import('@agent-device/host-kit/command')
  >('@agent-device/host-kit/command');
  const { stdout } = await spawnForReal(executablePath, [], { env: buildSwiftToolEnv(hostEnv) });
  return JSON.parse(stdout) as string[];
}

test('a cold and a warm helper launch never pass loader or other unnamed host variables to the helper', async () => {
  const hostEnv = {
    AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot,
    DYLD_INSERT_LIBRARIES: '/tmp/planted.dylib',
    DYLD_LIBRARY_PATH: '/tmp/planted',
    COMPILER_PATH: '/tmp/planted-bin',
  };
  mockRunCmd.mockImplementationOnce(async (_cmd, args) => {
    fs.writeFileSync(
      args[args.indexOf('-o') + 1]!,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(Object.keys(process.env)));\n`,
    );
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const cold = await compile(hostEnv);
  const coldNames = await helperProcessEnvNames(cold, hostEnv);
  const warm = await compile(hostEnv);
  const warmNames = await helperProcessEnvNames(warm, hostEnv);

  expect(warm).toBe(cold);
  expect(mockRunCmd).toHaveBeenCalledOnce();
  for (const names of [coldNames, warmNames]) {
    expect(names.filter((name) => name.startsWith('DYLD_') || name === 'COMPILER_PATH')).toEqual(
      [],
    );
    expect(names).toEqual(expect.arrayContaining(['HOME', 'PATH']));
  }
});

test.each([
  [
    'a directory others can write',
    () => {
      const open = path.join(tmpDir, 'open-developer');
      fs.mkdirSync(open);
      fs.chmodSync(open, 0o777);
      return open;
    },
  ],
  [
    'a relative path, even to a private directory',
    () => {
      const developer = path.join(tmpDir, 'relative-developer');
      fs.mkdirSync(developer, { mode: 0o755 });
      return path.relative(process.cwd(), developer);
    },
  ],
  ['a missing directory', () => path.join(tmpDir, 'no-such-developer')],
])(
  'a DEVELOPER_DIR that is %s is refused before the compiler runs',
  async (_kind, developerDir) => {
    const dir = developerDir();

    await expect(
      compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot, DEVELOPER_DIR: dir }),
    ).rejects.toMatchObject(
      untrusted({
        exposure: 'untrusted_developer_dir',
        ancestor: dir,
        hint: expect.stringContaining('DEVELOPER_DIR'),
      }),
    );
    expect(mockRunCmd).not.toHaveBeenCalled();
  },
);

test('a DEVELOPER_DIR only this user can write reaches the compiler', async () => {
  const developerDir = path.join(tmpDir, 'Developer');
  fs.mkdirSync(developerDir, { mode: 0o755 });

  await compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot, DEVELOPER_DIR: developerDir });

  expect(compilerLaunch().env.DEVELOPER_DIR).toBe(developerDir);
});

const hostWith = (env: NodeJS.ProcessEnv) => ({
  env: { AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot, ...env },
  cwd: tmpDir,
});

function developerDirectory(name: string, mode = 0o755): string {
  const directory = path.join(tmpDir, name);
  fs.mkdirSync(directory);
  fs.chmodSync(directory, mode);
  return directory;
}

test('a request-scoped DEVELOPER_DIR others can write is refused on a cold cache', async () => {
  const open = developerDirectory('open-request-developer', 0o777);
  const host = hostWith({});

  await expect(
    withCommandHost({ host, requestEnv: { DEVELOPER_DIR: open } }, () =>
      compileSwiftSourceText({ host, source: 'print(1)', cacheName: 'helper' }),
    ),
  ).rejects.toMatchObject(
    untrusted({ exposure: 'untrusted_developer_dir', ancestor: open, hint: expect.any(String) }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('a valid request-scoped DEVELOPER_DIR wins over an invalid host one, and an empty one drops it', async () => {
  const trusted = developerDirectory('request-developer');
  const host = hostWith({ DEVELOPER_DIR: developerDirectory('open-host-developer', 0o777) });

  await withCommandHost({ host, requestEnv: { DEVELOPER_DIR: trusted } }, () =>
    compileSwiftSourceText({ host, source: 'print(1)', cacheName: 'with-request' }),
  );
  expect(compilerLaunch().env.DEVELOPER_DIR).toBe(trusted);

  vi.clearAllMocks();
  await withCommandHost({ host, requestEnv: { DEVELOPER_DIR: '' } }, () =>
    compileSwiftSourceText({ host, source: 'print(2)', cacheName: 'xcode-select' }),
  );
  expect(compilerLaunch().env).not.toHaveProperty('DEVELOPER_DIR');
});

test('the compiler process gets the judged DEVELOPER_DIR, which the request overlay cannot replace', async () => {
  const trusted = developerDirectory('resolved-developer');
  const linked = path.join(tmpDir, 'linked-developer');
  fs.symlinkSync(trusted, linked);
  const host = hostWith({});
  const { runCmd: spawnForReal } = await vi.importActual<
    typeof import('@agent-device/host-kit/command')
  >('@agent-device/host-kit/command');
  let childDeveloperDir: string | undefined;
  mockRunCmd.mockImplementationOnce(async (_cmd, args, options) => {
    // A real spawn under the same scope, so host-kit applies whatever request overlay is in force.
    const { stdout } = await spawnForReal('/usr/bin/env', [], { env: options?.env });
    childDeveloperDir = /^DEVELOPER_DIR=(.*)$/m.exec(stdout)?.[1];
    fs.writeFileSync(args[args.indexOf('-o') + 1]!, 'compiled');
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await withCommandHost({ host, requestEnv: { DEVELOPER_DIR: linked } }, () =>
    compileSwiftSourceText({ host, source: 'print(1)', cacheName: 'overlay' }),
  );

  expect(childDeveloperDir).toBe(trusted);
});

test.each([
  [
    'below a group-writable directory',
    () => {
      const shared = developerDirectory('shared-parent', 0o775);
      const developer = path.join(shared, 'Developer');
      fs.mkdirSync(developer, { mode: 0o755 });
      return { selection: developer, ancestor: shared };
    },
  ],
  [
    'owned by another local user',
    () => {
      const developer = developerDirectory('foreign-developer');
      reportForeignOwner(developer);
      return { selection: developer, ancestor: developer };
    },
  ],
  [
    'a link to a directory others can write, judged as its target',
    () => {
      const target = developerDirectory('open-link-target', 0o777);
      const link = path.join(tmpDir, 'developer-link');
      fs.symlinkSync(target, link);
      return { selection: link, ancestor: target };
    },
  ],
  [
    'a regular file',
    () => {
      const file = path.join(tmpDir, 'developer-file');
      fs.writeFileSync(file, '', { mode: 0o644 });
      return { selection: file, ancestor: file };
    },
  ],
])('a DEVELOPER_DIR %s is refused before the compiler runs', async (_kind, plant) => {
  const { selection, ancestor } = plant();

  await expect(
    compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot, DEVELOPER_DIR: selection }),
  ).rejects.toMatchObject(
    untrusted({ exposure: 'untrusted_developer_dir', ancestor, hint: expect.any(String) }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('a DEVELOPER_DIR spelled with a trailing /. reaches the compiler as the resolved directory', async () => {
  const trusted = developerDirectory('dotted-developer');

  await compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot, DEVELOPER_DIR: `${trusted}/.` });

  expect(compilerLaunch().env.DEVELOPER_DIR).toBe(trusted);
});

test('an Xcode bundle selection is judged at its Contents/Developer, so a group-writable Contents is refused', async () => {
  const bundle = developerDirectory('Shared.app');
  const contents = path.join(bundle, 'Contents');
  fs.mkdirSync(path.join(contents, 'Developer'), { recursive: true, mode: 0o755 });
  fs.chmodSync(contents, 0o775);

  await expect(
    compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot, DEVELOPER_DIR: bundle }),
  ).rejects.toMatchObject(
    untrusted({
      exposure: 'untrusted_developer_dir',
      ancestor: contents,
      hint: expect.any(String),
    }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('an Xcode bundle selection reaches the compiler as its Contents/Developer directory', async () => {
  const bundle = developerDirectory('Private.app');
  const developer = path.join(bundle, 'Contents', 'Developer');
  fs.mkdirSync(developer, { recursive: true, mode: 0o755 });

  await compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot, DEVELOPER_DIR: bundle });

  expect(compilerLaunch().env.DEVELOPER_DIR).toBe(developer);
});

test('the selection is canonicalized by the filesystem native spelling, which the exact checks then judge', async () => {
  // A case-insensitive alias such as /applications resolves to the native spelling; this stands it in with a
  // directory the native answer names.
  const alias = developerDirectory('alias-spelling');
  const canonical = developerDirectory('Canonical-Spelling');
  vi.spyOn(fs.realpathSync, 'native').mockImplementation(((name: fs.PathLike) =>
    String(name) === alias ? canonical : String(name)) as typeof fs.realpathSync.native);

  await compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot, DEVELOPER_DIR: alias });

  expect(compilerLaunch().env.DEVELOPER_DIR).toBe(canonical);
});

test('a link without the .app suffix that resolves to a bundle is judged at the bundle Contents/Developer', async () => {
  const bundle = developerDirectory('Linked.app');
  const contents = path.join(bundle, 'Contents');
  fs.mkdirSync(path.join(contents, 'Developer'), { recursive: true, mode: 0o755 });
  fs.chmodSync(contents, 0o775);
  const link = path.join(tmpDir, 'xcode');
  fs.symlinkSync(bundle, link);

  await expect(
    compile({ AGENT_DEVICE_SWIFT_CACHE_DIR: cacheRoot, DEVELOPER_DIR: link }),
  ).rejects.toMatchObject(
    untrusted({
      exposure: 'untrusted_developer_dir',
      ancestor: contents,
      hint: expect.any(String),
    }),
  );
  expect(mockRunCmd).not.toHaveBeenCalled();
});
