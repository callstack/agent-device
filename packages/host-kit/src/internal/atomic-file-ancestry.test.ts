import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  FOREIGN_UID,
  ancestryRoot as root,
  directoryWith,
  expectUntrusted,
  expectUntrustedReplaced,
  modeOf,
  publish,
} from './atomic-file-host.fixtures.ts';
import {
  confirmScriptDestination,
  prepareScriptDestination,
  MAX_SCRIPT_PATH_LINK_HOPS,
} from './atomic-file.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

/** The mode a test's own trusted ground stands at, so a runner's umask cannot widen it. */
const PRIVATE_DIR_MODE = 0o700;

/**
 * A directory this test owns and trusts, created at {@link PRIVATE_DIR_MODE} rather than at whatever umask the
 * runner carries. A mode-less `mkdir` under a permissive umask creates 0775, which the ancestry rule refuses for
 * a reason that has nothing to do with what the case is about.
 */
function privateDir(directory: string): string {
  fs.mkdirSync(directory, { mode: PRIVATE_DIR_MODE });
  fs.chmodSync(directory, PRIVATE_DIR_MODE);
  return directory;
}

/**
 * Where the rule says an entry is created, and nothing more.
 *
 * `prepareScriptDestination` is the call both routes make before they stage anything, so asking it is what a
 * route sees: it walks, judges, and answers the directory. Every ground this suite builds already stands, so
 * the creation it also owns never runs here.
 */
function judgedDirectory(destination: string): string {
  return prepareScriptDestination(destination).directory;
}

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

afterEach(() => {
  vi.restoreAllMocks();
});

/** The unmocked lookups, so serving an owner never wraps a previously served one. */
const realLstatSync = fs.lstatSync.bind(fs);
const realStatSync = fs.statSync.bind(fs);

/**
 * Reports `owners` for the named paths and the real host for everything else, so the ownership rule is
 * the fixture's and not the CI image's directory tree. Only the ids move: modes and inode numbers stay
 * what they are on disk. Both lookups are served, because the walk `lstat`s an entry to learn whether it
 * is a link and `stat`s the directory it stands in.
 */
function serveOwnership(owners: Readonly<Record<string, number>>): void {
  const withUid = (stats: fs.Stats, pathname: string): fs.Stats => {
    const uid = owners[pathname];
    if (uid === undefined || stats.uid === uid) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid }) as fs.Stats;
  };
  vi.spyOn(fs, 'lstatSync').mockImplementation(((pathname: never, ...rest: never[]) =>
    withUid(realLstatSync(pathname, ...rest), String(pathname))) as typeof fs.lstatSync);
  vi.spyOn(fs, 'statSync').mockImplementation(((pathname: never, ...rest: never[]) =>
    withUid(realStatSync(pathname, ...rest), String(pathname))) as typeof fs.statSync);
}

// --- a directory another user owns, or that others can write, is refused ---

skipOnWindows('publishes to a chain only this user can write', () => {
  const workflows = path.join(root(), 'workflows');
  privateDir(workflows);

  publish(path.join(workflows, 'journey.ad'));

  expect(fs.readFileSync(path.join(workflows, 'journey.ad'), 'utf8')).toBe('context\n');
});

skipOnWindows('creates the script so that only this user can read it', () => {
  const workflows = path.join(root(), 'workflows');
  privateDir(workflows);
  const destination = path.join(workflows, 'journey.ad');

  publish(destination);

  expect(modeOf(destination)).toBe(0o600);
});

skipOnWindows('publishes the script at 0600 under a umask that takes an OWNER bit away', () => {
  // `CREATE` answers the mode ANDed with the umask, so a host at 0277 leaves this recording 0400: the write
  // succeeds and nothing is a red flag, yet the owner's own tools cannot read the transcript they saved. A umask
  // that reaches into the owner bits is the one a mode on `writeFile` cannot survive. The rule says the mode.
  const workflows = path.join(root(), 'workflows');
  privateDir(workflows);
  const destination = path.join(workflows, 'journey.ad');
  const previous = process.umask(0o0277);
  try {
    publish(destination);
  } finally {
    process.umask(previous);
  }

  expect(modeOf(destination)).toBe(0o600);
});

skipOnWindows('refuses a destination under a world-writable directory', () => {
  const shared = directoryWith(path.join(root(), 'shared'), 0o777);
  const destination = path.join(shared, 'journey.ad');

  expectUntrusted(() => publish(destination), 'world_writable', shared);
  expect(fs.existsSync(destination)).toBe(false);
});

skipOnWindows('refuses a destination created inside a directory others can add entries to', () => {
  const shared = directoryWith(path.join(root(), 'shared'), 0o777 | 0o1000);

  expectUntrusted(() => judgedDirectory(path.join(shared, 'journey.ad')), 'shared_parent', shared);
  expect(fs.existsSync(path.join(shared, 'journey.ad'))).toBe(false);
});

skipOnWindows(
  'refuses to pass through a group-writable directory above the directory it creates',
  () => {
    // The unsafe part is the level this user does NOT create: `sub` is created at 0700 and is safe, and the
    // refusal still names `team` above it, because another member of that group can replace `sub` with one of
    // their own before the entry is written.
    const team = directoryWith(path.join(root(), 'team'), 0o775);
    const sub = path.join(team, 'sub');
    privateDir(sub);

    expectUntrusted(() => publish(path.join(sub, 'journey.ad')), 'shared_group_writable', team);
    expect(fs.readdirSync(sub)).toEqual([]);
  },
);

skipOnWindows(
  'passes through a directory this user owns that only its group can read and traverse',
  () => {
    // The counterpart on the mode alone: 0750 keeps the group out of WRITING, so nobody but this user can add
    // the name `sub` here, and the walk goes on down to the destination.
    const team = directoryWith(path.join(root(), 'team'), 0o750);
    const sub = path.join(team, 'sub');
    privateDir(sub);

    publish(path.join(sub, 'journey.ad'));

    expect(fs.existsSync(path.join(sub, 'journey.ad'))).toBe(true);
  },
);

// --- ownership decides, not the mode alone ---

skipOnWindows('refuses a directory another user owns, whatever the mode', () => {
  const work = directoryWith(path.join(root(), 'foreign'), 0o755);
  serveOwnership({ [work]: FOREIGN_UID });

  expectUntrusted(() => judgedDirectory(path.join(work, 'journey.ad')), 'foreign_owned', work);
});

skipOnWindows(
  'refuses a sticky directory another user owns, since both bits shield others from them',
  () => {
    // The reviewer's case: a teammate runs `chmod 1777` on a directory of THEIRS. The sticky bit keeps me
    // from deleting their entries; it does nothing to stop them replacing mine.
    const team = directoryWith(path.join(root(), 'team'), 0o1777);
    serveOwnership({ [team]: FOREIGN_UID });
    const work = path.join(team, 'work');
    privateDir(work);

    expectUntrusted(() => judgedDirectory(path.join(work, 'journey.ad')), 'foreign_owned', team);
  },
);

skipOnWindows(
  'refuses a recordings directory another local user created first in a sticky /tmp',
  () => {
    // `mkdir -p /tmp/recordings` is the shape: `/tmp` is sticky so nobody can touch anyone else's entry,
    // and whoever creates that directory first owns it. The owner can rename it aside and put their own in
    // place, whatever its mode says, so the destination has to be refused.
    const systemTmp = directoryWith(path.join(root(), 'tmp'), 0o1777);
    const recordings = path.join(systemTmp, 'recordings');
    privateDir(recordings);
    fs.chmodSync(recordings, 0o755);
    serveOwnership({ [systemTmp]: 0, [recordings]: FOREIGN_UID });

    expectUntrusted(
      () => judgedDirectory(path.join(recordings, 'journey.ad')),
      'foreign_owned',
      recordings,
    );
  },
);

skipOnWindows('refuses a link standing in a private-mode directory another user owns', () => {
  // The third input the reviewer names. `<root>/teammate` is theirs at 0755, `link` is a component of my
  // path, and the target is a directory of mine nothing could object to. Nothing about the target chain
  // looks wrong: the exposure is that the OWNER of the directory the link stands in can rename that
  // component and leave one of their own there, pointing wherever they like.
  const directory = root();
  const teammate = directoryWith(path.join(directory, 'teammate'), 0o755);
  serveOwnership({ [teammate]: FOREIGN_UID });
  const mine = directoryWith(path.join(directory, 'mine'), 0o700);
  fs.symlinkSync(mine, path.join(teammate, 'link'));

  expectUntrusted(
    () => judgedDirectory(path.join(teammate, 'link', 'journey.ad')),
    'foreign_owned',
    teammate,
  );
  expect(fs.readdirSync(mine)).toEqual([]);
});

skipOnWindows('refuses a private link standing on shared ground two levels up', () => {
  // `<root>/shared` is 0777 and not sticky, `<root>/shared/mine` is mine at 0700, and `mine/rec` is a
  // link to my private directory. The final chain is all mine, and the link stands in ground only I can
  // write, so neither the link rule nor the resolved-final-chain rule sees anything wrong. What they miss
  // is that another local user owns the ground `mine` and `rec` stand on: they rename `mine` aside and
  // put their own there, with a `rec` of their choosing.
  const directory = root();
  const shared = directoryWith(path.join(directory, 'shared'), 0o777);
  const mine = directoryWith(path.join(shared, 'mine'), 0o700);
  const privateWork = directoryWith(path.join(directory, 'private'), 0o700);
  fs.symlinkSync(privateWork, path.join(mine, 'rec'));

  expectUntrusted(
    () => judgedDirectory(path.join(mine, 'rec', 'journey.ad')),
    'world_writable',
    shared,
  );
  expect(fs.readdirSync(privateWork)).toEqual([]);
});

skipOnWindows('refuses a chain that leaves a shared directory through an intermediate link', () => {
  // `~/rec -> /srv/team/relay`, and `relay` is a link back into a directory of mine. Every directory the
  // final chain names is trusted; the walk still passes through `/srv/team`, which the team can write,
  // and its owner — or any teammate — can swap `relay` for a target of their own.
  const directory = root();
  const home = path.join(directory, 'home');
  privateDir(home);
  const srv = path.join(directory, 'srv');
  const team = path.join(srv, 'team');
  fs.mkdirSync(team, { recursive: true, mode: PRIVATE_DIR_MODE });
  fs.chmodSync(team, 0o777);
  const chosen = directoryWith(path.join(directory, 'chosen'), 0o700);
  fs.symlinkSync(chosen, path.join(team, 'relay'));
  fs.symlinkSync(path.join(team, 'relay'), path.join(home, 'rec'));

  expectUntrusted(
    () => judgedDirectory(path.join(home, 'rec', 'journey.ad')),
    'world_writable',
    team,
  );
  expect(fs.readdirSync(chosen)).toEqual([]);
});

skipOnWindows('judges the directory a .. steps back into', () => {
  // `<root>/private/link` points at `<root>/elsewhere/dir`, and the caller spells `<private>/link/../x`.
  // The kernel walks `link` into its target and steps back from THERE, so the entry is created in
  // `<root>/elsewhere`, not in `<root>/private`. Normalizing the spelling first would answer
  // `<root>/private/x` and judge the wrong directory: `<elsewhere>` is open to others, `<private>` is not.
  const directory = root();
  const privateHome = directoryWith(path.join(directory, 'private'), 0o700);
  const elsewhere = directoryWith(path.join(directory, 'elsewhere'), 0o777);
  const dir = path.join(elsewhere, 'dir');
  privateDir(dir);
  fs.symlinkSync(dir, path.join(privateHome, 'link'));

  expectUntrusted(
    () => judgedDirectory(`${privateHome}/link/../x/journey.ad`),
    'world_writable',
    elsewhere,
  );
  expect(fs.readdirSync(dir)).toEqual([]);
});

skipOnWindows('refuses the ground under a link that leads into a shared directory', () => {
  // `<root>/shared` is 0777 and not sticky, `<root>/home/rec` is a link spelled `shared/mine/relay/subdir`
  // whose `relay` is a link back into a private directory. Nothing at the destination looks wrong: the
  // final chain is `<root>/shared/mine/chosen/subdir`, and every one of those is private-looking. What
  // the walk sees is that getting there crossed `<root>/shared`, where any other local user can rename
  // `mine` aside and put their own `relay` under it.
  const directory = root();
  const shared = directoryWith(path.join(directory, 'shared'), 0o777);
  const mine = directoryWith(path.join(shared, 'mine'), 0o700);
  const chosen = directoryWith(path.join(directory, 'chosen'), 0o700);
  fs.symlinkSync(chosen, path.join(mine, 'relay'));
  const home = directoryWith(path.join(directory, 'home'), 0o700);
  fs.symlinkSync(path.join(shared, 'mine', 'relay', 'subdir'), path.join(home, 'rec'));

  expectUntrusted(
    () => judgedDirectory(path.join(home, 'rec', 'journey.ad')),
    'world_writable',
    shared,
  );
  expect(fs.readdirSync(chosen)).toEqual([]);
});

skipOnWindows(
  'refuses a link whose target is spelled relative to the directory that holds it',
  () => {
    // `ln -s ../team/rec rec` in a private home is the ordinary way a link gets written. The target is
    // resolved from the directory that HOLDS the link, so the walk leaves the home, crosses `shared` at
    // 0777, and arrives at the destination. Every directory of the answer is private-looking; the ground
    // crossed on the way is not.
    const directory = root();
    const shared = directoryWith(path.join(directory, 'shared'), 0o777);
    const mine = directoryWith(path.join(shared, 'mine'), 0o700);
    const chosen = directoryWith(path.join(directory, 'chosen'), 0o700);
    fs.symlinkSync(chosen, path.join(mine, 'relay'));
    const sub = path.join(chosen, 'sub');
    privateDir(sub);
    const home = directoryWith(path.join(directory, 'home'), 0o700);
    fs.symlinkSync(path.join('..', 'shared', 'mine', 'relay', 'sub'), path.join(home, 'rec'));

    expectUntrusted(
      () => judgedDirectory(path.join(home, 'rec', 'journey.ad')),
      'world_writable',
      shared,
    );
    expect(fs.readdirSync(sub)).toEqual([]);
  },
);

skipOnWindows(
  'stages the temp file inside the directory the walk judged, not the spelled parent',
  () => {
    // `work -> priv/x`, `priv/y` is private and `home/y` is open to others. The kernel walks `work` into its
    // target and steps back from THERE, so the entry is created in `priv/y`. `path.dirname` of the same
    // spelling answers `home/y`, so a publisher that stages beside the spelled parent writes its temp file
    // into ground the rule never judged — where anyone can list it and put their own bytes behind that name
    // before the rename. The staging directory has to be the walk's answer.
    const directory = root();
    const home = directoryWith(path.join(directory, 'home'), 0o700);
    const sharedY = directoryWith(path.join(home, 'y'), 0o777);
    const priv = directoryWith(path.join(directory, 'priv'), 0o700);
    const privX = path.join(priv, 'x');
    privateDir(privX);
    const privY = directoryWith(path.join(priv, 'y'), 0o700);
    fs.symlinkSync(privX, path.join(home, 'work'));
    const destination = `${home}/work/../y/journey.ad`;

    const staged: string[] = [];
    const realWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (typeof file === 'string') staged.push(path.dirname(file));
      return (realWriteFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.writeFileSync);
    publish(destination);

    expect(staged).toEqual([privY]);
    expect(fs.readFileSync(path.join(privY, 'journey.ad'), 'utf8')).toBe('context\n');
    expect(fs.readdirSync(sharedY)).toEqual([]);
  },
);

skipOnWindows(
  'judges every step from lstat alone, however many routes lead back to one directory',
  () => {
    // `a` and `b` are two names for ONE directory, and the spelling enters through `a`, steps back with `..`
    // and enters again through `b`, so the walk crosses `sub` twice and finishes below it. Where it ends is
    // the assertion that both routes were really taken: a walk that gave up on the second name would answer
    // `home` here instead.
    const directory = root();
    const home = directoryWith(path.join(directory, 'home'), 0o700);
    const sub = directoryWith(path.join(home, 'sub'), 0o700);
    const below = path.join(sub, 'below');
    privateDir(below);
    fs.symlinkSync(sub, path.join(home, 'a'));
    fs.symlinkSync(sub, path.join(home, 'b'));
    const lstatPaths: string[] = [];
    const realLstatSync = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((pathname: unknown, ...rest: unknown[]) => {
      lstatPaths.push(String(pathname));
      return (realLstatSync as (...args: unknown[]) => unknown)(pathname, ...rest);
    }) as typeof fs.lstatSync);
    const statPaths: string[] = [];
    const realStatSync = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((pathname: unknown, ...rest: unknown[]) => {
      statPaths.push(String(pathname));
      return (realStatSync as (...args: unknown[]) => unknown)(pathname, ...rest);
    }) as typeof fs.statSync);

    expect(judgedDirectory(`${home}/a/../b/below/journey.ad`)).toBe(below);

    // Every step is an `lstat` of the ENTRY. `stat` would resolve the same name a second time and answer
    // whatever stands there by then, which is the window the walk exists to close.
    expect(statPaths).toEqual([]);
    // Both aliases were followed, and the directory they name was judged on each route into it.
    expect(lstatPaths).toContain(path.join(home, 'a'));
    expect(lstatPaths).toContain(path.join(home, 'b'));
    expect(lstatPaths.filter((read) => read === sub)).toHaveLength(2);
  },
);

skipOnWindows(
  'refuses a destination that is not absolute, before judging or creating anything',
  () => {
    // Both routes hand host-kit an absolute path, so a relative name is refused at the entry rather than
    // emulated. Walking one would mean walking the process's working directory, whose NAME Node answers
    // from the first query after the last `chdir`: move that directory and a walk of the remembered
    // spelling judges the directory standing at the old path while the kernel resolves the name in the
    // moved one. Refusing at the entry keeps the stale-name question out of the rule entirely.
    const directory = root();
    const home = directoryWith(path.join(directory, 'home'), 0o700);
    const previous = process.cwd();
    try {
      process.chdir(home);

      expectUntrusted(() => publish('journey.ad'), 'relative_destination', '.');
      expectUntrusted(() => judgedDirectory('work/journey.ad'), 'relative_destination', 'work');
      // Refused at the entry, so nothing below the working directory was created either.
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      process.chdir(previous);
    }
  },
);

skipOnWindows('refuses a relative target that lands in ground others can write', () => {
  // The target names a plain name, and the directory it names is open to others. Spelling that directory
  // out is refused, so arriving at it through a link has to answer the same way.
  const home = directoryWith(path.join(root(), 'home'), 0o700);
  const open = directoryWith(path.join(home, 'open'), 0o777);
  fs.symlinkSync('open', path.join(home, 'rel'));

  expectUntrusted(
    () => judgedDirectory(path.join(home, 'rel', 'journey.ad')),
    'world_writable',
    open,
  );
  expect(fs.readdirSync(open)).toEqual([]);
});

skipOnWindows('applies a .. inside a target to the directory the walk reached', () => {
  // `rel -> priv/../x`. Folded as text, that is `home/x`, which is private and would be accepted. The
  // kernel steps into `priv`, which is itself a link into `shared/inside`, and applies `..` THERE: the
  // walk is standing in `shared`, and `x` is created in it.
  const directory = root();
  const home = directoryWith(path.join(directory, 'home'), 0o700);
  const shared = directoryWith(path.join(directory, 'shared'), 0o777);
  const inside = path.join(shared, 'inside');
  privateDir(inside);
  fs.symlinkSync(inside, path.join(home, 'priv'));
  // Spelled by hand: `path.join` would fold the `..` away before the link ever existed.
  fs.symlinkSync('priv/../x', path.join(home, 'rel'));

  expectUntrusted(
    () => judgedDirectory(path.join(home, 'rel', 'journey.ad')),
    'world_writable',
    shared,
  );
  expect(fs.readdirSync(shared)).toEqual(['inside']);
});

skipOnWindows('follows a relative target that stays inside ground only this user can write', () => {
  const directory = root();
  const home = directoryWith(path.join(directory, 'home'), 0o700);
  const real = directoryWith(path.join(directory, 'outside'), 0o700);
  fs.symlinkSync(path.join('..', 'outside'), path.join(home, 'rel'));

  publish(path.join(home, 'rel', 'journey.ad'));

  expect(fs.readFileSync(path.join(real, 'journey.ad'), 'utf8')).toBe('context\n');
});

skipOnWindows('refuses the spelled spelling of a link the walk also follows', () => {
  // The same target reached two ways has to answer the same way: spelling the shared directory out is
  // refused, so arriving at it through a link cannot be accepted.
  const directory = root();
  const shared = directoryWith(path.join(directory, 'shared'), 0o777);
  const home = directoryWith(path.join(directory, 'home'), 0o700);
  const work = path.join(home, 'work');
  privateDir(work);
  fs.symlinkSync(shared, path.join(home, 'rec'));

  expectUntrusted(
    () => judgedDirectory(path.join(home, 'rec', 'journey.ad')),
    'world_writable',
    shared,
  );
  expectUntrusted(() => judgedDirectory(path.join(shared, 'journey.ad')), 'world_writable', shared);
});

skipOnWindows('applies .. to the directory the walk is in, not to the spelling', () => {
  // `home/work -> priv/x`, `priv/y` is open to others, `home/y` is private. A lexical simplification of
  // the spelling answers `home/y`, which is safe, so it accepts a write that lands in `priv/y`, where any
  // local user can take the file. The kernel steps into the link and steps back from its TARGET.
  const directory = root();
  const home = directoryWith(path.join(directory, 'home'), 0o700);
  const priv = directoryWith(path.join(directory, 'priv'), 0o700);
  const privX = path.join(priv, 'x');
  privateDir(privX);
  const privY = directoryWith(path.join(priv, 'y'), 0o777);
  fs.mkdirSync(path.join(home, 'y'));
  fs.symlinkSync(privX, path.join(home, 'work'));

  expectUntrusted(() => judgedDirectory(`${home}/work/../y/journey.ad`), 'world_writable', privY);
  expect(fs.readdirSync(privY)).toEqual([]);
});

skipOnWindows('refuses a link whose target stands in ground another local user owns', () => {
  // `~/rec -> <root>/tmp/relay -> ~/chosen`, and `relay` is another user's file in a sticky shared
  // directory. Sticky or not, they can unlink it and put one of their own there, so the second hop is
  // theirs to choose. The judgment the expanded hop used to skip is the one on the link itself.
  const directory = root();
  const home = directoryWith(path.join(directory, 'home'), 0o700);
  const chosen = directoryWith(path.join(directory, 'chosen'), 0o700);
  const tmp = directoryWith(path.join(directory, 'tmp'), 0o1777);
  const relay = path.join(tmp, 'relay');
  fs.symlinkSync(chosen, relay);
  serveOwnership({ [tmp]: 0, [relay]: FOREIGN_UID });
  fs.symlinkSync(relay, path.join(home, 'rec'));

  expectUntrusted(
    () => judgedDirectory(path.join(home, 'rec', 'journey.ad')),
    'planted_link',
    relay,
  );
  expect(fs.readdirSync(chosen)).toEqual([]);
});

skipOnWindows('follows a link whatever mode it carries, judging the directory it lands in', () => {
  // A link's own mode means nothing for access: the kernel reads its target. An alias at 0777 leading to
  // a directory only this user can write is therefore safe, and the refusal has to come from the
  // directory, not from the link's bits.
  const directory = root();
  const real = directoryWith(path.join(directory, 'real'), 0o700);
  const alias = path.join(directory, 'current');
  fs.symlinkSync(real, alias);
  // `lchmod` on a link is what a mode-carrying alias looks like; where the host reports one mode for all
  // links, as Linux does, the walk has to be moved by the directory it lands in either way.
  try {
    fs.lchmodSync(alias, 0o777);
  } catch {
    /* this host gives every link the same mode */
  }

  publish(path.join(alias, 'journey.ad'));

  expect(fs.readFileSync(path.join(real, 'journey.ad'), 'utf8')).toBe('context\n');
});

skipOnWindows('refuses a link loop instead of trusting where the walk ran out', () => {
  const directory = root();
  const work = directoryWith(path.join(directory, 'work'), 0o700);
  const loop = path.join(work, 'loop');
  fs.symlinkSync(loop, loop);

  expectUntrusted(() => judgedDirectory(path.join(loop, 'journey.ad')), 'link_loop_exceeded', loop);
  expect(fs.readdirSync(work)).toEqual(['loop']);
});

skipOnWindows('follows thirty link hops, and refuses the thirty-first', () => {
  // Both counts are written out rather than derived from MAX_SCRIPT_PATH_LINK_HOPS, and the reason is
  // that a derived test cannot fail: a constant lowered from 30 to 29 rebuilds its own inputs and stays
  // green while every chain of 30 links that used to publish now refuses. The limit sits below what the
  // kernels apply themselves (macOS 32, Linux 40), so 30 is a number this rule owns — and the last line
  // is what ties the number written above to the one the walk enforces.
  const directory = root();
  const work = directoryWith(path.join(directory, 'work'), 0o700);
  const real = directoryWith(path.join(directory, 'real'), 0o700);
  // `link0 -> link1 -> ... -> <real>`: the walk expands `count` links to reach the destination.
  const chain = (count: number): string => {
    let next = real;
    for (let hop = count - 1; hop >= 0; hop -= 1) {
      const link = path.join(work, `link${hop}`);
      fs.rmSync(link, { force: true });
      fs.symlinkSync(next, link);
      next = link;
    }
    return next;
  };

  publish(path.join(chain(30), 'journey.ad'));
  expect(fs.existsSync(path.join(real, 'journey.ad'))).toBe(true);
  fs.rmSync(path.join(real, 'journey.ad'), { force: true });

  expectUntrusted(
    () => judgedDirectory(path.join(chain(31), 'journey.ad')),
    'link_loop_exceeded',
    path.join(work, 'link30'),
  );
  expect(fs.readdirSync(real)).toEqual([]);
  expect(MAX_SCRIPT_PATH_LINK_HOPS).toBe(30);
});

skipOnWindows('refuses a path component that cannot carry a publish', () => {
  const directory = root();
  const work = directoryWith(path.join(directory, 'work'), 0o700);
  const blocker = path.join(work, 'blocker');
  fs.writeFileSync(blocker, 'not a directory\n');

  expectUntrusted(
    () => judgedDirectory(path.join(blocker, 'journey.ad')),
    'not_a_directory',
    blocker,
  );
});

// --- a group-writable directory is refused, whoever owns the group (ADR 0016) ---

skipOnWindows('refuses a group-writable 0775 directory this user owns, with a hint', () => {
  // Ownership of the directory is not enough, because the GROUP can add the destination's name here first and
  // the mode bits cannot say who belongs to it. Reading /etc/group would not settle it either: systemd userdb
  // answers members those files never show. So the mode decides and the hint names the fix.
  const home = directoryWith(path.join(root(), 'home'), 0o775);
  let hint = '';
  try {
    publish(path.join(home, 'journey.ad'));
  } catch (error) {
    hint = String((error as AppError).details?.hint);
  }

  expectUntrusted(() => publish(path.join(home, 'journey.ad')), 'shared_group_writable', home);
  expect(hint).toContain(`chmod g-w ${home}`);
  expect(fs.readdirSync(home)).toEqual([]);
});

skipOnWindows('accepts the same directory once its group write bit is removed', () => {
  // The recovery the hint names, applied: `chmod g-w` leaves 0755, which shuts every other local user out of
  // creating the destination's name, whatever the group holds.
  const home = directoryWith(path.join(root(), 'home'), 0o775);
  fs.chmodSync(home, 0o755);

  publish(path.join(home, 'journey.ad'));

  expect(fs.readFileSync(path.join(home, 'journey.ad'), 'utf8')).toBe('context\n');
});

skipOnWindows('refuses a setgid group-writable directory', () => {
  // setgid changes who inherits the group, not who belongs to it, so it changes nothing here.
  const home = directoryWith(path.join(root(), 'home'), 0o2775);

  expectUntrusted(() => publish(path.join(home, 'journey.ad')), 'shared_group_writable', home);
});

/** The account databases a group-membership question would have to read, on Linux. */
const ACCOUNT_FILES = ['/etc/passwd', '/etc/group', '/etc/nsswitch.conf'];

skipOnWindows('judges a group-writable directory without reading the host account files', () => {
  // The whole reason the mode decides: the rule asks the kernel who owns a directory and what its bits say, and
  // reads nothing else. A test cannot accidentally reintroduce a host dependency, because the answer to these
  // three names is a failure. It also says why one destination answers the same on a macOS laptop, a container
  // and an Ubuntu runner with a private primary group.
  const read: string[] = [];
  const real = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((pathname: unknown, ...rest: unknown[]) => {
    const name = String(pathname);
    if (ACCOUNT_FILES.includes(name)) read.push(name);
    return (real as (...args: unknown[]) => unknown)(pathname, ...rest);
  }) as typeof fs.readFileSync);
  const home = directoryWith(path.join(root(), 'home'), 0o775);

  expectUntrusted(() => publish(path.join(home, 'journey.ad')), 'shared_group_writable', home);
  expect(read).toEqual([]);
});

// --- a link is judged as the link it is, and its target is judged too ---

skipOnWindows('follows a symbolic link inside a directory only this user can write', () => {
  const directory = root();
  const real = path.join(directory, 'real');
  privateDir(real);
  fs.symlinkSync(real, path.join(directory, 'link'));

  publish(path.join(directory, 'link', 'journey.ad'));

  expect(fs.existsSync(path.join(real, 'journey.ad'))).toBe(true);
});

skipOnWindows('refuses a link planted in a directory others can add entries to', () => {
  // The shared ground is refused where the walk enters it, one step before the link inside it: that
  // directory is itself the exposure, since anyone can rename `work` aside as well as plant it.
  const directory = root();
  const shared = directoryWith(path.join(directory, 'shared'), 0o777);
  const attacker = path.join(directory, 'attacker');
  privateDir(attacker);
  fs.symlinkSync(attacker, path.join(shared, 'work'));

  expectUntrusted(
    () => judgedDirectory(path.join(shared, 'work', 'journey.ad')),
    'world_writable',
    shared,
  );
  expect(fs.readdirSync(attacker)).toEqual([]);
});

skipOnWindows('refuses a private link whose target chain is a shared directory', () => {
  // `~/rec -> /srv/team/rec`, with `/srv/team` open to the team. The link itself is this user's own in
  // their own home, so nothing about it looks wrong; only the resolved chain shows the destination
  // would sit in ground the whole team can write.
  const directory = root();
  const home = path.join(directory, 'home');
  privateDir(home);
  const srv = path.join(directory, 'srv');
  const team = path.join(srv, 'team');
  fs.mkdirSync(team, { recursive: true, mode: PRIVATE_DIR_MODE });
  fs.chmodSync(team, 0o777);
  const rec = path.join(team, 'rec');
  privateDir(rec);
  fs.symlinkSync(rec, path.join(home, 'rec'));

  expectUntrusted(
    () => judgedDirectory(path.join(home, 'rec', 'journey.ad')),
    'world_writable',
    team,
  );
});

skipOnWindows('refuses a symbolic link whose target is a directory others can write', () => {
  const directory = root();
  const shared = directoryWith(path.join(directory, 'shared'), 0o777);
  const privateWork = path.join(shared, 'private');
  privateDir(privateWork);
  fs.symlinkSync(privateWork, path.join(directory, 'link'));

  expectUntrusted(
    () => judgedDirectory(path.join(directory, 'link', 'journey.ad')),
    'world_writable',
    shared,
  );
});

skipOnWindows(
  'refuses a symbolic link another local user owns in a sticky shared directory',
  () => {
    // The link's OWNER is the whole question, so it is the fixture's: root holds the sticky directory and
    // somebody else owns the link. Moving only the caller's uid would decide the test by the accident of
    // who runs the suite, and would say nothing when the suite runs as root.
    const directory = root();
    const shared = directoryWith(path.join(directory, 'shared'), 0o1777);
    const attacker = path.join(directory, 'attacker');
    privateDir(attacker);
    const link = path.join(shared, 'work');
    fs.symlinkSync(attacker, link);
    serveOwnership({ [shared]: 0, [link]: FOREIGN_UID });

    expectUntrusted(
      () => judgedDirectory(path.join(shared, 'work', 'journey.ad')),
      'planted_link',
      link,
    );
    expect(fs.readdirSync(attacker)).toEqual([]);
  },
);

skipOnWindows('keeps working through a root-owned alias whose target is sticky', () => {
  // The `/tmp` shape with every ownership the real one has: the alias stands in a sticky directory ANY
  // local user may add names in, and both that directory and the link belong to root. An alias owned by
  // whoever runs the suite would still pass a rule that refused EVERY root-owned link, which is the
  // macOS `/tmp` to `/private/tmp` shape this case exists to keep working.
  const directory = root();
  const shared = directoryWith(path.join(directory, 'tmp'), 0o1777);
  const target = path.join(directory, 'private-tmp');
  privateDir(target);
  fs.chmodSync(target, 0o1777);
  const alias = path.join(shared, 'alias');
  fs.symlinkSync(target, alias);
  const work = path.join(alias, 'work');
  privateDir(work);
  fs.chmodSync(work, 0o700);
  serveOwnership({ [shared]: 0, [alias]: 0, [target]: 0, [work]: 0 });

  publish(path.join(work, 'journey.ad'));

  expect(fs.readFileSync(path.join(target, 'work', 'journey.ad'), 'utf8')).toBe('context\n');
});

skipOnWindows('publishes under the host root-owned system temporary directory', () => {
  // macOS reaches `/private/tmp` through `/tmp`, Linux mounts `/tmp` directly. Both are sticky and
  // root-owned, and the script is created in a private directory under it, so neither spelling may
  // stop the publish.
  const work = fs.mkdtempSync('/tmp/agent-device-ancestry-');
  fs.chmodSync(work, 0o700);
  const destination = path.join(work, 'journey.ad');
  try {
    publish(destination);
    expect(fs.readFileSync(destination, 'utf8')).toBe('context\n');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

skipOnWindows('publishes to a path spelled through an alias of the directory that holds it', () => {
  // The caller passes a path whose parent is a link, in a chain only this user can write. The alias
  // leads somewhere legal, so the publish follows it instead of refusing it.
  const directory = root();
  const real = path.join(directory, 'workflows');
  privateDir(real);
  fs.symlinkSync(real, path.join(directory, 'current'));
  const destination = path.join(directory, 'current', 'journey.ad');

  publish(destination);

  expect(fs.readFileSync(path.join(real, 'journey.ad'), 'utf8')).toBe('context\n');
});

skipOnWindows('publishes to a scratch path exactly as the host spelled it', () => {
  // The scratch root keeps the host's own spelling of its temporary directory: an alias on macOS, where
  // `/var` stands for `/private/var`, and no alias at all on Linux. Neither spelling may stop a publish,
  // so this asserts the outcome rather than what the host happens to name.
  const directory = mkdtempForTestSync('host-kit-ancestry-spelled-');
  const destination = path.join(directory, 'journey.ad');

  publish(destination);

  expect(fs.readFileSync(destination, 'utf8')).toBe('context\n');
});

// --- the destination directory swapped out while the file was staged ---

// Only a caller that holds an answer from an earlier walk confirms it: the remote client does, because a
// download runs between the walk that judged the directory and the rename that creates the entry. The local
// publisher asks for no comparison of its own - the ownership rule is what excludes anyone who could make
// that swap - so these two cover the one comparison this rule keeps.

skipOnWindows('refuses a parent replaced by name while the file was staged', () => {
  const directory = root();
  const staged = path.join(directory, 'work');
  privateDir(staged);
  const destination = path.join(staged, 'journey.ad');
  const prepared = prepareScriptDestination(destination);
  // The replacement is a link to another real directory. Removing the directory and creating the same name
  // again is not enough to make the two differ: a filesystem may hand back the inode it just freed, and the
  // identity would match by luck.
  const elsewhere = path.join(directory, 'elsewhere');
  privateDir(elsewhere);
  fs.rmSync(staged, { recursive: true });
  fs.symlinkSync(elsewhere, staged);

  // The refusal names the directory the entry would really have been created in, which is where the link
  // leads. The spelled name is a pointer, not a place.
  expectUntrustedReplaced(() => confirmScriptDestination(destination, prepared), elsewhere);
  expect(fs.existsSync(path.join(elsewhere, 'journey.ad'))).toBe(false);
});

skipOnWindows(
  'confirms the directory an earlier answer named, and reports where to create the entry',
  () => {
    const directory = root();
    const staged = path.join(directory, 'work');
    privateDir(staged);
    const destination = path.join(staged, 'journey.ad');
    const prepared = prepareScriptDestination(destination);

    expect(confirmScriptDestination(destination, prepared)).toBe(staged);
  },
);

// --- a step swapped out while the walk is still running ---

skipOnWindows(
  'identifies an entry by its bigint inode, so two large inodes do not collapse',
  () => {
    // Directory identities are compared for equality by `confirmScriptDestination`, so they are read as
    // BIGINT. A numeric `ino` cannot hold every inode a filesystem hands out: 2^53 + 1 and 2^53 answer the
    // same Number, and a swap between the two would then look like the same directory.
    const directory = root();
    const home = directoryWith(path.join(directory, 'home'), 0o700);
    const work = path.join(home, 'work');
    privateDir(work);
    const LOW = 2n ** 53n;
    const realLstatSync = fs.lstatSync;
    let look = 0;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((pathname: unknown, options?: unknown) => {
      const stats = (realLstatSync as (...args: unknown[]) => unknown)(
        pathname,
        options,
      ) as fs.Stats;
      if (String(pathname) !== work) return stats;
      // Two distinct entries, one per look: the inode the walk answers, then the one the name holds when
      // the staged version is confirmed.
      const ino = look++ === 0 ? LOW : LOW + 1n;
      const bigint = (options as { bigint?: boolean } | undefined)?.bigint === true;
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
        ino: bigint ? ino : Number(ino),
      });
    }) as typeof fs.lstatSync);

    // A numeric read would answer Number(2^53 + 1n) === Number(2^53n), and the swap would pass.
    expect(Number(LOW + 1n)).toBe(Number(LOW));
    const destination = path.join(work, 'journey.ad');
    const prepared = prepareScriptDestination(destination);
    expectUntrustedReplaced(() => confirmScriptDestination(destination, prepared), work);
  },
);
