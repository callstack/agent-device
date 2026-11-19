// The state-file owners (#4649): the one append, the one publish, and the one read that every daemon and
// client route goes through. What each one refuses, and what a refusal costs, is the subject; the chain rule
// itself is `verified-file-state-dir.test.ts`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  FOREIGN_UID,
  ancestryRoot as root,
  directoryWith,
  modeOf,
  serveOwnership,
} from './atomic-file-host.fixtures.ts';
import {
  appendPrivateStateFileSync,
  ensurePrivateDirectoryChain,
  publishPrivateStateFileSync,
  type PrivateDirectoryChain,
  readPrivateStateFileTailSync,
  tryOpenPrivateStateFileSync,
  type PrivateStateOpenPurpose,
  type PrivateStateRead,
  writePrivateStateLineSync,
} from './verified-file.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

afterEach(() => {
  vi.restoreAllMocks();
});

/** The state directory this suite writes into: this user's own, at the mode the rule creates. */
function stateDir(name = 'state'): string {
  return directoryWith(path.join(root(), name), 0o700);
}

// --- the append ---

skipOnWindows('appends a record a caller can read back, and creates it at 0600', () => {
  const marker = path.join(stateDir(), 'daemon-startup-phases-1.jsonl');
  const previous = process.umask(0o022);
  try {
    appendPrivateStateFileSync(marker, '{"a":1}\n');
    appendPrivateStateFileSync(marker, '{"a":2}\n');
  } finally {
    process.umask(previous);
  }

  expect(modeOf(marker)).toBe(0o600);
  expect(fs.readFileSync(marker, 'utf8')).toBe('{"a":1}\n{"a":2}\n');
});

skipOnWindows('an append after a crashed one glues the seam instead of joining two records', () => {
  // A crash mid-append can leave a half-written line with no newline. Appending straight onto it makes BOTH
  // lines unparsable, so the writer looks at the last byte and pays for a newline when one is missing.
  const marker = path.join(stateDir(), 'daemon-startup-phases-2.jsonl');
  fs.writeFileSync(marker, '{"data":{"startupPhase":"modules-lo', { mode: 0o600 });

  appendPrivateStateFileSync(marker, '{"data":{"startupPhase":"listening"}}\n');

  expect(fs.readFileSync(marker, 'utf8')).toBe(
    '{"data":{"startupPhase":"modules-lo\n{"data":{"startupPhase":"listening"}}\n',
  );
});

skipOnWindows('an append reaches the entry, never a link planted at its name', () => {
  // Another local user who can write the state directory picks the marker's name. An `appendFile` would
  // resolve that name and write into THEIRS.
  const state = stateDir();
  const outside = path.join(state, 'theirs.log');
  fs.writeFileSync(outside, 'theirs\n', { mode: 0o600 });
  const marker = path.join(state, 'daemon-startup-phases-3.jsonl');
  fs.symlinkSync(outside, marker);

  expect(() => appendPrivateStateFileSync(marker, '{"a":1}\n')).toThrow(/regular file/i);

  expect(fs.readFileSync(outside, 'utf8')).toBe('theirs\n');
  expect(fs.lstatSync(marker).isSymbolicLink()).toBe(true);
});

skipOnWindows('a refusal says so typed, and names the state directory it refused', () => {
  const state = path.join(root(), 'loose');
  directoryWith(state, 0o777);

  try {
    appendPrivateStateFileSync(path.join(state, 'marker.jsonl'), '{}\n');
    expect.unreachable('a world-writable state directory is refused');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).details).toMatchObject({
      reason: 'state_dir_untrusted',
      exposure: 'world_writable',
    });
  }
});

skipOnWindows('an append lands in the directory the chain judged, not the caller spelling', () => {
  // `state/alias` is a link this user's own 0700 directory holds, so the walk judges through it (ADR 0016)
  // and the entry has to land beside the target, where the bytes actually go. Staging beside the SPELLING
  // would put a state file, or its temporary sibling, in ground the judgment never read.
  const directory = root();
  const real = directoryWith(path.join(directory, 'real'), 0o700);
  const state = directoryWith(path.join(real, 'state'), 0o700);
  const alias = path.join(directory, 'alias');
  fs.symlinkSync(real, alias, 'dir');

  appendPrivateStateFileSync(path.join(alias, 'state', 'marker.jsonl'), '{}\n');

  expect(fs.readdirSync(state)).toEqual(['marker.jsonl']);
});

// --- the publish ---

skipOnWindows('publishing replaces a link at the name instead of writing through it', () => {
  const state = stateDir();
  const outside = path.join(state, 'theirs.json');
  fs.writeFileSync(outside, 'theirs\n', { mode: 0o600 });
  const report = path.join(state, 'daemon-shutdown.json');
  fs.symlinkSync(outside, report);

  publishPrivateStateFileSync(report, '{"a":1}\n');

  expect(fs.readFileSync(outside, 'utf8')).toBe('theirs\n');
  expect(fs.lstatSync(report).isFile()).toBe(true);
  expect(readOf(readPrivateStateFileTailSync(report, 4096))).toBe('{"a":1}\n');
});

skipOnWindows('publishing creates at 0600 whatever the umask, and leaves no sibling behind', () => {
  const state = stateDir();
  const report = path.join(state, 'daemon-shutdown.json');

  // An umask that REMOVES the owner's own bits. Under the ordinary 0022 the file would land at 0600 even if
  // the publish asked the host for no mode at all, so this is the only umask that tells a stated mode from a
  // default one: 0600 & ~0277 is 0400, and a publish that stops saying `exactMode` answers 0400 here.
  const previous = process.umask(0o277);
  try {
    publishPrivateStateFileSync(report, '{"a":1}\n');
  } finally {
    process.umask(previous);
  }

  expect(modeOf(report)).toBe(0o600);
  expect(fs.readdirSync(state)).toEqual(['daemon-shutdown.json']);
});

skipOnWindows('a state directory swapped in as it is opened keeps its own mode', () => {
  // Establishing the chain narrows a loose state directory, and it does that at a name it looked up a moment
  // before the `fchmod`. Between the two, another local user who can write the parent moves the judged
  // directory away and stands a different one at the same name. What stops the mode being said on the wrong
  // inode is the identity comparison: the `lstat` the rule judged with against the `fstat` of the descriptor
  // `O_DIRECTORY | O_NOFOLLOW` actually opened. Delete it and the replacement below is narrowed to 0700 and
  // answers a clean chain — the repair would be reporting a directory it never judged as its own work.
  const directory = root();
  const judged = path.join(directory, 'state');
  directoryWith(judged, 0o777);

  const realOpenSync = fs.openSync.bind(fs);
  const directoryFlags =
    fs.constants.O_RDONLY | Number(fs.constants.O_DIRECTORY) | Number(fs.constants.O_NOFOLLOW);
  let swapped = false;
  const opened = vi.spyOn(fs, 'openSync').mockImplementation(((
    name: fs.PathLike,
    ...rest: unknown[]
  ) => {
    if (!swapped && rest[0] === directoryFlags && String(name) === judged) {
      const moved = path.join(directory, 'moved');
      fs.renameSync(judged, moved);
      directoryWith(judged, 0o777);
      swapped = true;
    }
    return (realOpenSync as (...args: unknown[]) => number)(name, ...rest);
  }) as typeof fs.openSync);

  let chain: PrivateDirectoryChain;
  try {
    chain = ensurePrivateDirectoryChain(judged);
  } finally {
    opened.mockRestore();
  }

  expect(swapped, 'the repair reached the directory open the guard is for').toBe(true);
  expect(modeOf(judged)).toBe(0o777);
  expect(modeOf(path.join(directory, 'moved'))).toBe(0o777);
  expect(chain.exposure).toBe('world_writable');
});

skipOnWindows('a temporary sibling already standing is not this call to write', () => {
  // The sibling's name carries this pid and a random id, so one that is already there is not a leftover of
  // a crash: it is somebody else's entry, and opening it NON-EXCLUSIVELY would follow a link or empty a
  // file they are reading. The create answers EEXIST, refuses the publish, and leaves their entry alone.
  const state = stateDir();
  const report = path.join(state, 'daemon-shutdown.json');
  // Captured before the spy, and used only through a DESCRIPTOR: `fs.writeFileSync(name)` reaches
  // `fs.openSync` by name, which is the call being mocked here.
  const realOpenSync = fs.openSync.bind(fs);
  const realWriteSync = fs.writeSync.bind(fs);
  const realCloseSync = fs.closeSync.bind(fs);
  let planted: string | undefined;
  vi.spyOn(fs, 'openSync').mockImplementation(((name: unknown, ...rest: unknown[]) => {
    if (planted === undefined && typeof name === 'string' && name.endsWith('.tmp')) {
      planted = name;
      const fd = realOpenSync(name, 'wx', 0o600);
      realWriteSync(fd, 'theirs\n');
      realCloseSync(fd);
    }
    return (realOpenSync as (...args: unknown[]) => unknown)(name, ...rest);
  }) as typeof fs.openSync);

  expect(() => publishPrivateStateFileSync(report, '{"a":1}\n')).toThrow(/EEXIST/);

  expect(planted).toBeDefined();
  expect(fs.readFileSync(planted as string, 'utf8')).toBe('theirs\n');
  expect(fs.existsSync(report)).toBe(false);
});

skipOnWindows('a publish refused by the chain writes nothing and creates no sibling', () => {
  const state = path.join(root(), 'foreign');
  directoryWith(state, 0o700);
  serveOwnership({ [state]: FOREIGN_UID });

  expect(() =>
    publishPrivateStateFileSync(path.join(state, 'daemon-shutdown.json'), '{}\n'),
  ).toThrow(/Refusing to write/);

  expect(fs.readdirSync(state)).toEqual([]);
});

// --- the read ---

skipOnWindows(
  'reads the tail of a record, and refuses a link rather than reading through it',
  () => {
    const state = stateDir();
    const report = path.join(state, 'daemon-shutdown.json');
    fs.writeFileSync(report, '{"a":1}\n', { mode: 0o600 });
    expect(readOf(readPrivateStateFileTailSync(report, 4096))).toBe('{"a":1}\n');

    const outside = path.join(state, 'theirs.json');
    fs.writeFileSync(outside, '{"planted":true}\n', { mode: 0o600 });
    const link = path.join(state, 'daemon-shutdown-link.json');
    fs.symlinkSync(outside, link);

    // A refusal reads exactly like absence: a caller that believed this record would be believing what
    // another local user wrote.
    expect(readOf(readPrivateStateFileTailSync(link, 4096))).toBeUndefined();
    expect(fs.readFileSync(outside, 'utf8')).toBe('{"planted":true}\n');
  },
);

skipOnWindows('reads only the bound it is given', () => {
  // A huge file planted at a state name must not be able to exhaust a reader that is only after a tail.
  const state = stateDir();
  const log = path.join(state, 'daemon.log');
  fs.writeFileSync(log, 'x'.repeat(100_000), { mode: 0o600 });

  expect(readOf(readPrivateStateFileTailSync(log, 64))).toBe('x'.repeat(64));
});

skipOnWindows('a FIFO at a state name is refused, and never blocks the reader', () => {
  // The open is verified as a regular file and non-blocking, so a special file planted at a state name
  // answers "no record" instead of parking the client that is trying to report a shutdown.
  const state = stateDir();
  const report = path.join(state, 'daemon-shutdown.json');
  const made = spawnSync('mkfifo', [report], { encoding: 'utf8' });
  expect(made.status).toBe(0);

  expect(readOf(readPrivateStateFileTailSync(report, 4096))).toBeUndefined();
});

skipOnWindows('a read of ground another local user owns is the same answer as no record', () => {
  const state = path.join(root(), 'foreign-read');
  directoryWith(state, 0o700);
  fs.writeFileSync(path.join(state, 'daemon-shutdown.json'), '{"planted":true}\n', { mode: 0o600 });
  serveOwnership({ [state]: FOREIGN_UID });

  expect(
    readOf(readPrivateStateFileTailSync(path.join(state, 'daemon-shutdown.json'), 4096)),
  ).toBeUndefined();
});

// --- writing through a handle this process already holds ---

skipOnWindows('a handle opened for append is the log, at the mode a state record carries', () => {
  const state = stateDir();
  const log = path.join(state, 'daemon.log');
  fs.writeFileSync(log, 'earlier\n', { mode: 0o644 });

  const previous = process.umask(0o022);
  let descriptor: number;
  try {
    descriptor = openStateHandle(log, 'append');
    writePrivateStateLineSync(descriptor, '{"level":"warn"}\n');
  } finally {
    process.umask(previous);
    fs.closeSync(descriptor!);
  }

  // The mode is said on the OPEN descriptor, so an existing file the host left loose is narrowed by the
  // same call that appends to it, and no reader ever sees the wider entry.
  expect(modeOf(log)).toBe(0o600);
  expect(fs.readFileSync(log, 'utf8')).toBe('earlier\n{"level":"warn"}\n');
});

skipOnWindows(
  'a handle cannot be had for ground this process does not own, and asks for nothing',
  () => {
    const state = path.join(root(), 'foreign-handle');
    directoryWith(state, 0o700);
    serveOwnership({ [state]: FOREIGN_UID });
    const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw new Error('a mode said at a NAME would reach here');
    });

    expect(
      refusalMessage(tryOpenPrivateStateFileSync(path.join(state, 'daemon.log'), 'append')),
    ).toMatch(/Refusing to write/);

    expect(chmod.mock.calls).toEqual([]);
  },
);

skipOnWindows('a truncation asked for a record with a second name leaves those bytes alone', () => {
  // `O_TRUNC` said at the open would empty the bytes a moment before anything said whose they are: a
  // record given a second name by a hard link stands verified at the open and is refused only when its
  // names come to be counted. So the truncate purpose opens read-write and empties on the PROVED
  // descriptor, and a refusal here costs a log line and never somebody else's file.
  const state = stateDir();
  const victim = path.join(state, 'theirs.log');
  const log = path.join(state, 'daemon.log');
  fs.writeFileSync(victim, 'not yours\n', { mode: 0o600 });
  fs.linkSync(victim, log);

  const message = refusalMessage(tryOpenPrivateStateFileSync(log, 'truncate'));

  expect(message).toMatch(/2 names/);
  expect(fs.readFileSync(victim, 'utf8')).toBe('not yours\n');
});

skipOnWindows('a record with a second name is refused as a read too, not just as a write', () => {
  // Reading is not harmless once a verdict is made from the bytes: a report or a marker standing under two
  // names is a record somebody else can change behind this reader's back, and "the daemon released these
  // claims" would then be an answer about another party's file.
  const state = stateDir();
  const victim = path.join(state, 'theirs.json');
  const report = path.join(state, 'daemon-shutdown.json');
  fs.writeFileSync(victim, '{"planted":true}\n', { mode: 0o600 });
  fs.linkSync(victim, report);

  expect(readPrivateStateFileTailSync(report, 4096).status).toBe('refused');
});

skipOnWindows('a staging sibling whose write failed is still tidied from ground that holds', () => {
  // The other side of the same gate: the ordinary failure leaves nothing behind, because the caller's own
  // directory judgment still answers the same inode.
  const state = stateDir();
  const report = path.join(state, 'daemon-shutdown.json');
  const realWrite = fs.writeFileSync.bind(fs);
  const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
    target: unknown,
    ...rest: unknown[]
  ) => {
    if (typeof target === 'number') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    return (realWrite as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.writeFileSync);

  try {
    expect(() => publishPrivateStateFileSync(report, '{"a":1}\n')).toThrow(/ENOSPC/);
  } finally {
    write.mockRestore();
  }

  expect(fs.readdirSync(state)).toEqual([]);
});

skipOnWindows('a read leaves a record mode alone, because it writes nothing', () => {
  // A reader has no business changing what it reads. The writer's proof ends with `fchmod`, and only because
  // every later line goes through that handle: a record read at a loose mode is still the daemon's own bytes,
  // and silently tightening a caller's file while asking it a question would be an unasked-for write.
  const state = stateDir();
  const report = path.join(state, 'daemon-shutdown.json');
  fs.writeFileSync(report, '{"a":1}\n', { mode: 0o644 });

  expect(readOf(readPrivateStateFileTailSync(report, 4096))).toBe('{"a":1}\n');
  expect(Number(fs.statSync(report).mode) & 0o777).toBe(0o644);
});

skipOnWindows('a read fault at the ancestry is answered as a refusal, not thrown', () => {
  // Every reader of a state record treats it as OPTIONAL: a stop that already happened, a client polling a
  // startup, a marker tail. The walk converts the lookup faults a state path can meet going in, but a host can
  // fail one for a reason no exposure models — an `EIO` from the device — and the judgment is part of the read.
  // An optional read therefore answers a refusal for ANY fault, including one at its own ancestry, because a
  // caller that cannot be handed bytes still has to be able to finish what it was doing.
  const state = stateDir();
  fs.writeFileSync(path.join(state, 'daemon-shutdown.json'), '{"a":1}\n', { mode: 0o600 });
  const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
    throw Object.assign(new Error('EIO'), { code: 'EIO' });
  });

  try {
    expect(
      readPrivateStateFileTailSync(path.join(state, 'daemon-shutdown.json'), 4096).status,
    ).toBe('refused');
    expect(() =>
      readPrivateStateFileTailSync(path.join(state, 'daemon-shutdown.json'), 4096),
    ).not.toThrow();
  } finally {
    lstat.mockRestore();
  }
});

skipOnWindows(
  'a state open whose private mode this host will not carry is a refusal, not a warning',
  () => {
    // The mode is certified at the ONE state opener, before any caller adopts the handle: the launcher hands
    // this descriptor to the daemon child as its stdout and stderr, and a diagnostics sink streams a run
    // through it. A host that refuses the `fchmod`, or a filesystem that will not hold the mode, would leave
    // every local user reading those bytes while the writer believed the state rule had said 0600 — so the
    // open refuses, the bytes already there are untouched, and no adopter has to ask the question again.
    const state = stateDir();
    const log = path.join(state, 'daemon.log');
    fs.writeFileSync(log, 'earlier\n', { mode: 0o644 });
    const fchmod = vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });

    let opened;
    try {
      opened = tryOpenPrivateStateFileSync(log, 'append');
    } finally {
      fchmod.mockRestore();
    }

    expect(opened.descriptor).toBeUndefined();
    expect((opened.failure as AppError).details).toMatchObject({
      reason: 'state_dir_untrusted',
      exposure: 'record_mode_unproven',
    });
    expect(fs.readFileSync(log, 'utf8')).toBe('earlier\n');
    expect(fs.lstatSync(log).mode & 0o777).toBe(0o644);
  },
);

skipOnWindows('a state mode the host accepts at the ask and will not carry is refused too', () => {
  // The other half of the certification: the read-BACK. A filesystem that takes the `fchmod` and answers a
  // looser mode afterwards — which is what a mount that does not carry the bit does — would otherwise hand
  // the caller a handle whose bytes every local user can read while the state rule believed it had said
  // 0600. The mode is therefore read off the same descriptor it was said on, and a mode that does not come
  // back is the open's own refusal, with those bytes left as they stand.
  const state = stateDir();
  const log = path.join(state, 'daemon.log');
  fs.writeFileSync(log, 'earlier\n', { mode: 0o644 });
  const chmod = vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {});
  const fstat = fs.fstatSync.bind(fs);
  const stat = vi.spyOn(fs, 'fstatSync').mockImplementation(((
    descriptor: number,
    options?: fs.StatOptions & { bigint?: true },
  ) => {
    const stats = fstat(descriptor, options);
    if (options?.bigint) (stats as { mode: number | bigint }).mode = BigInt(0o100644);
    return stats;
  }) as typeof fs.fstatSync);

  let opened;
  try {
    opened = tryOpenPrivateStateFileSync(log, 'append');
  } finally {
    chmod.mockRestore();
    stat.mockRestore();
  }

  expect(opened.descriptor).toBeUndefined();
  expect(String((opened.failure as AppError).message)).toMatch(/644/);
  expect(fs.readFileSync(log, 'utf8'), 'the refusal writes nothing').toBe('earlier\n');
});

/** The bytes a state read answered, or `undefined` for absence and refusal alike. */
function readOf(read: PrivateStateRead): string | undefined {
  return read.status === 'read' ? read.text : undefined;
}

/** The handle a state open answered, refused loudly when it answered none. */
function openStateHandle(pathname: string, purpose: PrivateStateOpenPurpose): number {
  const opened = tryOpenPrivateStateFileSync(pathname, purpose);
  if (opened.descriptor === undefined) throw opened.failure;
  return opened.descriptor;
}

/** The message of a state open that refused, after pinning that it refused at all. */
function refusalMessage(opened: { descriptor: number | undefined; failure: unknown }): string {
  expect(opened.descriptor).toBeUndefined();
  return String((opened.failure as Error).message);
}
