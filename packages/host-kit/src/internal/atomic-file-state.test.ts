// The daemon's OWN state directory: what it creates, what it repairs, and what it refuses to write into
// (#4649). A caller-named destination is judged by `atomic-file-ancestry.test.ts`; this suite is the other
// rule, the one that decides whether a directory the daemon picked for itself is private at all.
//
// It is the destination rule's own walk — the full route resolved one name at a time from `/`, with ADR
// 0016's link policy so an allowed system alias still answers — plus one question the destination rule does
// not ask: whether the directory a state entry is CREATED in is closed to entries from other local users.
import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FOREIGN_UID,
  ancestryRoot as root,
  directoryWith,
  modeOf,
  serveOwnership,
  withSharedUmask,
} from './atomic-file-host.fixtures.ts';
import {
  ensurePrivateDirectoryChain,
  judgePrivateDirectoryChain,
  privateDirectoryWordingOf,
} from './verified-file.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A state directory this test owns and trusts, at the mode the rule creates at. */
function stateDir(name = 'state'): string {
  return directoryWith(path.join(root(), name), 0o700);
}

// --- what it creates ---

skipOnWindows('creates a missing state chain at 0700 under the shared checkout umask', () => {
  // The umask a group-writable home directory carries. A mode-less `mkdir` here answers 0775, and the very
  // next startup would refuse that directory as writable by another local user — so a daemon on a shared
  // checkout would break its own state directory on every restart.
  const parent = directoryWith(path.join(root(), 'parent'), 0o700);
  const state = path.join(parent, 'state');

  withSharedUmask(() => {
    expect(ensurePrivateDirectoryChain(state, ['sessions']).exposure).toBeUndefined();
  });

  expect(modeOf(state)).toBe(0o700);
  expect(modeOf(path.join(state, 'sessions'))).toBe(0o700);
});

skipOnWindows('a state chain made under a umask that takes an OWNER bit is still usable', () => {
  // `mkdir` ANDs its mode with the umask, so a umask of 0277 leaves a 0700 request answering 0500: the daemon
  // could then create the name it came for and never read it back. The mode is said again after the create,
  // and for EVERY level this call made — the state directory and each name below it — because a chain whose
  // last level is usable and whose first one is not is a chain that cannot be written into at all.
  const parent = directoryWith(path.join(root(), 'parent'), 0o700);
  const state = path.join(parent, 'state');
  const sessions = path.join(state, 'sessions');

  const previous = process.umask(0o277);
  let created: string | undefined;
  try {
    const chain = ensurePrivateDirectoryChain(state, ['sessions']);
    created = chain.exposure ? undefined : chain.directory;
  } finally {
    process.umask(previous);
  }

  expect(created).toBe(sessions);
  expect(modeOf(state)).toBe(0o700);
  expect(modeOf(sessions)).toBe(0o700);
});

// --- what it repairs, and what a repair cannot reach ---

skipOnWindows('repairs a state level this user owns that stands loose', () => {
  // A state directory a host or an older build left world-writable is narrowed rather than refused: the
  // daemon owns this ground, and refusing to write its own leftover helps nobody.
  const state = directoryWith(path.join(root(), 'state'), 0o755);
  fs.chmodSync(state, 0o755);

  expect(ensurePrivateDirectoryChain(state).exposure).toBeUndefined();

  expect(modeOf(state)).toBe(0o700);
});

skipOnWindows('narrows a state directory the group can write, the shared checkout case', () => {
  // umask 002 is what a group-writable home directory carries, so this is the state directory a shared
  // checkout leaves behind. The group is other local users, so the daemon narrows what it owns instead of
  // refusing its own record.
  const state = directoryWith(path.join(root(), 'state'), 0o770);

  expect(ensurePrivateDirectoryChain(state).exposure).toBeUndefined();

  expect(modeOf(state)).toBe(0o700);
});

skipOnWindows('refuses a route whose ANCESTOR is loose, and never touches that ancestor', () => {
  // The full route is judged, so a state directory that is itself this process's own 0700 tree is still
  // refused when a level above it is open to other local users: an entry planted there redirects where the
  // state path lands. What it is NOT is repaired — a level above the state directory belongs to someone
  // else's layout, and a tool that quietly re-modes a host's directories has damaged that host while
  // meaning to protect one.
  const parent = directoryWith(path.join(root(), 'parent'), 0o777);
  const state = path.join(parent, 'state');

  const chain = ensurePrivateDirectoryChain(state);

  expect(chain.exposure).toBe('world_writable');
  expect(modeOf(parent)).toBe(0o777);
  expect(fs.existsSync(state)).toBe(false);
});

skipOnWindows('never repairs a level another local user owns', () => {
  // `chmod` on somebody else's directory is not this rule's to do, so the level keeps its mode AND its
  // refusal: the daemon will not write where it cannot say who else could have written.
  const state = stateDir();
  const theirs = directoryWith(path.join(state, 'sessions'), 0o755);
  serveOwnership({ [theirs]: FOREIGN_UID });

  const chain = ensurePrivateDirectoryChain(state, ['sessions']);

  expect(chain.exposure).toBe('foreign_owned');
  expect(modeOf(theirs)).toBe(0o755);
});

skipOnWindows(
  'refuses a state directory another local user can add a name to, and does not touch it',
  () => {
    // The destination rule lets a STICKY shared directory pass, because passing THROUGH one is safe there.
    // Here the daemon creates names of its own choosing in it, so another local user can plant the marker's
    // name or the shutdown report's name first, and a sticky bit does not stop that: it only stops them
    // replacing an entry they do not own. A directory root owns is also never narrowed by a non-root
    // process, which is why its mode has to come back unchanged.
    const state = directoryWith(path.join(root(), 'state'), 0o700);
    fs.chmodSync(state, 0o1777);
    serveOwnership({ [state]: 0 });

    const chain = ensurePrivateDirectoryChain(state);

    expect(chain.exposure).toBe('shared_parent');
    // `modeOf` answers the permission bits; the flag bit is what the rule never treats as a pass.
    expect(modeOf(state)).toBe(0o777);
    expect(fs.statSync(state).mode & 0o1000).toBe(0o1000);
  },
);

skipOnWindows('judges a level the group can add a name to as shared ground', () => {
  // Judged, not established: `ensure` narrows this user's own 0770, which its own case above asserts, and
  // `judge` creates and repairs nothing, so the shared mode is the answer it reports.
  const state = directoryWith(path.join(root(), 'state'), 0o770);

  expect(judgePrivateDirectoryChain(state).exposure).toBe('shared_group_writable');
});

skipOnWindows.for(['EPERM', 'EROFS', 'EACCES', 'ENOENT'])(
  'a repair that fails with %s never throws, and the loose mode stays the answer',
  (code) => {
    // Repair never decides whether a daemon starts: a read-only mount, an ACL-only filesystem, or a
    // directory that went between the look and the `fchmod` cost nothing but the narrowing. What the mode
    // still is stays the ANSWER, though — a state directory that could not be narrowed is still ground
    // another local user can reach, and the records that would land in it are what get refused.
    const state = directoryWith(path.join(root(), `state-${code}`), 0o777);
    // The seam a state repair uses is `fchmod` on a link-free descriptor; a mode said at a NAME would
    // follow a link planted there, which is the hole the descriptor closes.
    vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });

    expect(() => ensurePrivateDirectoryChain(state)).not.toThrow();

    expect(ensurePrivateDirectoryChain(state).exposure).toBe('world_writable');
    expect(modeOf(state)).toBe(0o777);
  },
);

skipOnWindows(
  'refuses a state directory whose NAME is a link, and never touches its target',
  () => {
    // The race the review named: the name a state directory stands at is replaced by a symbolic link. In the
    // destination rule ADR 0016 lets such a link through when only this user could have put it there; the state
    // rule asks more, because here the daemon CREATES records at the end of the route and NARROWS modes along
    // it. A link at the state directory would move both the records and the `chmod` to ground the caller never
    // named, so the refusal is about the link itself — and as a consequence no repair is attempted at all, and
    // the target keeps its mode without any descriptor being opened on it.
    const directory = root();
    const victim = path.join(directory, 'victim');
    fs.writeFileSync(victim, 'mine\n', { mode: 0o644 });
    fs.chmodSync(victim, 0o644);
    const state = path.join(directory, 'state');
    fs.symlinkSync(victim, state, 'dir');

    const chain = ensurePrivateDirectoryChain(state);

    expect(chain.exposure).toBe('planted_link');
    expect(fs.lstatSync(state).isSymbolicLink()).toBe(true);
    expect(modeOf(victim)).toBe(0o644);
  },
);

skipOnWindows('refuses a link at a level BELOW the state directory too', () => {
  // The line is drawn AT the state directory and everything under it, so an ancestor alias stays allowed and a
  // link inside the daemon's own tree does not. This is the same attack one level down: the record would land
  // on the link's target, and the mode repair would be said to it.
  const state = directoryWith(path.join(root(), 'state'), 0o700);
  const elsewhere = directoryWith(path.join(root(), 'elsewhere'), 0o700);
  fs.symlinkSync(elsewhere, path.join(state, 'sessions'), 'dir');

  const chain = ensurePrivateDirectoryChain(state, ['sessions']);

  expect(chain.exposure).toBe('planted_link');
  expect(fs.existsSync(elsewhere)).toBe(true);
});

skipOnWindows('a symbolic link in ground only this user can write is judged through', () => {
  // ADR 0016's link policy, which the state rule shares rather than tightens: a link is dangerous because
  // ANOTHER local user put it there, and in a 0700 directory only this user can put anything. Refusing every
  // link would refuse the default state path on macOS, where `/var` to `/private/var` is the alias every
  // state path rides through. The answer is the ground the walk arrived at, so the writer spells its entry
  // from where the bytes actually land.
  const directory = root();
  const real = directoryWith(path.join(directory, 'real'), 0o700);
  const alias = path.join(directory, 'alias');
  fs.symlinkSync(real, alias, 'dir');

  const chain = ensurePrivateDirectoryChain(path.join(alias, 'state'));

  expect(chain.exposure).toBeUndefined();
  expect(chain.directory).toBe(path.join(real, 'state'));
});

// --- the route it judges ---

skipOnWindows('judges the whole route, not just the directory it was handed', () => {
  // The first `lstat` of the state directory resolves every ancestor in one go, so a rule that started
  // there would trust an ancestor it never read. Here one ancestor is open to other local users, and the
  // answer has to say so even though the state directory itself is this process's own 0700 tree.
  const parent = directoryWith(path.join(root(), 'parent'), 0o700);
  const middle = directoryWith(path.join(parent, 'middle'), 0o777);
  const state = path.join(middle, 'state');

  const chain = judgePrivateDirectoryChain(state);

  expect(chain.exposure).toBe('world_writable');
});

skipOnWindows('refuses a symbolic link another local user could have planted on the route', () => {
  // The link stands in ground another local user can add a name to, so it is theirs to put there and
  // theirs to replace, and where the daemon's state would land is theirs to choose. Nothing is created at
  // the far end.
  const directory = root();
  const shared = directoryWith(path.join(directory, 'shared'), 0o1777);
  const elsewhere = directoryWith(path.join(directory, 'elsewhere'), 0o700);
  const link = path.join(shared, 'state');
  fs.symlinkSync(elsewhere, link, 'dir');
  serveOwnership({ [shared]: 0, [link]: FOREIGN_UID });

  const chain = ensurePrivateDirectoryChain(link, ['sessions']);

  expect(chain.exposure).toBe('planted_link');
  expect(fs.readdirSync(elsewhere)).toEqual([]);
});

skipOnWindows('refuses a state path that steps back out of the tree', () => {
  // The spelled chain says `state/sessions`; a `..` below it has no answer, because folding one away is
  // exactly what sends a state path OUTSIDE the state directory through a link — and the writer would then
  // be told about a directory it never named.
  const state = stateDir();
  const elsewhere = directoryWith(path.join(root(), 'elsewhere'), 0o700);
  fs.symlinkSync(elsewhere, path.join(state, 'sessions'), 'dir');

  const chain = judgePrivateDirectoryChain(`${state}/sessions`, ['..', 'escape']);

  expect(chain.exposure).toBe('outside_state_dir');
  expect(fs.existsSync(path.join(elsewhere, 'escape'))).toBe(false);
});

skipOnWindows('answers the resolved directory it judged, not the caller spelling', () => {
  // A doubled separator and a `.` are the kernel's own no-ops, so folding them is exactly what the kernel
  // does. The answer is what a writer spells its entry from, so it has to be the judged ground.
  const state = stateDir();
  const sessions = directoryWith(path.join(state, 'sessions'), 0o700);

  const chain = judgePrivateDirectoryChain(`${state}/sessions/.`);

  expect(chain.exposure).toBeUndefined();
  expect(chain.directory).toBe(sessions);
});

skipOnWindows('judging creates nothing, and reports a missing level', () => {
  const state = stateDir();

  const chain = judgePrivateDirectoryChain(state, ['sessions']);

  expect(chain.exposure).toBe('unreachable_parent');
  expect(fs.existsSync(path.join(state, 'sessions'))).toBe(false);
});

skipOnWindows('refuses a state directory that is a regular file', () => {
  const directory = root();
  const file = path.join(directory, 'state');
  fs.writeFileSync(file, 'not a directory\n');

  expect(ensurePrivateDirectoryChain(file).exposure).toBe('not_a_directory');
});

// --- ground this process cannot read at all ---

skipOnWindows.for(['EACCES', 'ENOTDIR', 'ELOOP'])(
  'a route that fails the lookup with %s is a typed refusal, not a thrown error',
  (code) => {
    // The daemon used to die here: `lstat` answers absence as "no entry" and lets these three escape, and
    // the first state write of a startup sat outside every handler. A state path the daemon cannot read is
    // a fact about the host, so it is one more exposure the caller reports and writes no record into.
    const state = stateDir();
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    expect(() => ensurePrivateDirectoryChain(state, ['sessions'])).not.toThrow();
    const expected =
      code === 'EACCES'
        ? 'state_dir_unreadable'
        : code === 'ENOTDIR'
          ? 'not_a_directory'
          : 'link_loop_exceeded';
    expect(ensurePrivateDirectoryChain(state, ['sessions']).exposure).toBe(expected);
  },
);

skipOnWindows(
  'an unreadable state directory is refused by name in the caller-facing wording',
  () => {
    const state = stateDir();
    vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });

    const chain = ensurePrivateDirectoryChain(state);

    expect(chain.exposure).toBe('state_dir_unreadable');
    expect(privateDirectoryWordingOf(chain.exposure!)).toMatch('AGENT_DEVICE_STATE_DIR');
  },
);

test('refuses a state path that is not absolute', () => {
  expect(ensurePrivateDirectoryChain('relative/state').exposure).toBe('outside_state_dir');
  expect(judgePrivateDirectoryChain(process.cwd(), ['..']).exposure).toBe('outside_state_dir');
});

test('refuses a state name that is not one plain name', () => {
  const state = stateDir();
  for (const name of ['', '.', '..', 'a/b', String.raw`a\b`]) {
    expect(judgePrivateDirectoryChain(state, [name]).exposure).toBe('outside_state_dir');
  }
});
