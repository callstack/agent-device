import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  admitDaemonStateRoot,
  DAEMON_STATE_ROOT_UNSAFE_REASON,
  resolveDaemonPaths,
  windowsStatePathProblem,
  type DaemonPaths,
} from './daemon-resolution.ts';

const posix = process.platform !== 'win32';

function pathsOf(stateDir: string): DaemonPaths {
  return resolveDaemonPaths(stateDir);
}

/** A root one `chmod 700` away from what the test's own umask would have left. */
function makePrivateRoot(under: string, name = 'state'): string {
  const root = path.join(under, name);
  fs.mkdirSync(root);
  fs.chmodSync(root, 0o700);
  return root;
}

function refusalOf(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const details = (error as AppError).details as Record<string, unknown>;
    expect(details.reason).toBe(DAEMON_STATE_ROOT_UNSAFE_REASON);
    return details;
  }
  throw new Error('expected an AppError refusal');
}

test.skipIf(!posix)(
  'a private populated root is admitted as it stands, and inspect mode changes nothing',
  () => {
    const under = mkdtempForTestSync('state-admit-populated-');
    const root = makePrivateRoot(under, 'populated');
    fs.mkdirSync(path.join(root, 'sessions', 'remote-scripts'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'daemon.json'), '{"pid":1}\n');
    fs.writeFileSync(path.join(root, 'sessions', 'journey.ad'), 'open com.example.app\n');
    fs.writeFileSync(path.join(root, 'sessions', 'remote-scripts', 'rec.ad'), 'tap\n');
    const before = fs.readdirSync(root).sort();

    admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });
    admitDaemonStateRoot({ paths: pathsOf(root), mode: 'inspect' });

    expect(fs.readdirSync(root).sort()).toEqual(before);
    expect(fs.statSync(path.join(root, 'sessions', 'journey.ad')).isFile()).toBe(true);
  },
);

test.skipIf(!posix)(
  'a symlink at the root refuses where it stands and leaves the outside target untouched',
  () => {
    const under = mkdtempForTestSync('state-admit-root-link-');
    const outside = path.join(under, 'outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.writeFileSync(path.join(outside, 'sentinel'), 'untouched');
    const link = path.join(under, 'linked');
    fs.symlinkSync(outside, link);

    const details = refusalOf(() =>
      admitDaemonStateRoot({ paths: pathsOf(link), mode: 'establish' }),
    );

    expect(details).toMatchObject({
      problem: 'symlink',
      component: link,
      stateDir: link,
      fix: expect.stringContaining('AGENT_DEVICE_STATE_DIR'),
    });
    // The refusal is the first thing this operation does: the target has no new entry, and the log,
    // registration and session names a start would have written were never created beside the link.
    expect(fs.readdirSync(outside)).toEqual(['sentinel']);
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('untouched');
    expect(fs.readdirSync(under).sort()).toEqual(['linked', 'outside']);
  },
);

test.skipIf(!posix)(
  'a refused establish publishes no partial file and leaves no temporary sibling',
  () => {
    const under = fs.realpathSync(mkdtempForTestSync('state-admit-partial-'));
    const root = path.join(under, 'state');
    fs.mkdirSync(root);
    fs.chmodSync(root, 0o755);

    expect(() => admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' })).toThrow(
      AppError,
    );

    expect(fs.readdirSync(root)).toEqual([]);
  },
);

test.skipIf(!posix)(
  'a symlink at a managed directory refuses before anything is written below it',
  () => {
    for (const managed of ['sessions', path.join('sessions', 'remote-scripts')]) {
      const under = mkdtempForTestSync('state-admit-managed-link-');
      const root = makePrivateRoot(under);
      const outside = path.join(under, 'outside');
      fs.mkdirSync(outside, { mode: 0o700 });
      fs.mkdirSync(path.dirname(path.join(root, managed)), { recursive: true, mode: 0o700 });
      fs.symlinkSync(outside, path.join(root, managed));

      const details = refusalOf(() =>
        admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' }),
      );

      expect(details).toMatchObject({ problem: 'symlink', component: path.join(root, managed) });
      expect(fs.readdirSync(outside)).toEqual([]);
    }
  },
);

test.skipIf(!posix)(
  'a root another account owns refuses: /usr is root-owned, and a CI host cannot chown',
  () => {
    const details = refusalOf(() =>
      admitDaemonStateRoot({ paths: pathsOf('/usr'), mode: 'inspect' }),
    );

    expect(details).toMatchObject({ problem: 'foreign-owner', component: '/usr' });
  },
);

test.skipIf(!posix)(
  'a uid the state directory is not owned by refuses through the admission seam',
  () => {
    const under = mkdtempForTestSync('state-admit-uid-seam-');
    const root = makePrivateRoot(under);

    const details = refusalOf(() =>
      admitDaemonStateRoot({ paths: pathsOf(root), mode: 'inspect', uid: 4_294_967_295 }),
    );

    expect(details).toMatchObject({ problem: 'foreign-owner', component: root });
  },
);

test.skipIf(!posix)(
  'a root at mode 0755 or 0770 refuses as not private and names the chmod that ends it',
  () => {
    for (const mode of [0o755, 0o770]) {
      const under = mkdtempForTestSync('state-admit-mode-');
      const root = makePrivateRoot(under);
      fs.chmodSync(root, mode);

      const details = refusalOf(() =>
        admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' }),
      );

      expect(details).toMatchObject({ problem: 'not-private', component: root });
      expect(details.fix).toBe(`chmod 700 ${root}`);
    }
  },
);

test.skipIf(!posix)('a group-writable non-sticky ancestor refuses and creates nothing', () => {
  const under = mkdtempForTestSync('state-admit-ancestor-');
  const shared = path.join(under, 'shared');
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o770);
  const root = makePrivateRoot(shared);

  const details = refusalOf(() =>
    admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' }),
  );

  // An ancestor is named where the walk stands on it: the physical directory, which the spelled route reaches
  // through the system symlink on macOS.
  expect(details).toMatchObject({
    problem: 'group-or-other-writable-ancestor',
    component: path.join(fs.realpathSync(under), 'shared'),
  });
  expect(fs.existsSync(path.join(root, 'sessions'))).toBe(false);
});

test('a raw ".." in the configured state path is refused before any expansion', () => {
  for (const raw of ['/tmp/agent-device/../state', 'state/../other', '..']) {
    const details = refusalOf(() => resolveDaemonPaths(raw, { cwd: '/workspace' }));
    expect(details).toMatchObject({ problem: 'parent-step' });
    expect(String(details.fix)).toContain('..');
  }
});

test.skipIf(!posix)('inspect mode leaves an absent root and its managed directories absent', () => {
  const under = mkdtempForTestSync('state-admit-absent-');
  const root = path.join(under, 'absent');

  admitDaemonStateRoot({ paths: pathsOf(root), mode: 'inspect' });
  expect(fs.existsSync(root)).toBe(false);

  const existing = makePrivateRoot(under, 'existing');
  admitDaemonStateRoot({ paths: pathsOf(existing), mode: 'inspect' });
  expect(fs.existsSync(path.join(existing, 'sessions'))).toBe(false);
});

test.skipIf(!posix)('establish mode creates the root and each managed directory at 0700', () => {
  const under = mkdtempForTestSync('state-admit-establish-');
  const root = path.join(under, 'fresh');

  admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });

  for (const directory of [
    root,
    path.join(root, 'sessions'),
    path.join(root, 'sessions', 'remote-scripts'),
  ])
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
});

test.skipIf(!posix)('establish under umask 002 and umask 077 creates a usable 0700 root', () => {
  for (const mask of [0o002, 0o077]) {
    const under = mkdtempForTestSync('state-admit-umask-');
    const root = path.join(under, 'fresh');
    const previous = process.umask(mask);
    try {
      admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });
    } finally {
      process.umask(previous);
    }

    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    // Usable: the owner can still create the names it needs below the root it just made.
    fs.writeFileSync(path.join(root, 'daemon.json'), '{}');
    expect(fs.statSync(path.join(root, 'sessions')).mode & 0o777).toBe(0o700);
  }
});

test.skipIf(!posix)('a relative state dir is anchored to the captured cwd before admission', () => {
  const under = mkdtempForTestSync('state-admit-relative-');
  const paths = resolveDaemonPaths('relative-state', { cwd: under });

  admitDaemonStateRoot({ paths, mode: 'establish' });

  expect(paths.baseDir).toBe(path.join(under, 'relative-state'));
  expect(fs.statSync(paths.baseDir).mode & 0o777).toBe(0o700);
});

test.skipIf(!posix)(
  'a root below the system temp directory is admitted, through the system symlink on macOS',
  () => {
    // `mkdtempForTestSync` is under TMPDIR, whose route crosses `/var` -> `/private/var` on macOS.
    const under = mkdtempForTestSync('state-admit-temp-');
    const root = makePrivateRoot(under, 'temp-state');

    admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });
    admitDaemonStateRoot({ paths: pathsOf(root), mode: 'inspect' });

    expect(fs.lstatSync(root).isSymbolicLink()).toBe(false);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  },
);

test.skipIf(!posix)('a second establish adopts the root the first one created', () => {
  const under = mkdtempForTestSync('state-admit-second-');
  const root = path.join(under, 'raced');

  admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });
  admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });

  expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(root, 'sessions')).mode & 0o777).toBe(0o700);
});

test.skipIf(!posix)(
  'a root another starter creates while this one creates it is adopted, not refused',
  () => {
    const under = fs.realpathSync(mkdtempForTestSync('state-admit-race-'));
    const root = path.join(under, 'raced');
    // The race at the seam the code reads: this call's `mkdir` loses to a starter that made the directory
    // first, and what it then lstats is that winner.
    const realMkdir = fs.mkdirSync;
    let won = false;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike, options?: never) => {
      if (!won && String(target) === root) {
        won = true;
        realMkdir(root, { mode: 0o700 });
        fs.chmodSync(root, 0o700);
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      }
      return realMkdir(target as string, options);
    }) as typeof fs.mkdirSync);

    try {
      admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });
    } finally {
      vi.restoreAllMocks();
    }

    expect(won).toBe(true);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  },
);

test.skipIf(!posix)(
  'a root another starter creates at an open mode is refused rather than adopted',
  () => {
    const under = fs.realpathSync(mkdtempForTestSync('state-admit-race-open-'));
    const root = path.join(under, 'raced');
    const realMkdir = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike, options?: never) => {
      if (String(target) === root) {
        realMkdir(root, { mode: 0o755 });
        fs.chmodSync(root, 0o755);
      }
      return realMkdir(target as string, options);
    }) as typeof fs.mkdirSync);

    try {
      const details = refusalOf(() =>
        admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' }),
      );
      expect(details).toMatchObject({ problem: 'not-private', component: root });
    } finally {
      vi.restoreAllMocks();
    }
  },
);

test('windows admission checks only the path shape, on every host', () => {
  expect(windowsStatePathProblem(String.raw`C:\Users\you\.agent-device`)).toBe(false);
  expect(windowsStatePathProblem('D:/work/state')).toBe(false);
  for (const unsupported of [
    String.raw`\\server\share\state`,
    String.raw`\\?\C:\state`,
    String.raw`\\.\pipe\agent-device`,
    'C:state',
    'state',
    String.raw`\state`,
    String.raw`C:\a:b`,
  ])
    expect(windowsStatePathProblem(unsupported)).toBe(true);
});

// On Windows the mode bits answer nothing about accounts, so admission asks no privacy question there and
// touches no filesystem. The host is stood in for at the seam the rule reads.
function onWindowsHost<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  }
}

test.skipIf(!posix)(
  'a Windows host asks no privacy question, so a path no POSIX rule could judge is admitted',
  () => {
    // Owned by nobody on this host, unreachable, and relative to no cwd here: every one of those is a POSIX
    // question, so a Windows host asks only whether the shape is one it supports.
    const baseDir = String.raw`C:\Users\you\.agent-device`;
    const windowsPaths: DaemonPaths = {
      baseDir,
      infoPath: path.win32.join(baseDir, 'daemon.json'),
      lockPath: path.win32.join(baseDir, 'daemon.lock'),
      logPath: path.win32.join(baseDir, 'daemon.log'),
      allocationsDir: path.win32.join(baseDir, 'allocations'),
      sessionsDir: path.win32.join(baseDir, 'sessions'),
    };

    onWindowsHost(() =>
      admitDaemonStateRoot({ paths: windowsPaths, mode: 'establish', uid: 4_294_967_295 }),
    );

    // The host stood in for is gone, and no POSIX route reaches this spelling.
    expect(() => admitDaemonStateRoot({ paths: windowsPaths, mode: 'establish' })).toThrow(
      AppError,
    );
  },
);
