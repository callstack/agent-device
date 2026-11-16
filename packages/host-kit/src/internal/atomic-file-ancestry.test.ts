import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import {
  assertPrivateScriptDestination,
  othersCreateEntriesIn,
  publishDirectoryIdentity,
  publishScriptFileSync,
  untrustedAncestryExposure,
  untrustedLinkExposure,
  MAX_SCRIPT_PATH_LINK_HOPS,
  type DirectoryAuthority,
} from './atomic-file.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

/** The group database a test stands in for `/etc/group` and `/etc/passwd`. */
type Database = Readonly<{
  groups: readonly string[] | undefined;
  passwd: readonly string[] | undefined;
  /** `undefined` means "only files"; an empty array means "the file cannot be read". */
  nsswitch?: readonly string[] | undefined;
}>;

const realReadFileSync = fs.readFileSync;
/**
 * The account the fixture's databases name for this process. `readCurrentUser()` reads it from
 * `passwdFile` below, so the fixture and the rule agree without a second host lookup.
 */
const currentUser = process.env.USER ?? '';
/** The unmocked `stat` calls, so a second fixture here never wraps the first one's mock. */
const realLstatSync = fs.lstatSync.bind(fs);
const realStatSync = fs.statSync.bind(fs);

/** This process's ids. Windows has neither, and every test that uses them is skipped there. */
const currentUid = process.getuid?.() ?? -1;
const currentGid = process.getgid?.() ?? -1;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Serves `database` for the two group files and the real host for everything else, so the
 * private-group decision is the fixture's and not the CI image's user list.
 */
function serveGroupDatabase(database: Database): void {
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, options?: unknown) => {
    if (file === '/etc/group') {
      if (!database.groups) throw new Error('simulated unreadable group file');
      return `${database.groups.join('\n')}\n`;
    }
    if (file === '/etc/passwd') {
      if (!database.passwd) throw new Error('simulated unreadable passwd file');
      return `${database.passwd.join('\n')}\n`;
    }
    if (file === '/etc/nsswitch.conf') return nsswitchContents(database.nsswitch);
    return realReadFileSync(file as never, options as never) as never;
  }) as typeof fs.readFileSync);
}

/** The name-service lines of the fixture host: `files` only, unless the test asks for more. */
function nsswitchContents(sources: readonly string[] | undefined): string {
  if (sources === undefined) return 'passwd: files\ngroup: files\n';
  if (sources.length === 0) throw new Error('simulated unreadable nsswitch.conf');
  return `${sources.join('\n')}\n`;
}

/** This host's user with a group of their own, and a team group that holds someone else. */
function hostDatabase(privateGid: number, sharedGid: number): Database {
  return {
    groups: ['root:x:0:root', `${currentUser}:x:${privateGid}:`, `team:x:${sharedGid}:ada`],
    passwd: [`root:x:0:0`, `${currentUser}:x:${currentUid}:${privateGid}:`],
    nsswitch: undefined,
  };
}

/** The database of a host whose group files cannot be read at all. */
function unreadableDatabases(): Database {
  return { groups: undefined, passwd: undefined };
}

/**
 * Reports `owners` for the named paths and the real host for everything else, so the ownership rule is
 * the fixture's and not the CI image's directory tree. Only the ids move: modes and inode numbers stay
 * what they are on disk. A real foreign owner would need privileges this test does not have.
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

/** Some other local user, not this one and not root. */
const FOREIGN_UID = 65534;

function root(): string {
  return fs.realpathSync(mkdtempForTestSync('host-kit-ancestry-'));
}

/**
 * A directory carrying `mode` and `gid`, so the rule reads the group the test chose. The group is set
 * explicitly because a scratch directory inherits one from its parent, not necessarily this user's.
 */
function directoryWith(directory: string, mode: number, gid = currentGid): string {
  fs.mkdirSync(directory);
  fs.chownSync(directory, currentUid, gid);
  fs.chmodSync(directory, mode);
  return directory;
}

function publish(destination: string, parentIdentity?: string): void {
  publishScriptFileSync({
    destination,
    contents: 'context\n',
    ...(parentIdentity === undefined ? {} : { parentIdentity }),
  });
}

function expectUntrusted(run: () => void, exposure: string, ancestor: string): void {
  expectRefusal(run, 'script_ancestor_untrusted', exposure, ancestor);
}

function expectUntrustedReplaced(run: () => void, ancestor: string): void {
  expectRefusal(run, 'script_ancestry_replaced', 'parent_replaced', ancestor);
}

function expectRefusal(run: () => void, reason: string, exposure: string, ancestor: string): void {
  let details: Record<string, unknown> | undefined;
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    details = (error as AppError).details as Record<string, unknown>;
  }
  expect(details).toMatchObject({ reason, exposure, ancestor });
}

function modeOf(pathname: string): number {
  return fs.lstatSync(pathname).mode & 0o777;
}

// --- a directory another user owns, or that others can write, is refused ---

skipOnWindows('publishes to a chain only this user can write', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const workflows = path.join(root(), 'workflows');
  fs.mkdirSync(workflows);

  publish(path.join(workflows, 'journey.ad'));

  expect(fs.readFileSync(path.join(workflows, 'journey.ad'), 'utf8')).toBe('context\n');
});

skipOnWindows('creates the script so that only this user can read it', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const workflows = path.join(root(), 'workflows');
  fs.mkdirSync(workflows);
  const destination = path.join(workflows, 'journey.ad');

  publish(destination);

  expect(modeOf(destination)).toBe(0o600);
});

skipOnWindows('refuses a destination under a world-writable directory', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const shared = directoryWith(path.join(root(), 'shared'), 0o777);
  const destination = path.join(shared, 'journey.ad');

  expectUntrusted(() => publish(destination), 'world_writable', shared);
  expect(fs.existsSync(destination)).toBe(false);
});

skipOnWindows('refuses a destination created inside a directory others can add entries to', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const shared = directoryWith(path.join(root(), 'shared'), 0o777 | 0o1000);

  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(shared, 'journey.ad')),
    'shared_parent',
    shared,
  );
  expect(fs.existsSync(path.join(shared, 'journey.ad'))).toBe(false);
});

skipOnWindows('refuses a destination under a group-writable shared directory', () => {
  serveGroupDatabase(hostDatabase(4321, currentGid));
  const team = directoryWith(path.join(root(), 'team'), 0o775, currentGid);
  const sub = path.join(team, 'sub');
  fs.mkdirSync(sub);

  expectUntrusted(() => publish(path.join(sub, 'journey.ad')), 'shared_group_writable', team);
  expect(fs.readdirSync(sub)).toEqual([]);
});

// --- ownership decides, not the mode alone ---

skipOnWindows('refuses a directory another user owns, whatever the mode', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const work = directoryWith(path.join(root(), 'foreign'), 0o755);
  serveOwnership({ [work]: FOREIGN_UID });

  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(work, 'journey.ad')),
    'foreign_owned',
    work,
  );
});

skipOnWindows(
  'refuses a sticky directory another user owns, since both bits shield others from them',
  () => {
    serveGroupDatabase(hostDatabase(currentGid, 4321));
    // The reviewer's case: a teammate runs `chmod 1777` on a directory of THEIRS. The sticky bit keeps me
    // from deleting their entries; it does nothing to stop them replacing mine.
    const team = directoryWith(path.join(root(), 'team'), 0o1777);
    serveOwnership({ [team]: FOREIGN_UID });
    const work = path.join(team, 'work');
    fs.mkdirSync(work);

    expectUntrusted(
      () => assertPrivateScriptDestination(path.join(work, 'journey.ad')),
      'foreign_owned',
      team,
    );
  },
);

skipOnWindows(
  'refuses a recordings directory another local user created first in a sticky /tmp',
  () => {
    serveGroupDatabase(hostDatabase(currentGid, 4321));
    // `mkdir -p /tmp/recordings` is the shape: `/tmp` is sticky so nobody can touch anyone else's entry,
    // and whoever creates that directory first owns it. The owner can rename it aside and put their own in
    // place, whatever its mode says, so the destination has to be refused.
    const systemTmp = directoryWith(path.join(root(), 'tmp'), 0o1777);
    const recordings = path.join(systemTmp, 'recordings');
    fs.mkdirSync(recordings);
    fs.chmodSync(recordings, 0o755);
    serveOwnership({ [systemTmp]: 0, [recordings]: FOREIGN_UID });

    expectUntrusted(
      () => assertPrivateScriptDestination(path.join(recordings, 'journey.ad')),
      'foreign_owned',
      recordings,
    );
  },
);

skipOnWindows('refuses a link standing in a private-mode directory another user owns', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
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
    () => assertPrivateScriptDestination(path.join(teammate, 'link', 'journey.ad')),
    'foreign_owned',
    teammate,
  );
  expect(fs.readdirSync(mine)).toEqual([]);
});

skipOnWindows('refuses a private link standing on shared ground two levels up', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
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
    () => assertPrivateScriptDestination(path.join(mine, 'rec', 'journey.ad')),
    'world_writable',
    shared,
  );
  expect(fs.readdirSync(privateWork)).toEqual([]);
});

skipOnWindows('refuses a chain that leaves a shared directory through an intermediate link', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  // `~/rec -> /srv/team/relay`, and `relay` is a link back into a directory of mine. Every directory the
  // final chain names is trusted; the walk still passes through `/srv/team`, which the team can write,
  // and its owner — or any teammate — can swap `relay` for a target of their own.
  const directory = root();
  const home = path.join(directory, 'home');
  fs.mkdirSync(home);
  const srv = path.join(directory, 'srv');
  const team = path.join(srv, 'team');
  fs.mkdirSync(team, { recursive: true });
  fs.chmodSync(team, 0o777);
  const chosen = directoryWith(path.join(directory, 'chosen'), 0o700);
  fs.symlinkSync(chosen, path.join(team, 'relay'));
  fs.symlinkSync(path.join(team, 'relay'), path.join(home, 'rec'));

  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(home, 'rec', 'journey.ad')),
    'world_writable',
    team,
  );
  expect(fs.readdirSync(chosen)).toEqual([]);
});

skipOnWindows('judges the directory a .. steps back into', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  // `<root>/private/link` points at `<root>/elsewhere/dir`, and the caller spells `<private>/link/../x`.
  // The kernel walks `link` into its target and steps back from THERE, so the entry is created in
  // `<root>/elsewhere`, not in `<root>/private`. Normalizing the spelling first would answer
  // `<root>/private/x` and judge the wrong directory: `<elsewhere>` is open to others, `<private>` is not.
  const directory = root();
  const privateHome = directoryWith(path.join(directory, 'private'), 0o700);
  const elsewhere = directoryWith(path.join(directory, 'elsewhere'), 0o777);
  const dir = path.join(elsewhere, 'dir');
  fs.mkdirSync(dir);
  fs.symlinkSync(dir, path.join(privateHome, 'link'));

  expectUntrusted(
    () => assertPrivateScriptDestination(`${privateHome}/link/../x/journey.ad`),
    'world_writable',
    elsewhere,
  );
  expect(fs.readdirSync(dir)).toEqual([]);
});

skipOnWindows('refuses the ground under a link that leads into a shared directory', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
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
    () => assertPrivateScriptDestination(path.join(home, 'rec', 'journey.ad')),
    'world_writable',
    shared,
  );
  expect(fs.readdirSync(chosen)).toEqual([]);
});

skipOnWindows('refuses the spelled spelling of a link the walk also follows', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  // The same target reached two ways has to answer the same way: spelling the shared directory out is
  // refused, so arriving at it through a link cannot be accepted.
  const directory = root();
  const shared = directoryWith(path.join(directory, 'shared'), 0o777);
  const home = directoryWith(path.join(directory, 'home'), 0o700);
  const work = path.join(home, 'work');
  fs.mkdirSync(work);
  fs.symlinkSync(shared, path.join(home, 'rec'));

  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(home, 'rec', 'journey.ad')),
    'world_writable',
    shared,
  );
  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(shared, 'journey.ad')),
    'world_writable',
    shared,
  );
});

skipOnWindows('applies .. to the directory the walk is in, not to the spelling', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  // `home/work -> priv/x`, `priv/y` is open to others, `home/y` is private. A lexical simplification of
  // the spelling answers `home/y`, which is safe, so it accepts a write that lands in `priv/y`, where any
  // local user can take the file. The kernel steps into the link and steps back from its TARGET.
  const directory = root();
  const home = directoryWith(path.join(directory, 'home'), 0o700);
  const priv = directoryWith(path.join(directory, 'priv'), 0o700);
  const privX = path.join(priv, 'x');
  fs.mkdirSync(privX);
  const privY = directoryWith(path.join(priv, 'y'), 0o777);
  fs.mkdirSync(path.join(home, 'y'));
  fs.symlinkSync(privX, path.join(home, 'work'));

  expectUntrusted(
    () => assertPrivateScriptDestination(`${home}/work/../y/journey.ad`),
    'world_writable',
    privY,
  );
  expect(fs.readdirSync(privY)).toEqual([]);
});

skipOnWindows('refuses a link whose target stands in ground another local user owns', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
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
    () => assertPrivateScriptDestination(path.join(home, 'rec', 'journey.ad')),
    'planted_link',
    relay,
  );
  expect(fs.readdirSync(chosen)).toEqual([]);
});

skipOnWindows('follows a link whatever mode it carries, judging the directory it lands in', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
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
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const work = directoryWith(path.join(directory, 'work'), 0o700);
  const loop = path.join(work, 'loop');
  fs.symlinkSync(loop, loop);

  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(loop, 'journey.ad')),
    'link_loop_exceeded',
    loop,
  );
  expect(fs.readdirSync(work)).toEqual(['loop']);
});

skipOnWindows('follows exactly as many link hops as the walk allows, and refuses one more', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const work = directoryWith(path.join(directory, 'work'), 0o700);
  const real = directoryWith(path.join(directory, 'real'), 0o700);
  // `link0 -> link1 -> ... -> <real>`, so the walk expands `count` links to reach the destination.
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

  publish(path.join(chain(MAX_SCRIPT_PATH_LINK_HOPS), 'journey.ad'));
  expect(fs.existsSync(path.join(real, 'journey.ad'))).toBe(true);
  fs.rmSync(path.join(real, 'journey.ad'), { force: true });

  expectUntrusted(
    () =>
      assertPrivateScriptDestination(path.join(chain(MAX_SCRIPT_PATH_LINK_HOPS + 1), 'journey.ad')),
    'link_loop_exceeded',
    path.join(work, `link${MAX_SCRIPT_PATH_LINK_HOPS}`),
  );
  expect(fs.readdirSync(real)).toEqual([]);
});

skipOnWindows('refuses a path component that cannot carry a publish', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const work = directoryWith(path.join(directory, 'work'), 0o700);
  const blocker = path.join(work, 'blocker');
  fs.writeFileSync(blocker, 'not a directory\n');

  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(blocker, 'journey.ad')),
    'not_a_directory',
    blocker,
  );
});

skipOnWindows('refuses a directory its owner opened up while the file was staged', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const work = path.join(root(), 'work');
  fs.mkdirSync(work);
  const destination = path.join(work, 'journey.ad');
  const realWriteFileSync = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
    const result = (realWriteFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    fs.chmodSync(work, 0o777);
    return result;
  }) as typeof fs.writeFileSync);

  expectUntrusted(() => publish(destination), 'world_writable', work);
  expect(fs.readdirSync(work)).toEqual([]);
});

// --- the Ubuntu and Debian private-group home keeps working ---

skipOnWindows('publishes to a group-writable home directory of a private group', () => {
  const gid = currentGid;
  serveGroupDatabase(hostDatabase(gid, 4321));
  const home = directoryWith(path.join(root(), 'home'), 0o775, gid);

  publish(path.join(home, 'journey.ad'));

  expect(fs.readFileSync(path.join(home, 'journey.ad'), 'utf8')).toBe('context\n');
});

skipOnWindows("refuses the same mode and group once the group is not the user's own", () => {
  serveGroupDatabase(hostDatabase(4321, currentGid));
  const home = directoryWith(path.join(root(), 'home'), 0o775, currentGid);

  expectUntrusted(() => publish(path.join(home, 'journey.ad')), 'shared_group_writable', home);
});

skipOnWindows('refuses the same mode and group once the group database cannot be read', () => {
  serveGroupDatabase(unreadableDatabases());
  const home = directoryWith(path.join(root(), 'home'), 0o775, currentGid);

  expectUntrusted(() => publish(path.join(home, 'journey.ad')), 'shared_group_writable', home);
});

skipOnWindows('publishes to a setgid group-writable private-group home', () => {
  const gid = currentGid;
  serveGroupDatabase(hostDatabase(gid, 4321));
  const home = directoryWith(path.join(root(), 'home'), 0o2775, gid);

  publish(path.join(home, 'journey.ad'));

  expect(fs.existsSync(path.join(home, 'journey.ad'))).toBe(true);
});

// --- a link is judged as the link it is, and its target is judged too ---

skipOnWindows('follows a symbolic link inside a directory only this user can write', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const real = path.join(directory, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(directory, 'link'));

  publish(path.join(directory, 'link', 'journey.ad'));

  expect(fs.existsSync(path.join(real, 'journey.ad'))).toBe(true);
});

skipOnWindows('refuses a link planted in a directory others can add entries to', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  // The shared ground is refused where the walk enters it, one step before the link inside it: that
  // directory is itself the exposure, since anyone can rename `work` aside as well as plant it.
  const directory = root();
  const shared = directoryWith(path.join(directory, 'shared'), 0o777);
  const attacker = path.join(directory, 'attacker');
  fs.mkdirSync(attacker);
  fs.symlinkSync(attacker, path.join(shared, 'work'));

  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(shared, 'work', 'journey.ad')),
    'world_writable',
    shared,
  );
  expect(fs.readdirSync(attacker)).toEqual([]);
});

skipOnWindows('refuses a private link whose target chain is a shared directory', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  // `~/rec -> /srv/team/rec`, with `/srv/team` open to the team. The link itself is this user's own in
  // their own home, so nothing about it looks wrong; only the resolved chain shows the destination
  // would sit in ground the whole team can write.
  const directory = root();
  const home = path.join(directory, 'home');
  fs.mkdirSync(home);
  const srv = path.join(directory, 'srv');
  const team = path.join(srv, 'team');
  fs.mkdirSync(team, { recursive: true });
  fs.chmodSync(team, 0o777);
  const rec = path.join(team, 'rec');
  fs.mkdirSync(rec);
  fs.symlinkSync(rec, path.join(home, 'rec'));

  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(home, 'rec', 'journey.ad')),
    'world_writable',
    team,
  );
});

skipOnWindows('refuses a symbolic link whose target is a directory others can write', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const shared = directoryWith(path.join(directory, 'shared'), 0o777);
  const privateWork = path.join(shared, 'private');
  fs.mkdirSync(privateWork);
  fs.symlinkSync(privateWork, path.join(directory, 'link'));

  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(directory, 'link', 'journey.ad')),
    'world_writable',
    shared,
  );
});

skipOnWindows(
  'refuses a symbolic link another local user owns in a sticky shared directory',
  () => {
    serveGroupDatabase(hostDatabase(currentGid, 4321));
    // The link's OWNER is the whole question, so it is the fixture's: root holds the sticky directory and
    // somebody else owns the link. Moving only the caller's uid would decide the test by the accident of
    // who runs the suite, and would say nothing when the suite runs as root.
    const directory = root();
    const shared = directoryWith(path.join(directory, 'shared'), 0o1777);
    const attacker = path.join(directory, 'attacker');
    fs.mkdirSync(attacker);
    const link = path.join(shared, 'work');
    fs.symlinkSync(attacker, link);
    serveOwnership({ [shared]: 0, [link]: FOREIGN_UID });

    expectUntrusted(
      () => assertPrivateScriptDestination(path.join(shared, 'work', 'journey.ad')),
      'planted_link',
      link,
    );
    expect(fs.readdirSync(attacker)).toEqual([]);
  },
);

skipOnWindows('keeps working through a root-owned alias whose target is sticky', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const alias = path.join(directory, 'alias');
  const target = path.join(directory, 'target');
  fs.mkdirSync(target);
  fs.chmodSync(target, 0o1777);
  fs.symlinkSync(target, alias);
  const work = path.join(alias, 'work');
  fs.mkdirSync(work);
  fs.chmodSync(work, 0o700);

  publish(path.join(work, 'journey.ad'));

  expect(fs.existsSync(path.join(target, 'work', 'journey.ad'))).toBe(true);
});

skipOnWindows('publishes under the host root-owned system temporary directory', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
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
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  // The caller passes a path whose parent is a link, in a chain only this user can write. The alias
  // leads somewhere legal, so the publish follows it instead of refusing it.
  const directory = root();
  const real = path.join(directory, 'workflows');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(directory, 'current'));
  const destination = path.join(directory, 'current', 'journey.ad');

  publish(destination);

  expect(fs.readFileSync(path.join(real, 'journey.ad'), 'utf8')).toBe('context\n');
});

skipOnWindows('publishes to a scratch path exactly as the host spelled it', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  // The scratch root keeps the host's own spelling of its temporary directory: an alias on macOS, where
  // `/var` stands for `/private/var`, and no alias at all on Linux. Neither spelling may stop a publish,
  // so this asserts the outcome rather than what the host happens to name.
  const directory = mkdtempForTestSync('host-kit-ancestry-spelled-');
  const destination = path.join(directory, 'journey.ad');

  publish(destination);

  expect(fs.readFileSync(destination, 'utf8')).toBe('context\n');
});

// --- the destination directory swapped out while the file was staged ---

skipOnWindows('refuses a parent replaced by name while the file was staged', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const staged = path.join(directory, 'work');
  fs.mkdirSync(staged);
  const parentIdentity = publishDirectoryIdentity(staged);
  const destination = path.join(staged, 'journey.ad');
  // The replacement is a link to another real directory. Removing the directory and creating the same
  // name again is not enough to make the two differ: a filesystem may hand back the inode it just
  // freed, and the identity would match by luck.
  const elsewhere = path.join(directory, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.rmSync(staged, { recursive: true });
  fs.symlinkSync(elsewhere, staged);

  expectUntrustedReplaced(() => publish(destination, parentIdentity), staged);
  expect(fs.readdirSync(elsewhere)).toEqual([]);
});

skipOnWindows('re-checks the chain after staging the file, before the entry is created', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const staged = path.join(directory, 'work');
  fs.mkdirSync(staged);
  const destination = path.join(staged, 'journey.ad');
  const attacker = path.join(directory, 'attacker');
  fs.mkdirSync(attacker);
  const writeFileSync = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
    const result = (writeFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    // The directory the file was staged in is gone and its name is somebody else's now. A filesystem
    // hands back a freed inode, so the swap has to be to a directory that is really another one.
    fs.rmSync(staged, { recursive: true, force: true });
    fs.symlinkSync(attacker, staged);
    return result;
  }) as typeof fs.writeFileSync);

  expectUntrustedReplaced(() => publish(destination), staged);
  expect(fs.readdirSync(attacker)).toEqual([]);
});

skipOnWindows('publishes into the parent the captured identity still names', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const staged = path.join(root(), 'work');
  fs.mkdirSync(staged);

  publish(path.join(staged, 'journey.ad'), publishDirectoryIdentity(staged));

  expect(fs.existsSync(path.join(staged, 'journey.ad'))).toBe(true);
});

// --- untrustedAncestryExposure: what makes one directory unsafe to publish inside ---

const OWN = { uid: currentUid, gid: currentGid, mode: 0o755 };
const TRUST = { uid: currentUid, privateGid: currentGid };

function directoryOf(overrides: Partial<DirectoryAuthority>): DirectoryAuthority {
  return { ...OWN, ...overrides };
}

test('refuses a directory another user owns, whatever its mode', () => {
  expect(untrustedAncestryExposure(directoryOf({ uid: 65534, mode: 0o700 }), TRUST)).toBe(
    'foreign_owned',
  );
  expect(untrustedAncestryExposure(directoryOf({ uid: 65534, mode: 0o755 }), TRUST)).toBe(
    'foreign_owned',
  );
});

test('refuses a directory that is world-writable', () => {
  expect(untrustedAncestryExposure(directoryOf({ mode: 0o777 }), TRUST)).toBe('world_writable');
});

test('refuses a directory that is group-writable by a group that is not this user', () => {
  expect(untrustedAncestryExposure(directoryOf({ gid: 4321, mode: 0o775 }), TRUST)).toBe(
    'shared_group_writable',
  );
});

test('accepts a directory group-writable by this user', () => {
  expect(untrustedAncestryExposure(directoryOf({ mode: 0o775 }), TRUST)).toBeUndefined();
});

test('accepts a root-owned directory and a directory this user owns', () => {
  expect(untrustedAncestryExposure(directoryOf({ uid: 0 }), TRUST)).toBeUndefined();
  expect(untrustedAncestryExposure(directoryOf({}), TRUST)).toBeUndefined();
});

test('accepts a sticky directory this user or root owns for passing through', () => {
  expect(untrustedAncestryExposure(directoryOf({ uid: 0, mode: 0o1777 }), TRUST)).toBeUndefined();
  expect(untrustedAncestryExposure(directoryOf({ mode: 0o1777 }), TRUST)).toBeUndefined();
});

test('refuses a sticky directory another user owns, since both bits shield others FROM that owner', () => {
  expect(untrustedAncestryExposure(directoryOf({ uid: 65534, mode: 0o1777 }), TRUST)).toBe(
    'foreign_owned',
  );
  expect(untrustedAncestryExposure(directoryOf({ uid: 65534, mode: 0o2775 }), TRUST)).toBe(
    'foreign_owned',
  );
});

// --- untrustedLinkExposure: which link on the path belongs to somebody else ---

test('accepts a link in a directory only this user or root can add entries to', () => {
  const link = { uid: currentUid };
  expect(untrustedLinkExposure(link, directoryOf({ mode: 0o755 }), TRUST)).toBeUndefined();
  expect(untrustedLinkExposure(link, directoryOf({ mode: 0o775 }), TRUST)).toBeUndefined();
});

test('refuses a link in a shared directory unless the sticky bit and its owner hold it in place', () => {
  expect(untrustedLinkExposure({ uid: currentUid }, directoryOf({ mode: 0o777 }), TRUST)).toBe(
    'planted_link',
  );
  expect(untrustedLinkExposure({ uid: 65534 }, directoryOf({ mode: 0o1777 }), TRUST)).toBe(
    'planted_link',
  );
});

test('accepts a link this user or root owns in a sticky shared directory', () => {
  const sticky = directoryOf({ mode: 0o1777 });
  expect(untrustedLinkExposure({ uid: currentUid }, sticky, TRUST)).toBeUndefined();
  expect(untrustedLinkExposure({ uid: 0 }, sticky, TRUST)).toBeUndefined();
});

// --- othersCreateEntriesIn: where another local user could claim the entry ---

test('names a directory others can add entries in, sticky bit or no sticky bit', () => {
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o777 }), TRUST)).toBe(true);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o1777 }), TRUST)).toBe(true);
  expect(othersCreateEntriesIn(directoryOf({ gid: 4321, mode: 0o775 }), TRUST)).toBe(true);
});

test('names no directory whose group is this user', () => {
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o775 }), TRUST)).toBe(false);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o1775 }), TRUST)).toBe(false);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o755 }), TRUST)).toBe(false);
});

test('names a directory another user owns, whatever its mode', () => {
  expect(othersCreateEntriesIn(directoryOf({ uid: 65534, mode: 0o755 }), TRUST)).toBe(true);
  expect(othersCreateEntriesIn(directoryOf({ uid: 65534, mode: 0o1777 }), TRUST)).toBe(true);
});

test('names no directory this user or root owns that others cannot write', () => {
  expect(othersCreateEntriesIn(directoryOf({ uid: 0, mode: 0o755 }), TRUST)).toBe(false);
  expect(othersCreateEntriesIn(directoryOf({ uid: 0, mode: 0o1777 }), TRUST)).toBe(true);
});
