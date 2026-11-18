// The daemon's own log at the moment a registration publishes (#4649, #3291): who is allowed to empty it, and
// what a refusal to do so costs. Publication and retirement are `daemon-registration-owner.test.ts`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  tryAcquireDaemonRegistration,
  type DaemonRegistrationOwner,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import {
  resolveDaemonPaths,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { mkdtempForTestSync, withCapturedStderr } from '@agent-device/test-kit';

const fields = {
  socketPort: 4210,
  token: 'token',
  version: '0.0.0-test',
  codeOrigin: 'checkout' as const,
  codeSignature: 'signature',
};
const report = {
  providerReleases: { released: [], pending: [] },
  claims: { released: [], orphaned: [], superseded: [], unattributable: [] },
};

afterEach(() => vi.restoreAllMocks());

async function acquire(
  paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-daemon-log-')),
): Promise<{ paths: DaemonPaths; owner: DaemonRegistrationOwner }> {
  const attempt = await tryAcquireDaemonRegistration(paths);
  assert.equal(attempt.status, 'acquired');
  if (attempt.status !== 'acquired') throw new Error('registration refused');
  return { paths, owner: attempt.owner };
}

test('publication truncates the log the daemon is already appending to', async () => {
  // The whole point of emptying the log on a descriptor instead of replacing the file: the daemon's stdout and
  // stderr are already open on this inode, so a line written after the truncation is all the log holds.
  const { paths, owner } = await acquire();
  const daemonOutput = fs.openSync(paths.logPath, 'a');
  try {
    fs.writeSync(daemonOutput, 'previous run\n');
    owner.publish(fields);
    fs.writeSync(daemonOutput, 'listening\n');
  } finally {
    fs.closeSync(daemonOutput);
  }
  assert.equal(fs.readFileSync(paths.logPath, 'utf8'), 'listening\n');
  await owner.finish(report);
});

function onWindowsHost<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  return run().finally(() => {
    if (previous) Object.defineProperty(process, 'platform', previous);
  });
}

// Windows refuses ftruncate on a handle opened append-only, and closing an append handle to reopen one drops
// the inode pin. The state open boundary answers both without a platform split: it opens the log `O_RDWR` and
// truncates through that one descriptor, so there is never an append handle to fail on and never a second open
// of the name. These tests pin that seam on the host that used to need the workaround.

// Emulates the Windows host rule at the fs seam: ftruncate through an append-only handle raises EPERM as NTFS
// would, while every other open and truncate passes through. Records the flags each log open used so each test
// can pin the exact handle sequence.
function spyWindowsLogHandleRules(logPath: string): string[] {
  const flagsByDescriptor = new Map<number, string>();
  const logOpenFlags: string[] = [];
  const realOpen = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation(((
    target: fs.PathLike,
    flags: fs.OpenMode,
    mode?: fs.Mode,
  ) => {
    if (String(target) === logPath) logOpenFlags.push(String(flags));
    const descriptor = realOpen(target, flags, mode);
    flagsByDescriptor.set(descriptor, String(flags));
    return descriptor;
  }) as typeof fs.openSync);
  const realTruncate = fs.ftruncateSync;
  vi.spyOn(fs, 'ftruncateSync').mockImplementation(((descriptor: number, len?: number) => {
    if (flagsByDescriptor.get(descriptor) === 'a') {
      throw Object.assign(new Error('EPERM: operation not permitted, ftruncate'), {
        code: 'EPERM',
      });
    }
    realTruncate(descriptor, len);
  }) as typeof fs.ftruncateSync);
  return logOpenFlags;
}

/** The access bits of an open flag set; this host's `fs.constants` does not name `O_ACCMODE`. */
const ACCESS_MODE_BITS = 0b11;

/** The access and create bits of a numeric open flag set, asked as booleans the assertions can name. */
function openFlagsOf(recorded: string): {
  append: boolean;
  writeWrite: boolean;
  noFollow: boolean;
  creating: boolean;
} {
  const flags = Number(recorded);
  assert.ok(Number.isInteger(flags), `expected numeric open flags, got ${recorded}`);
  return {
    append: (flags & fs.constants.O_APPEND) !== 0,
    writeWrite: (flags & ACCESS_MODE_BITS) === fs.constants.O_RDWR,
    noFollow:
      Number.isInteger(fs.constants.O_NOFOLLOW) &&
      Number(fs.constants.O_NOFOLLOW) > 0 &&
      (flags & Number(fs.constants.O_NOFOLLOW)) !== 0,
    creating: (flags & fs.constants.O_CREAT) !== 0,
  };
}

test('a Windows host empties an existing log through one pinned write handle', async () => {
  const { paths, owner } = await acquire();
  fs.writeFileSync(paths.logPath, 'previous run\n');
  const logOpenFlags = spyWindowsLogHandleRules(paths.logPath);
  await onWindowsHost(async () => {
    try {
      owner.publish(fields);
      assert.equal(fs.readFileSync(paths.logPath, 'utf8'), '');
      // ONE open of the name, and no append handle anywhere in it: the same
      // descriptor that carried the truncation is the one that was opened
      // without following a link, which is what pins the inode (#3291).
      assert.equal(logOpenFlags.length, 1);
      const flags = openFlagsOf(logOpenFlags[0]!);
      assert.deepEqual(flags, {
        append: false,
        writeWrite: true,
        noFollow: flags.noFollow,
        creating: flags.creating,
      });
    } finally {
      vi.restoreAllMocks();
    }
  });
  await owner.finish(report);
});

test('a missing log is created and emptied through that same handle', async () => {
  const { paths, owner } = await acquire();
  const logOpenFlags = spyWindowsLogHandleRules(paths.logPath);
  await onWindowsHost(async () => {
    try {
      owner.publish(fields);
      assert.equal(fs.readFileSync(paths.logPath, 'utf8'), '');
      // One create-or-open, not the old probe/create/reopen ladder: an
      // exclusive create that lands on EEXIST is judged and reopened by the
      // verified opener, and either way the log is emptied through the handle
      // that made it.
      assert.equal(logOpenFlags.length, 1);
      assert.equal(openFlagsOf(logOpenFlags[0]!).append, false);
      assert.equal(fs.statSync(paths.logPath).mode & 0o777, 0o600);
    } finally {
      vi.restoreAllMocks();
    }
  });
  await owner.finish(report);
});

test('a log the state rule refuses is left alone and the daemon still registers', async () => {
  const { paths, owner } = await acquire();
  // The hole #4649 is about: a name in the state directory that is not a regular file this process owns. An
  // `openSync(logPath, 'a')` would follow the link and write through it, and `O_TRUNC` at the name would empty
  // the file it points at before any rule got a look. So the refusal is the answer: the target keeps its bytes,
  // the registration still publishes, and the refusal is said on stderr rather than on the refused name.
  const victim = path.join(paths.baseDir, 'someone-elses-log');
  fs.writeFileSync(victim, 'not yours\n', { mode: 0o600 });
  fs.rmSync(paths.logPath, { force: true });
  fs.symlinkSync(victim, paths.logPath, 'file');

  const said = withCapturedStderr(() => owner.publish(fields));

  assert.equal(said.trim().split('\n').length, 1);
  assert.match(said, /daemon_log_truncate/);
  assert.match(fs.readFileSync(victim, 'utf8'), /not yours/);
  assert.equal(fs.lstatSync(paths.logPath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(paths.infoPath), true);
  await owner.finish(report);
});
