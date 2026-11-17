// The daemon forces its own state directories to 0700, because the script-destination rule refuses a
// group-writable directory on the chain (ADR 0016). What this suite pins is the OTHER half: a state level
// whose mode this process may not force, or cannot reach, is SKIPPED with a warning and the call still
// returns. A state repair never decides whether the daemon starts; the destination walk is the only refusal.
// (https://github.com/callstack/agent-device/pull/4584)

import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FOREIGN_UID, mkdtempForTestSync, serveHostOwnership } from '@agent-device/test-kit';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { ensurePrivateDaemonStateDir } from './daemon-registration-owner.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;
const SKIPPED = ['daemon_state_mode_repair_skipped'];
// Captured before any spy is installed, so a forwarded call reaches the host and not another mock.
const originals = {
  lstatSync: fs.lstatSync.bind(fs) as FsCall,
  statSync: fs.statSync.bind(fs) as FsCall,
  openSync: fs.openSync.bind(fs) as FsCall,
  fstatSync: fs.fstatSync.bind(fs) as FsCall,
  fchmodSync: fs.fchmodSync.bind(fs) as FsCall,
  closeSync: fs.closeSync.bind(fs) as FsCall,
};

type FsCall = (...args: unknown[]) => unknown;
type SeamName = keyof typeof originals;

afterEach(() => {
  vi.restoreAllMocks();
});

skipOnWindows('repairs the state chain it owns, whatever mode its levels were created with', () => {
  // An older version, or a checkout shared under umask 002, leaves `sessions/` at 0775 and the daemon then
  // refuses its own recordings. Repair is what fixes a host it did not create, so it has to work — and a
  // per-session call has to reach the level ABOVE the session directory, or every recording is still walked
  // through a 0775 `sessions/`.
  const base = mkdtempForTestSync('agent-device-state-repair-');
  fs.chmodSync(base, 0o755);
  const sessions = path.join(base, 'sessions');
  const remote = path.join(sessions, 'remote-scripts');
  for (const directory of [sessions, remote]) {
    fs.mkdirSync(directory);
    fs.chmodSync(directory, 0o775);
  }

  // How the daemon actually calls it: startup ensures `sessions/` from the state base, the remote writer
  // ensures `remote-scripts/`, and each call repairs the chain down to the level it was asked for.
  ensurePrivateDaemonStateDir(sessions, base);
  expect(ensurePrivateDaemonStateDir(remote, base)).toBe(remote);

  for (const directory of [base, sessions, remote]) {
    expect(modeOf(directory)).toBe(0o700);
  }
});

skipOnWindows('asks nothing of a chain that already stands private', () => {
  // The fast path, and the reason a per-session call is cheap: every level already has the mode the repair
  // would force, so none of them is even opened. Dropping the mode check makes this red.
  const base = mkdtempForTestSync('agent-device-state-private-');
  const sessions = path.join(base, 'sessions');
  fs.mkdirSync(sessions);
  for (const directory of [base, sessions]) fs.chmodSync(directory, 0o700);
  const open = vi.spyOn(fs, 'openSync');

  ensurePrivateDaemonStateDir(sessions, base);

  expect(open).not.toHaveBeenCalled();
});

skipOnWindows('stops at an intermediate link and leaves where it leads alone', async () => {
  // `O_NOFOLLOW` guards only the LAST name of an open, so judging the leaf is not enough: `sessions` is a
  // link to a directory outside the state tree, and the leaf this call is handed resolves on the far side of
  // it. A root daemon given that leaf opens the foreign directory and forces its mode — 0755 to 0700 strips
  // access from an owner who never ran the daemon. So the chain is judged DOWN from the state base, and a
  // link stops the descent before anything below it is opened.
  const base = mkdtempForTestSync('agent-device-state-intermediate-link-');
  fs.chmodSync(base, 0o777);
  // The directory the link points at, and the child the leaf resolves to on its far side — `/etc/ssh` in
  // the reported shape, standing 0755 with an owner who never ran the daemon.
  const outside = path.join(base, 'outside');
  const farSide = path.join(outside, 'ssh');
  fs.mkdirSync(farSide, { recursive: true });
  fs.chmodSync(outside, 0o755);
  fs.chmodSync(farSide, 0o755);
  const sessions = path.join(base, 'sessions');
  fs.symlinkSync(outside, sessions);

  // The shape of the blocker: startup asks for `sessions`, a later session open asks for `sessions/ssh`,
  // which is a name on the far side of that link.
  expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions, base))).toBe(1);
  expect(
    await skipCountFor(() => ensurePrivateDaemonStateDir(path.join(sessions, 'ssh'), base)),
  ).toBe(1);

  // The far-side child keeps the mode its owner chose, and neither level was reached at all: repairing that
  // leaf through its name is what opened the far side and forced 0700 on it.
  expect(modeOf(farSide)).toBe(0o755);
  expect(modeOf(outside)).toBe(0o755);
  expect(fs.lstatSync(sessions).isSymbolicLink()).toBe(true);
});

skipOnWindows('reports a state level that is a LINK CARRYING the private mode', async () => {
  // Where the host lets a link carry its own mode, `lchmod` 0700 makes the link answer the mode question
  // with the private mode. A repair that asks the mode before it asks what the entry IS returns there and
  // passes a link it never judged, so the level-by-level order is the pin: `isDirectory` first, the mode
  // second. The far side is not what this shape is about — the silent pass is.
  const base = mkdtempForTestSync('agent-device-state-link-mode-');
  fs.chmodSync(base, 0o755);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.chmodSync(outside, 0o755);
  const sessions = path.join(base, 'sessions');
  fs.symlinkSync(outside, sessions);
  // On a host that gives every link the same mode, the shape below is the ordinary link case and the skip
  // has to be answered either way.
  try {
    fs.lchmodSync(sessions, 0o700);
  } catch {
    /* this host reports one mode for all links */
  }

  expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions, base))).toBe(1);

  expect(modeOf(outside)).toBe(0o755);
  expect(fs.lstatSync(sessions).isSymbolicLink()).toBe(true);
});

skipOnWindows('repairs above a planted link and stops below it', async () => {
  // The same stop, judged the other way: `sessions` is a directory this user owns and gets repaired, and
  // `remote-scripts` under it is a link. The chain repairs what it may and refuses to follow the name it
  // may not, so the target of the link keeps the mode its owner chose.
  const base = mkdtempForTestSync('agent-device-state-planted-below-');
  fs.chmodSync(base, 0o755);
  const sessions = path.join(base, 'sessions');
  fs.mkdirSync(sessions);
  fs.chmodSync(sessions, 0o775);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.chmodSync(outside, 0o777);
  const remote = path.join(sessions, 'remote-scripts');
  fs.symlinkSync(outside, remote);

  expect(await skipCountFor(() => ensurePrivateDaemonStateDir(remote, base))).toBe(1);

  expect(modeOf(sessions)).toBe(0o700);
  expect(modeOf(outside)).toBe(0o777);
  expect(fs.readdirSync(outside)).toEqual([]);
});

skipOnWindows('skips a state directory another user owns, and leaves its mode', async () => {
  // The container and shared-CI shape: `sessions/` belongs to the uid a volume was mounted with, and the
  // daemon runs as root or as somebody else. Ownership is asked of the descriptor the mode would be forced
  // through, so the repair reports the level and gets out of the way. Refusing to start here would take a
  // working host down over a mode, and a recording under that tree is refused by the walk anyway.
  const base = mkdtempForTestSync('agent-device-state-foreign-');
  fs.chmodSync(base, 0o755);
  const sessions = path.join(base, 'sessions');
  fs.mkdirSync(sessions);
  fs.chmodSync(sessions, 0o775);
  serveHostOwnership({ [sessions]: FOREIGN_UID });

  expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions, base))).toBe(1);

  expect(modeOf(sessions)).toBe(0o775);
});

skipOnWindows(
  'skips a chain whose state base is a link, and creates its state anyway',
  async () => {
    // `~/.agent-device` on another disk: the base ITSELF is a link, so the descent cannot judge it and every
    // level under it is out of reach. That is a host the operator set up, not an attack, so creation goes
    // through and the repair only reports — a daemon that refused to start here would fail every command.
    const target = mkdtempForTestSync('agent-device-state-link-target-');
    const parent = mkdtempForTestSync('agent-device-state-link-');
    const base = path.join(parent, 'agent-device');
    fs.symlinkSync(target, base);
    const sessions = path.join(base, 'sessions');

    expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions, base))).toBe(1);

    // The state appeared under the directory the link points at, and nothing about the link changed.
    expect(fs.lstatSync(sessions).isDirectory()).toBe(true);
    expect(fs.lstatSync(base).isSymbolicLink()).toBe(true);
  },
);

for (const code of ['EACCES', 'ENOENT', 'EIO'] as const) {
  skipOnWindows(`skips a state level the host answers ${code} for, and never throws`, async () => {
    // Any of the five calls a repair makes can fail: `lstat` on a directory this user cannot read, `open` on
    // a mount that will not serve it or a name that went missing meanwhile, `fstat` and `fchmod` on a host
    // whose semantics differ, and `close` on a host that cannot release the descriptor. None of them may
    // reach the daemon's startup path — this decides a mode, not whether the daemon runs — and every one has
    // to say so on the phase a host can see.
    for (const seam of ['lstatSync', 'openSync', 'fstatSync', 'fchmodSync', 'closeSync'] as const) {
      const base = mkdtempForTestSync('agent-device-state-errno-');
      // The base already stands private, so the only level with something to repair is the one under test.
      fs.chmodSync(base, 0o700);
      const sessions = path.join(base, 'sessions');
      fs.mkdirSync(sessions);
      fs.chmodSync(sessions, 0o755);
      denyOneSeam(seam, sessions, code);

      // `closeSync` comes last, so the mode it is closing was already forced when the close fails.
      expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions, base))).toBe(1);
      expect(modeOf(sessions)).toBe(seam === 'closeSync' ? 0o700 : 0o755);
      vi.restoreAllMocks();
    }
  });
}

/**
 * Makes one filesystem call answer `code` for `target`, and only for it: the path seams are asked by name,
 * the descriptor seams by the descriptor `open` returned for that name. Every other call reaches the host.
 */
function denyOneSeam(seam: SeamName, target: string, code: string): void {
  const denied = Object.assign(new Error(`test ${code}`), { code });
  // Which descriptors came from `target`: a descriptor seam has to be denied for the same entry the path
  // seam would have been denied for, and `open` has to answer before those three can be reached at all.
  const openedOnTarget = new Set<number>();
  const realOpen = originals.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation(((...args: unknown[]) => {
    if (seam === 'openSync' && String(args[0]) === target) throw denied;
    const descriptor = realOpen(...args) as number;
    if (String(args[0]) === target) openedOnTarget.add(descriptor);
    return descriptor;
  }) as typeof fs.openSync);
  if (seam === 'openSync') return;
  if (seam === 'lstatSync') {
    denyCall('lstatSync', (argument) => String(argument) === target, denied);
    return;
  }
  denyCall(seam, (argument) => openedOnTarget.has(argument as number), denied);
}

/** Makes one `fs` call throw for the arguments `named` selects, forwarding every other call to the host. */
function denyCall(seam: SeamName, named: (argument: unknown) => boolean, error: Error): void {
  const real = originals[seam];
  vi.spyOn(fs, seam).mockImplementation(((...args: unknown[]) => {
    if (named(args[0])) throw error;
    return real(...args);
  }) as typeof fs.lstatSync);
}

function modeOf(target: string): number {
  return Number((originals.lstatSync(target) as fs.Stats).mode & 0o777);
}

/**
 * Runs one repair inside its own diagnostics scope and reports how often it said it skipped a level. No
 * `logPath`, so the events are tallied and written nowhere.
 */
async function skipCountFor(repair: () => unknown): Promise<number> {
  return await withDiagnosticsScope({ session: 'daemon' }, () => {
    expect(repair()).toBeDefined();
    return countDiagnosticEventsByPhase(SKIPPED);
  });
}
