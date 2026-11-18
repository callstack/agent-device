// Whether a destination's parent can be RESOLVED at all, what host-kit creates on the way to it, and what
// a publish does when the walk stops short of it (#4565). Every name the path spells is resolved one step
// at a time the way the kernel walks it, so a `..` is only answerable once the directory it steps back
// from exists.
import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ancestryRoot as root,
  directoryWith,
  expectUntrusted,
  FOREIGN_UID,
  modeOf,
  publish,
  withSharedUmask,
} from './atomic-file-host.fixtures.ts';
import { confirmScriptDestination, prepareScriptDestination } from './atomic-file.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

afterEach(() => {
  vi.restoreAllMocks();
});

skipOnWindows(
  'refuses a destination that steps back out of a missing directory, and creates none',
  () => {
    // The walk ends at `missing`, with two steps up still queued. The kernel cannot apply them until
    // `missing` exists, while a recursive `mkdir` resolves the same spelling as text and builds
    // `<root>/shared/recordings` — a directory the walk never judged, where any local user can write. So a
    // destination that would be resolved by creating it is refused BEFORE anything is created, which is the
    // promise the docs make for a refused destination.
    const directory = root();
    const privateDir = directoryWith(path.join(directory, 'private'), 0o700);
    const shared = directoryWith(path.join(directory, 'shared'), 0o777);
    // Spelled by hand, because `path.join` folds a `..` away and the folded name is a DIFFERENT
    // destination: `<root>/shared/recordings`, which the kernel reaches without ever looking at `private`.
    const destination = `${privateDir}/missing/../../shared/recordings/journey.ad`;

    expectUntrusted(() => publish(destination), 'unresolvable_parent', privateDir);
    expectUntrusted(() => prepareScriptDestination(destination), 'unresolvable_parent', privateDir);
    expect(fs.readdirSync(privateDir)).toEqual([]);
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

skipOnWindows('accepts a destination that steps back over directories that all exist', () => {
  // The other half of the rule: a `..` the kernel CAN apply is applied, and the directory it lands in is
  // judged on its own. `here/nested` stands, so both steps up resolve and the sibling `there` is entered
  // and published into.
  const directory = root();
  const here = directoryWith(path.join(directory, 'here'), 0o700);
  fs.mkdirSync(path.join(here, 'nested'));
  const there = directoryWith(path.join(directory, 'there'), 0o700);

  publish(`${here}/nested/../../there/journey.ad`);

  expect(fs.readFileSync(path.join(there, 'journey.ad'), 'utf8')).toBe('context\n');
  expect(fs.readdirSync(here)).toEqual(['nested']);
});

skipOnWindows('creates a missing parent at 0700 on a shared umask and publishes into it', () => {
  // The shape that used to refuse itself: on a umask-002 host a mode-less `mkdir` makes the new parent
  // 0775, and the check that judges it then refuses the very directory the publish just created, with the
  // directory left behind. host-kit creates at 0700 and a recursive `mkdir` applies that mode to every
  // level it makes, so each new directory passes the check it is judged by.
  const home = directoryWith(path.join(root(), 'home'), 0o700);
  const recordings = path.join(home, 'workflows', 'recordings');
  const destination = path.join(recordings, 'journey.ad');

  withSharedUmask(() => publish(destination));

  expect(fs.readFileSync(destination, 'utf8')).toBe('context\n');
  expect(modeOf(path.join(home, 'workflows'))).toBe(0o700);
  expect(modeOf(recordings)).toBe(0o700);
});

skipOnWindows('creates a missing parent inside a sticky shared directory this user owns', () => {
  // `--save-script /tmp/recordings/journey.ad` with `recordings` absent. The sticky directory is passed
  // through, and the new level is this call's own at 0700. Asking whether others can create entries in
  // `tmp` BEFORE creating `recordings` would refuse the most ordinary destination there is.
  const tmp = directoryWith(path.join(root(), 'tmp'), 0o1777);
  const destination = path.join(tmp, 'recordings', 'journey.ad');

  publish(destination);

  expect(fs.readFileSync(destination, 'utf8')).toBe('context\n');
  expect(modeOf(path.join(tmp, 'recordings'))).toBe(0o700);
});

skipOnWindows('answers the created directory as the one to publish into', () => {
  // The creation call answers the directory the SECOND walk judged, spelled from that directory: under the
  // shared umask, that answer is what a caller that stages its own bytes must stage in.
  const home = directoryWith(path.join(root(), 'home'), 0o700);
  const destination = path.join(home, 'nested', 'deeper', 'journey.ad');

  let judged = '';
  withSharedUmask(() => {
    judged = prepareScriptDestination(destination).directory;
  });

  expect(judged).toBe(path.join(home, 'nested', 'deeper'));
  expect(modeOf(path.join(home, 'nested'))).toBe(0o700);
  expect(modeOf(judged)).toBe(0o700);
});

skipOnWindows('refuses a destination whose parent is gone by the time the answer is used', () => {
  // The one walk that creates is host-kit's own, so what this pins is the other half: an ANSWER is only
  // usable while the chain it named still stands. `missing` goes away after the answer was given, so there
  // is no directory the entry belongs in. Answering the nearest ancestor that did stand would write
  // `root/journey.ad` for a destination spelling `root/missing/journey.ad` — a file nobody asked for, in a
  // directory whose permissions were never what the answer promised.
  const directory = root();
  const missing = path.join(directory, 'missing');
  const destination = path.join(missing, 'journey.ad');
  const prepared = prepareScriptDestination(destination);

  fs.rmSync(missing, { recursive: true, force: true });

  expectUntrusted(
    () => confirmScriptDestination(destination, prepared),
    'unreachable_parent',
    directory,
  );
  expect(fs.readdirSync(directory)).toEqual([]);
});

skipOnWindows(
  'adopts a missing level another process created, and creates the rest below it',
  () => {
    // Two sessions saving into the same new directory meet HERE: one wins `mkdir`, and the other finds the
    // name taken. Refusing that (which an earlier shape did, with `entry_appeared`) made a routine
    // concurrent save fail. The appeared entry is therefore JUDGED the way every other step is judged, by
    // the single `lstat` of the name, and this user's own private directory is the ordinary answer (ADR 0016).
    const directory = root();
    const home = directoryWith(path.join(directory, 'home'), 0o700);
    const appeared = path.join(home, 'recordings');
    const realMkdirSync = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((pathname: unknown, ...rest: unknown[]) => {
      // The other process creates the level the instant this call reaches for the missing name.
      if (String(pathname) === appeared && !fs.existsSync(appeared)) {
        realMkdirSync(appeared, { mode: 0o700 });
      }
      return (realMkdirSync as (...args: unknown[]) => unknown)(pathname, ...rest);
    }) as typeof fs.mkdirSync);

    const destination = path.join(appeared, 'journey.ad');

    expect(prepareScriptDestination(destination).directory).toBe(appeared);
    publish(destination);
    expect(fs.readFileSync(path.join(appeared, 'journey.ad'), 'utf8')).toBe('context\n');
  },
);

skipOnWindows(
  'refuses a missing level that appeared as another user directory, and creates nothing below it',
  () => {
    // Judged, not trusted: an appeared name is NOT this call's creation, so it cannot be taken on faith
    // that it was made at the private mode. Ownership is asked of the same `lstat` the walk judges ground
    // with, and a directory another local user owns is theirs to repopulate or replace, whatever its mode.
    const directory = root();
    const home = directoryWith(path.join(directory, 'home'), 0o700);
    const appeared = path.join(home, 'recordings');
    const realMkdirSync = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((pathname: unknown, ...rest: unknown[]) => {
      if (String(pathname) === appeared && !fs.existsSync(appeared)) {
        realMkdirSync(appeared, { mode: 0o700 });
        fs.chmodSync(appeared, 0o700);
      }
      return (realMkdirSync as (...args: unknown[]) => unknown)(pathname, ...rest);
    }) as typeof fs.mkdirSync);
    // Seen as it appears, and judged foreign by the walk and by the creation alike.
    const seen = serveOwnership(appeared, FOREIGN_UID);

    const destination = path.join(appeared, 'journey.ad');

    expectUntrusted(() => prepareScriptDestination(destination), 'foreign_owned', appeared);
    expect(seen()).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(appeared, 'journey.ad'))).toBe(false);
  },
);

skipOnWindows(
  'refuses a missing level that appeared group-writable, rather than adopting it',
  () => {
    // The mode decides, because membership cannot be proven (ADR 0016): an appeared directory at 0775 is one
    // the group can add names in, so the destination's own name can be made there by another member first.
    const directory = root();
    const home = directoryWith(path.join(directory, 'home'), 0o700);
    const appeared = path.join(home, 'recordings');
    const realMkdirSync = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((pathname: unknown, ...rest: unknown[]) => {
      if (String(pathname) === appeared && !fs.existsSync(appeared)) {
        realMkdirSync(appeared, { mode: 0o775 });
        fs.chmodSync(appeared, 0o775);
      }
      return (realMkdirSync as (...args: unknown[]) => unknown)(pathname, ...rest);
    }) as typeof fs.mkdirSync);

    const destination = path.join(appeared, 'journey.ad');

    expectUntrusted(() => prepareScriptDestination(destination), 'shared_group_writable', appeared);
  },
);

skipOnWindows(
  'refuses a missing level that appeared sticky and world-writable, where any user can name the entry',
  () => {
    // The sticky bit is what lets the rule PASS THROUGH such a directory: it holds the entries already there
    // in place. It cannot refuse a NEW entry by name, so a level that appeared open to the world is refused
    // for the entry the destination spells, even though this user owns it.
    const directory = root();
    const home = directoryWith(path.join(directory, 'home'), 0o700);
    const appeared = path.join(home, 'recordings');
    const realMkdirSync = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((pathname: unknown, ...rest: unknown[]) => {
      if (String(pathname) === appeared && !fs.existsSync(appeared)) {
        realMkdirSync(appeared, { mode: 0o777 });
        fs.chmodSync(appeared, 0o1777);
      }
      return (realMkdirSync as (...args: unknown[]) => unknown)(pathname, ...rest);
    }) as typeof fs.mkdirSync);

    const destination = path.join(appeared, 'journey.ad');

    expectUntrusted(() => prepareScriptDestination(destination), 'shared_parent', appeared);
  },
);

/** Reports `uid` for one path from this point on, and how many times the rule looked at it. */
function serveOwnership(target: string, uid: number): () => number {
  const realLstatSync = fs.lstatSync.bind(fs);
  let looks = 0;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((pathname: unknown, ...rest: unknown[]) => {
    const stats = realLstatSync(pathname as never, ...(rest as never[]));
    if (String(pathname) !== target || stats === undefined) return stats;
    looks += 1;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid });
  }) as typeof fs.lstatSync);
  return () => looks;
}

skipOnWindows('refuses a missing level planted as a link, and creates nothing beyond it', () => {
  // The walk stops at `new`, which does not exist yet, so the parent it stopped in is sticky and open to
  // other local users adding names. In that window they can put a LINK at `new`: a recursive `mkdir`
  // resolves the whole tail as text and follows it, so the publish creates a directory on the far side of
  // a link nobody judged — and as root it would do so with privileges. Creating one name at a time inside
  // the directory this call established finds the name taken instead, and refuses.
  const directory = root();
  const sticky = directoryWith(path.join(directory, 'sticky'), 0o1777);
  const elsewhere = path.join(directory, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.chmodSync(elsewhere, 0o700);
  const planted = path.join(sticky, 'new');
  const realMkdirSync = fs.mkdirSync;
  vi.spyOn(fs, 'mkdirSync').mockImplementation(((pathname: unknown, ...rest: unknown[]) => {
    // The attacker plants the link the instant this call reaches for the missing name.
    if (String(pathname) === planted && !fs.existsSync(planted)) {
      fs.symlinkSync(elsewhere, planted);
    }
    return (realMkdirSync as (...args: unknown[]) => unknown)(pathname, ...rest);
  }) as typeof fs.mkdirSync);

  const destination = path.join(sticky, 'new', 'tail', 'journey.ad');

  expectUntrusted(() => prepareScriptDestination(destination), 'entry_appeared', planted);
  expect(fs.readdirSync(elsewhere)).toEqual([]);
  expect(fs.readdirSync(sticky)).toEqual(['new']);
});

test('refuses a destination that is not absolute on every platform, and creates nothing', () => {
  // Not skipped on Windows: there the ancestry walk is a no-op, so the walk that would otherwise catch a
  // relative name never runs, and a relative destination would reach `mkdir` outright. The check therefore
  // has to happen before the platform branch, which is what this test pins. Walking a relative name would
  // mean judging the process's working directory by the NAME Node answers after the last `chdir`, while the
  // kernel resolves the write in the moved one.
  const relative = path.join('recordings', 'journey.ad');

  expectUntrusted(
    () => prepareScriptDestination(relative),
    'relative_destination',
    path.join('recordings'),
  );
  // The confirm call refuses from the same check, before its platform branch: on Windows no walk runs at
  // all, so a relative name cannot be left to the walk to catch.
  expectUntrusted(
    () => confirmScriptDestination(relative, { directory: relative, identity: undefined }),
    'relative_destination',
    path.join('recordings'),
  );
  // Nothing was created for a destination that was refused at the entry.
  expect(fs.existsSync('recordings')).toBe(false);
});
