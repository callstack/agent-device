import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { FOREIGN_UID, mkdtempForTestSync, serveHostOwnership } from '@agent-device/test-kit';
import { admitDaemonStateRoot, resolveDaemonPaths, type DaemonPaths } from './daemon-resolution.ts';

const posix = process.platform !== 'win32';

/** The reason every refusal carries. It is in the user documentation and no production module reads it. */
const UNSAFE = 'daemon_state_root_unsafe';

// Ownership and mode-change fixtures are spies on `fs`, and one left standing becomes the next test's host, so
// each case starts from the real filesystem.
afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(details.reason).toBe(UNSAFE);
    return details;
  }
  throw new Error('expected an AppError refusal');
}

test.skipIf(!posix)(
  'a private populated root is admitted as it stands, and a repair changes nothing',
  () => {
    const under = mkdtempForTestSync('state-admit-populated-');
    const root = makePrivateRoot(under, 'populated');
    fs.mkdirSync(path.join(root, 'sessions', 'remote-scripts'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'daemon.json'), '{"pid":1}\n');
    fs.writeFileSync(path.join(root, 'sessions', 'journey.ad'), 'open com.example.app\n');
    fs.writeFileSync(path.join(root, 'sessions', 'remote-scripts', 'rec.ad'), 'tap\n');
    const before = fs.readdirSync(root).sort();

    admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });
    admitDaemonStateRoot({ paths: pathsOf(root), mode: 'repair' });

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

// Establish mode repairs an owned root that is open only through its own bits, so the partial-write rule needs
// a shape it still refuses: a root another account owns, where no mode change makes the ground private.
test.skipIf(!posix)(
  'a refused establish publishes no partial file and leaves no temporary sibling',
  () => {
    const under = fs.realpathSync(mkdtempForTestSync('state-admit-partial-'));
    const root = path.join(under, 'state');
    fs.mkdirSync(root);
    fs.chmodSync(root, 0o700);
    serveHostOwnership({ [root]: FOREIGN_UID });

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

// An unprivileged test process cannot `chown`, so ownership is moved at the `lstat` seam the rule reads: only
// the reported id moves, the mode and inode stay what is on disk. FOREIGN_UID is not the suite's own id even
// where CI runs the suite as `nobody`.
test.skipIf(!posix)(
  'a trailing separator on the spelling does not hide an unsafe root behind the link it points at',
  () => {
    // `lstat` resolves a final name that ends in a separator, so the root's OWN bits would go unjudged and
    // establish would create `sessions/` inside a directory somebody else chose.
    const under = fs.realpathSync(mkdtempForTestSync('state-admit-trailing-'));
    const outside = path.join(under, 'outside');
    fs.mkdirSync(outside, { mode: 0o700 });
    const link = path.join(under, 'linked');
    fs.symlinkSync(outside, link);

    for (const spelling of [`${link}/`, `${link}//`]) {
      const details = refusalOf(() =>
        admitDaemonStateRoot({ paths: pathsOf(spelling), mode: 'establish' }),
      );
      expect(details).toMatchObject({ problem: 'symlink' });
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  },
);

test.skipIf(!posix)(
  'a root another local account owns refuses, and so does one root owns but this user does not',
  () => {
    const under = mkdtempForTestSync('state-admit-foreign-');
    const root = makePrivateRoot(under, 'foreign-state');
    serveHostOwnership({ [root]: FOREIGN_UID });

    const details = refusalOf(() => admitDaemonStateRoot({ paths: pathsOf(root), mode: 'repair' }));

    expect(details).toMatchObject({ problem: 'foreign-owner', component: root });
  },
);

// `/usr` is a real root-owned directory: no fixture needed, but as root it is this process's own owner and the
// refusal that remains is the mode, so the assertion follows which account the suite runs under.
test.skipIf(!posix || process.getuid?.() === 0)(
  'a root owned by the superuser and not by this account refuses as a foreign owner',
  () => {
    const details = refusalOf(() =>
      admitDaemonStateRoot({ paths: pathsOf('/usr'), mode: 'repair' }),
    );

    expect(details).toMatchObject({ problem: 'foreign-owner', component: '/usr' });
  },
);

// The repair #4649 asks for: an owned, real, safely-rooted root that is open only through its OWN bits is made
// 0700 and admitted, on both modes. Neither mode creates anything below the root: the daemon makes its own names
// when it needs them, and a state directory the daemon does not write into stays empty.
test.skipIf(!posix)(
  'an owned root at mode 0755 or 0770 is repaired to 0700, and nothing is created below it',
  () => {
    for (const mode of [0o755, 0o770]) {
      const under = mkdtempForTestSync('state-admit-repair-');
      const root = makePrivateRoot(under, 'establish');
      fs.chmodSync(root, mode);

      admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });

      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      expect(fs.readdirSync(root)).toEqual([]);

      const open = makePrivateRoot(under, 'repair-only');
      fs.chmodSync(open, mode);

      admitDaemonStateRoot({ paths: pathsOf(open), mode: 'repair' });

      expect(fs.statSync(open).mode & 0o777).toBe(0o700);
      // A repair answers the one exposure that matters and leaves the rest of the root to its owner.
      expect(fs.readdirSync(open)).toEqual([]);
    }
  },
);

// A mode this user cannot change is not theirs to make private: the root stays as it stands and the refusal names
// the chmod that ends it. An unprivileged test process cannot refuse its own `chmod`, so the mode change is taken
// away at the seam the repair uses.
test.skipIf(!posix)('a root whose mode change is refused still refuses as not private', () => {
  const under = mkdtempForTestSync('state-admit-repair-refused-');
  const root = makePrivateRoot(under);
  fs.chmodSync(root, 0o755);
  const realChmod = fs.chmodSync;
  vi.spyOn(fs, 'chmodSync').mockImplementation((() => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  }) as typeof fs.chmodSync);

  try {
    const details = refusalOf(() =>
      admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' }),
    );
    expect(details).toMatchObject({ problem: 'not-private', component: root });
    expect(details.fix).toBe(`chmod 700 ${root}`);
  } finally {
    vi.restoreAllMocks();
    realChmod(root, 0o700);
  }
});

// The shape CI hit: the root is created by a writer that asks for nothing (a `mkdir` under the host's umask),
// and the launch that follows establishes it. The repair reaches the root's own name and no ancestor of it.
test.skipIf(!posix)(
  'a root a plain mkdir leaves at the umask default is repaired by the next establish',
  () => {
    const under = mkdtempForTestSync('state-admit-umask-created-');
    const parent = path.join(under, 'open-parent');
    fs.mkdirSync(parent);
    fs.chmodSync(parent, 0o755);
    const root = path.join(parent, 'state');
    const previous = process.umask(0o022);
    try {
      fs.mkdirSync(root);
    } finally {
      process.umask(previous);
    }
    expect(fs.statSync(root).mode & 0o777).toBe(0o755);

    admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });

    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(parent).mode & 0o777).toBe(0o755);
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

test.skipIf(!posix)('repair mode leaves an absent root and its managed directories absent', () => {
  const under = mkdtempForTestSync('state-admit-absent-');
  const root = path.join(under, 'absent');

  admitDaemonStateRoot({ paths: pathsOf(root), mode: 'repair' });
  expect(fs.existsSync(root)).toBe(false);

  const existing = makePrivateRoot(under, 'existing');
  admitDaemonStateRoot({ paths: pathsOf(existing), mode: 'repair' });
  expect(fs.existsSync(path.join(existing, 'sessions'))).toBe(false);
});

test.skipIf(!posix)('establish mode creates the root at 0700 and nothing below it', () => {
  const under = mkdtempForTestSync('state-admit-establish-');
  const root = path.join(under, 'fresh');

  admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });

  expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  // A root the daemon does not write into stays empty: `sessions/` arrives with the first session.
  expect(fs.readdirSync(root)).toEqual([]);
});

// A managed name is judged by the same rule as the root: a link at one is refused rather than written through,
// and one of this user that is merely open is closed, because the root's privacy is only as good as the names
// inside it.
test.skipIf(!posix)(
  'a managed name that exists is judged by the root rule, link refused and open mode closed',
  () => {
    const under = mkdtempForTestSync('state-admit-managed-existing-');
    const root = makePrivateRoot(under, 'managed');
    const sessions = path.join(root, 'sessions');
    fs.mkdirSync(sessions, { mode: 0o755 });

    admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });

    expect(fs.statSync(sessions).mode & 0o777).toBe(0o700);
  },
);

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
    fs.mkdirSync(path.join(root, 'sessions'));
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
    admitDaemonStateRoot({ paths: pathsOf(root), mode: 'repair' });

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
  'a root another starter creates at an open mode is repaired, not refused',
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
      // The winner is this user's own real directory that is merely open, so the same repair applies.
      admitDaemonStateRoot({ paths: pathsOf(root), mode: 'establish' });
    } finally {
      vi.restoreAllMocks();
    }
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  },
);

// Establish creates a missing root on every platform, because the launcher opens `daemon.log` in it next and
// nothing else makes the directory: a fresh Windows install, or a new AGENT_DEVICE_STATE_DIR, would otherwise fail
// with ENOENT. The spelling is drive-absolute as the shape rule asks, and this host reads it as a route below the
// working directory, so recursion through each name is what is actually on disk.
test.skipIf(!posix)(
  'on a Windows host establish creates a missing root recursively and repair creates nothing',
  () => {
    const under = fs.realpathSync(mkdtempForTestSync('state-admit-win32-'));
    const spelled = 'C:/state/nested';
    const created = path.resolve(under, 'C:', 'state', 'nested');
    const previousCwd = process.cwd();
    process.chdir(under);
    try {
      onWindowsHost(() => admitDaemonStateRoot({ paths: win32PathsFor(spelled), mode: 'repair' }));
      expect(fs.existsSync(path.resolve(under, 'C:'))).toBe(false);

      onWindowsHost(() =>
        admitDaemonStateRoot({ paths: win32PathsFor(spelled), mode: 'establish' }),
      );

      expect(fs.statSync(created).isDirectory()).toBe(true);
      // Exactly what the launcher does next: it opens the log at an absolute name, so the root must already
      // be there for this open not to throw ENOENT.
      const fd = fs.openSync(path.resolve(created, 'daemon.log'), 'a', 0o600);
      fs.writeSync(fd, 'ready\n');
      fs.closeSync(fd);
      expect(fs.readFileSync(path.join(created, 'daemon.log'), 'utf8')).toBe('ready\n');
    } finally {
      process.chdir(previousCwd);
    }
  },
);

/** The paths of a Windows state directory, built by the separator that host spells with. */
function win32PathsFor(baseDir: string): DaemonPaths {
  return {
    baseDir,
    infoPath: path.win32.join(baseDir, 'daemon.json'),
    lockPath: path.win32.join(baseDir, 'daemon.lock'),
    logPath: path.win32.join(baseDir, 'daemon.log'),
    allocationsDir: path.win32.join(baseDir, 'allocations'),
    sessionsDir: path.win32.join(baseDir, 'sessions'),
  };
}

/** Stands in for a Windows host at the seam the rule reads: `process.platform`. */
function onWindowsHost<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    return run();
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  }
}

// On Windows the mode bits answer nothing about accounts, so admission asks no privacy question there. A caller
// that creates nothing touches no filesystem at all: every path below is one this POSIX host could neither
// resolve nor judge.
test.skipIf(!posix)(
  'a Windows host admits a supported path shape and refuses an unsupported one, asking nothing of the disk',
  () => {
    for (const supported of [
      String.raw`C:\Users\you\.agent-device`,
      'D:/work/state',
      String.raw`E:\state`,
    ])
      onWindowsHost(() =>
        admitDaemonStateRoot({ paths: win32PathsFor(supported), mode: 'repair' }),
      );

    for (const unsupported of [
      String.raw`\\server\share\state`,
      String.raw`\\?\C:\state`,
      String.raw`\\.\pipe\agent-device`,
      'C:state',
      String.raw`C:\a:b`,
    ]) {
      const details = refusalOf(() =>
        onWindowsHost(() =>
          admitDaemonStateRoot({ paths: win32PathsFor(unsupported), mode: 'establish' }),
        ),
      );
      expect(details).toMatchObject({
        problem: 'unsupported-windows-path',
        fix: expect.stringContaining('drive-absolute'),
      });
    }
  },
);
