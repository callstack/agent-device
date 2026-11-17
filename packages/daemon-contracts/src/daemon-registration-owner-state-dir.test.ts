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
import { ensureDaemonStateDir, ensurePrivateDaemonStateDir } from './daemon-registration-owner.ts';

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
  const answer = ensurePrivateDaemonStateDir(remote, base);
  expect(answer).toEqual({ path: remote, privateChain: true });

  for (const directory of [base, sessions, remote]) {
    expect(modeOf(directory)).toBe(0o700);
  }
});

skipOnWindows('answers that a chain it stopped on is not private ground', async () => {
  // Startup reads this answer and starts anyway; a caller that WRITES under the directory reads the same
  // answer and refuses. A chain that stopped at a link leads to ground outside the state tree, and the
  // destination rule accepts a link whose parent others cannot write, so the walk would have published
  // there. Only a chain that reached its level at 0700 answers `privateChain: true`.
  const base = mkdtempForTestSync('agent-device-state-verdict-');
  fs.chmodSync(base, 0o755);
  const sessions = path.join(base, 'sessions');
  fs.mkdirSync(sessions);
  fs.chmodSync(sessions, 0o775);

  expect(ensurePrivateDaemonStateDir(sessions, base)).toEqual({
    path: sessions,
    privateChain: true,
  });

  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  const planted = path.join(sessions, 'remote-scripts');
  fs.symlinkSync(outside, planted);
  expect(ensurePrivateDaemonStateDir(planted, base)).toEqual({
    path: planted,
    privateChain: false,
  });

  // A level the chain stopped at is not private either, and neither is one below it.
  expect(ensurePrivateDaemonStateDir(path.join(planted, 'session'), base).privateChain).toBe(false);
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

skipOnWindows(
  'skips a directory whose opened descriptor is foreign-owned although lstat reported this UID',
  async () => {
    // The name can be swapped between the `lstat` and the open, so the ownership that counts is the one the
    // DESCRIPTOR answers: the entry the `fchmod` would change. Two things are pinned here — the check itself
    // (a descriptor whose uid is foreign is not forced), and that a rejection there STOPS THE DESCENT, so a
    // child beneath the rejected level is never opened or forced either. `lstat` says this uid owns both.
    const base = mkdtempForTestSync('agent-device-state-descriptor-foreign-');
    // The base already stands private, so `sessions` is the only level with anything to force.
    fs.chmodSync(base, 0o700);
    const sessions = path.join(base, 'sessions');
    const child = path.join(sessions, 'ssh');
    fs.mkdirSync(child, { recursive: true });
    for (const directory of [sessions, child]) fs.chmodSync(directory, 0o755);
    // The fixture owns these mocks (it must map a descriptor back to the name it reached), so it also
    // reports what was opened and closed. A level that is FORCEs mode opens and closes; a level that is
    // merely judged does neither. So `openedNames` naming only `sessions` says the child below it was never
    // reached, and the descriptor `sessions` opened being closed says it did not leak.
    const probe = serveHostOwnership({ [sessions]: FOREIGN_UID }, { throughDescriptorOnly: true });
    const fchmod = vi.spyOn(fs, 'fchmodSync');

    // Asked for the CHILD, so the descent is what the rejection has to stop: the chain is base → sessions →
    // ssh, and `sessions` is where the descriptor is refused. Without the stop, the child (this uid's, 0755)
    // would be opened and forced next.
    expect(await skipCountFor(() => ensurePrivateDaemonStateDir(child, base))).toBe(1);

    // Nothing was forced anywhere on that chain, and both levels keep the owner's mode.
    expect(fchmod).not.toHaveBeenCalled();
    expect(modeOf(sessions)).toBe(0o755);
    expect(modeOf(child)).toBe(0o755);
    // Only the rejected level was opened, and its descriptor was closed.
    expect(probe.openedNames()).toEqual([sessions]);
    const descriptor = probe.descriptorFor(sessions);
    expect(typeof descriptor).toBe('number');
    expect(probe.closedDescriptors()).toContain(descriptor);
  },
);

skipOnWindows('reports a level it cannot judge, and creates nothing for it', async () => {
  // The chain is walked before anything is created, so an ABSENT level is the one state the descent acts on: it
  // creates that name and judges what appears. Here the answer stays absent through the creation attempt, which
  // is what `throwIfNoEntry: false` really returns for a name that is not there (asserted below against a real
  // absent name, so the injected value is the host's own answer and not a made-up shape) — a host that cannot
  // tell the daemon what stands there. What must not happen is a silent stop, or a mode forced on a name nobody
  // judged: an operator reading the daemon log has to see where the chain stopped.
  const base = mkdtempForTestSync('agent-device-state-absent-level-');
  fs.chmodSync(base, 0o700);
  const sessions = path.join(base, 'sessions');
  fs.mkdirSync(sessions);
  fs.chmodSync(sessions, 0o755);
  const realLstat = originals.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((target: unknown, options?: unknown) => {
    if (
      String(target) === sessions &&
      (options as { throwIfNoEntry?: boolean })?.throwIfNoEntry === false
    )
      return undefined;
    return realLstat(target as fs.PathLike, options as never);
  }) as typeof fs.lstatSync);

  // The same call, on a name that is truly absent, answers the same way.
  expect(
    originals.lstatSync(path.join(base, 'no-such-level'), {
      bigint: true,
      throwIfNoEntry: false,
    }),
  ).toBeUndefined();

  // Nothing was changed, and the chain says so for the writer that reads it.
  expect(ensurePrivateDaemonStateDir(sessions, base)).toEqual({
    path: sessions,
    privateChain: false,
  });
  expect(modeOf(sessions)).toBe(0o755);
  expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions, base))).toBe(1);
});

skipOnWindows(
  'hands back ENOTDIR when a plain file stands where a state level has to be',
  async () => {
    // A LINK at a level is a host shape the verdict is for: the chain answers not private, the caller is told in
    // the log, and the daemon keeps working. A plain FILE at `sessions` is not that. Nothing can ever be created
    // or written under it, so a verdict of "not private" would send every command into a directory that cannot
    // exist and fail later with a worse message. The recursive `mkdir` this rule replaced answered `ENOTDIR`
    // there, and the caller that handled that handles this one — including the `open` that could not make its
    // artifact directory.
    const base = mkdtempForTestSync('agent-device-state-file-level-');
    fs.chmodSync(base, 0o700);
    const sessions = path.join(base, 'sessions');
    fs.writeFileSync(sessions, 'not a directory\n');

    // Said once, and THROWN: no skip is emitted, because a skipped level is something the daemon walked past and
    // there is nothing of that kind here.
    const { skips } = await withDiagnosticsScope({ session: 'daemon' }, () => {
      let thrown: unknown;
      try {
        ensurePrivateDaemonStateDir(path.join(sessions, 'journey'), base);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ENOTDIR' });
      return { skips: countDiagnosticEventsByPhase(SKIPPED) };
    });
    expect(skips).toBe(0);
    // Nothing was created, and the file is exactly as it was.
    expect(fs.lstatSync(sessions).isFile()).toBe(true);
  },
);

skipOnWindows(
  'refuses to repair a chain whose state base stands on ground another user can write',
  async () => {
    // The blocker: judging DOWN from the state base never questions the ground the base itself stands on. A
    // local user who can write that ancestor can rename the base and leave a link at its name between two of
    // this function's calls, and every level below then resolves on the far side of a link nothing judged.
    // The swap is staged here at the moment the descent looks at the SECOND level, which is what the reported
    // host did: the daemon came in with `base/sessions` and `base/sessions/remote-scripts` standing 0755, and
    // left the ATTACKER's directories at 0700 while answering `privateChain: true`.
    //
    // The answer is to judge the ancestry FIRST, with the rule a script destination is walked by, so the race
    // is not reachable at all: nothing below is opened, and the chain is not private ground.
    const shared = mkdtempForTestSync('agent-device-state-shared-ancestor-');
    fs.chmodSync(shared, 0o777);
    const base = path.join(shared, 'agent-device');
    const sessions = path.join(base, 'sessions');
    const remote = path.join(sessions, 'remote-scripts');
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    fs.chmodSync(base, 0o700);
    fs.chmodSync(sessions, 0o755);
    // Where the base's name leads once it is swapped: directories this user owns, standing 0755, exactly as a
    // directory an attacker's link points at would.
    const outside = path.join(shared, 'attacker');
    const farSessions = path.join(outside, 'sessions');
    const farRemote = path.join(farSessions, 'remote-scripts');
    fs.mkdirSync(farRemote, { recursive: true });
    for (const directory of [outside, farSessions, farRemote]) fs.chmodSync(directory, 0o755);
    const coUser = swapBaseWhenDescentLooksAt(base, sessions, outside);

    expect(ensurePrivateDaemonStateDir(remote, base)).toEqual({
      path: remote,
      privateChain: false,
    });
    // Said once, and named for the ground that is not this process's to rely on.
    expect(await skipCountFor(() => ensurePrivateDaemonStateDir(remote, base))).toBe(1);

    // The ancestry was judged before any level was opened, so the descent never got as far as the name the
    // swap was armed for, and the co-user never had their turn.
    expect(coUser.swapped()).toBe(false);
    // Nothing was forced anywhere: neither the levels under the base nor the directories its name would have
    // led to. The far side keeping 0755 is the whole point — that mode change is the reported exposure.
    expect(modeOf(base)).toBe(0o700);
    expect(modeOf(sessions)).toBe(0o755);
    expect(modeOf(outside)).toBe(0o755);
    expect(modeOf(farSessions)).toBe(0o755);
    expect(modeOf(farRemote)).toBe(0o755);
    expect(fs.readdirSync(outside)).toEqual(['sessions']);
  },
);

skipOnWindows(
  'repairs a chain whose ancestor is open to others but carries the sticky bit',
  async () => {
    // The same host shape, minus the one thing that made it unsafe: macOS `/tmp` and a shared CI directory are
    // world-writable AND sticky, and this user owns them, so nobody but an entry's owner or root can rename the
    // state base. Repair goes ahead. This is the pin that the ancestry is judged by the destination rule and
    // not by a stricter copy of it: that rule passes a sticky directory through, so this one does too.
    const shared = mkdtempForTestSync('agent-device-state-sticky-ancestor-');
    fs.chmodSync(shared, 0o1777);
    const base = path.join(shared, 'agent-device');
    const sessions = path.join(base, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    for (const directory of [base, sessions]) fs.chmodSync(directory, 0o755);

    expect(ensurePrivateDaemonStateDir(sessions, base)).toEqual({
      path: sessions,
      privateChain: true,
    });

    expect(modeOf(base)).toBe(0o700);
    expect(modeOf(sessions)).toBe(0o700);
  },
);

skipOnWindows(
  'refuses a chain whose state base belongs to the ancestor that is another user',
  async () => {
    // The other way an ancestor can stop this repair: the directory the base stands in belongs to somebody
    // else, so they can move the base whenever they like. `serveHostOwnership` reports the ownership the
    // account files of this host cannot give a test.
    // Resolved, because the ancestry walk resolves the same names the kernel does and reports the physical
    // directory it stands on; a fixture keyed by path has to be keyed by that name.
    const parent = fs.realpathSync(mkdtempForTestSync('agent-device-state-foreign-ancestor-'));
    const base = path.join(parent, 'agent-device');
    const sessions = path.join(base, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    for (const directory of [base, sessions]) fs.chmodSync(directory, 0o755);
    serveHostOwnership({ [parent]: FOREIGN_UID });

    expect(ensurePrivateDaemonStateDir(sessions, base)).toEqual({
      path: sessions,
      privateChain: false,
    });

    // Their directory, their mode: nothing below was forced either.
    expect(modeOf(base)).toBe(0o755);
    expect(modeOf(sessions)).toBe(0o755);
  },
);

/**
 * Plays the co-user: renames `base` aside and leaves a link at its name pointing at `outside`, at the moment
 * the descent `lstat`s `watched` — after the base itself was judged, before anything below it was opened.
 * Answers whether that turn ever came, which it does not when the ancestry is judged first.
 */
function swapBaseWhenDescentLooksAt(
  base: string,
  watched: string,
  outside: string,
): Readonly<{ swapped: () => boolean }> {
  const realLstat = originals.lstatSync;
  let swapped = false;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((target: unknown, options?: unknown) => {
    if (!swapped && String(target) === watched) {
      swapped = true;
      fs.renameSync(base, `${base}-moved`);
      fs.symlinkSync(outside, base);
    }
    return realLstat(target as fs.PathLike, options as never);
  }) as typeof fs.lstatSync);
  return { swapped: () => swapped };
}

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
  'stands on a state base that is a link, and keeps its state where the link points',
  async () => {
    // `~/.agent-device` linked to another disk: a layout the operator chose, and one every release before this
    // rule kept its state on the far side of. What the link costs is the verdict — the chain is not private
    // ground — and that verdict decides WHAT stands there: a destination of the daemon's own choosing is
    // published nowhere on that chain and CREATED nowhere under it, while startup still gets the state it runs
    // on. At head the descent crossed the refused base and built `sessions` on the far side anyway, reporting
    // `privateChain: false` for a directory it had just made (#4584 review).
    const target = mkdtempForTestSync('agent-device-state-link-target-');
    fs.chmodSync(target, 0o755);
    const parent = mkdtempForTestSync('agent-device-state-link-');
    const base = path.join(parent, 'agent-device');
    fs.symlinkSync(target, base);
    const sessions = path.join(base, 'sessions');

    const { answer, skips } = await withDiagnosticsScope({ session: 'daemon' }, () => ({
      answer: ensurePrivateDaemonStateDir(sessions, base),
      skips: countDiagnosticEventsByPhase(SKIPPED),
    }));

    // The answer carries the base's own name — the kernel resolves the link on the way in, exactly as it always
    // has, and a client names this spelling too. Only the verdict changes: not private ground.
    expect(answer).toEqual({
      path: sessions,
      privateChain: false,
    });
    // One skip, for the level the repair would not stand on: the base itself.
    expect(skips).toBe(1);
    // And nothing was made on the far side of a name this rule refused to stand on.
    expect(fs.lstatSync(sessions, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readdirSync(target)).toEqual([]);
    expect(modeOf(target)).toBe(0o755);
    expect(fs.lstatSync(base).isSymbolicLink()).toBe(true);

    // The caller that writes no script still gets the state it runs on, where the link points.
    expect(await skipCountFor(() => ensureDaemonStateDir(sessions, base))).toBe(1);
    expect(fs.lstatSync(sessions).isDirectory()).toBe(true);
    // The far side keeps the mode its owner chose: this creation forces no mode through the link.
    expect(modeOf(target)).toBe(0o755);
  },
);

skipOnWindows(
  'creates nothing for a script under a state base another user owns, and only `mkdir` for its own',
  async () => {
    // The other refused BASE, with the tail missing rather than present: `~/.agent-device` left to the uid a
    // volume was mounted with (#4565). Startup may not stop on that, so it still gets its levels. A recording
    // the daemon picks for itself may not: at head the descent crossed the refused base and CREATED
    // `sessions/remote-scripts` beneath it while answering `privateChain: false`, so the writer refused the
    // recording and the repair had already built the directory for it.
    const base = mkdtempForTestSync('agent-device-state-foreign-base-');
    fs.chmodSync(base, 0o755);
    const remote = path.join(base, 'sessions', 'remote-scripts');
    serveHostOwnership({ [base]: FOREIGN_UID });

    expect(ensurePrivateDaemonStateDir(remote, base)).toEqual({
      path: remote,
      privateChain: false,
    });
    // Nothing stands on ground this rule will not stand on, and the base keeps the mode its owner chose.
    expect(fs.readdirSync(base)).toEqual([]);
    expect(modeOf(base)).toBe(0o755);

    // The own-state caller is the one caller that creates there, and it creates and forces NOTHING but its own
    // recursive `mkdir`: the state stands, this uid's own, and the refused base keeps the mode its owner chose.
    expect(await skipCountFor(() => ensureDaemonStateDir(remote, base))).toBe(1);
    // Both reads go to the host, past the ownership the fixture serves for this path.
    expect(fs.lstatSync(remote).isDirectory()).toBe(true);
    expect(Number((originals.lstatSync(base) as fs.Stats).uid)).toBe(process.getuid?.() ?? -1);
    expect(modeOf(base)).toBe(0o755);
  },
);

skipOnWindows(
  'makes its own state over an ancestor it will not judge forcing no mode at all',
  async () => {
    // A fresh state directory inside non-sticky shared scratch — the shared CI volume and the container shape.
    // The walk refuses that ancestor and the daemon still has to start, so the own-state path creates. What it
    // may not add is a MODE: `mkdir` then `chmod` BY NAME is a two-step, and every other local user of that
    // shared directory holds the window between them — rename the name just created, put a link there, and the
    // mode lands on whatever they pointed at, 0755 to 0700 on a directory whose owner never ran the daemon.
    // At head this caller ran the trusted-parent per-level creator, which is exactly that two-step: the
    // reviewer saw it `chmod` the fresh base by name (#4584 review).
    const shared = fs.realpathSync(mkdtempForTestSync('agent-device-state-untrusted-own-'));
    fs.chmodSync(shared, 0o777);
    const base = path.join(shared, 'agent-device');
    const remote = path.join(base, 'sessions', 'remote-scripts');

    // Every `chmod` this repair makes is asked, by name or by descriptor, for one directory: the base it is
    // about to force. At head that call is made here, on ground the walk refused.
    const chmod = vi.spyOn(fs, 'chmodSync');
    const fchmod = vi.spyOn(fs, 'fchmodSync');
    expect(await skipCountFor(() => ensureDaemonStateDir(remote, base))).toBe(1);
    expect(chmod.mock.calls.map(([, mode]) => mode)).toEqual([]);
    expect(fchmod.mock.calls.map(([, mode]) => mode)).toEqual([]);
    // The state still stands, and a script destination on that chain is still created nowhere.
    expect(fs.lstatSync(remote).isDirectory()).toBe(true);
    expect(ensurePrivateDaemonStateDir(path.join(base, 'other'), base).privateChain).toBe(false);
    expect(fs.readdirSync(base)).toEqual(['sessions']);
  },
);

skipOnWindows(
  'refuses a state base that is a link another local user could have planted',
  async () => {
    // The same shape minus the one thing that made it the operator's own: the directory that holds the base
    // belongs to a co-user, so they can swap the link for one pointing wherever they like between two of this
    // call's steps. The walk above the base judges that parent, refuses it, and nothing is created at all.
    const shared = fs.realpathSync(mkdtempForTestSync('agent-device-state-link-shared-'));
    fs.chmodSync(shared, 0o777);
    const target = path.join(shared, 'outside');
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    const base = path.join(shared, 'agent-device');
    fs.symlinkSync(target, base);
    const sessions = path.join(base, 'sessions');

    expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions, base))).toBe(1);

    expect(originals.lstatSync(sessions, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readdirSync(target)).toEqual([]);
    expect(modeOf(target)).toBe(0o755);
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

skipOnWindows(
  'reports an unjudgeable base instead of throwing when the ancestry walk itself fails',
  async () => {
    // The ancestry walk is made of `lstat` calls too, and one of them can fail for a reason that has nothing
    // to do with this chain: `EIO` on a dying volume, `ESTALE` on a mount that moved. Nothing here decides
    // whether the daemon starts, so an error from the walk may not travel past it — startup would die over a
    // mode. What has to come back instead is the ordinary skip: one diagnostic, no private ground.
    const base = mkdtempForTestSync('agent-device-state-ancestry-errno-');
    fs.chmodSync(base, 0o700);
    const sessions = path.join(base, 'sessions');
    fs.mkdirSync(sessions);
    fs.chmodSync(sessions, 0o755);
    // Denied ABOVE the base: this is a step of the walk, not of the descent, and the repair never gets as far
    // as the level whose mode it would have forced.
    denyCall('lstatSync', (argument) => String(argument) === path.dirname(base), ancestorFailure);

    const { answer, skips } = await withDiagnosticsScope({ session: 'daemon' }, () => ({
      answer: ensurePrivateDaemonStateDir(sessions, base),
      skips: countDiagnosticEventsByPhase(SKIPPED),
    }));

    expect(answer.privateChain).toBe(false);
    expect(skips).toBe(1);
    // Creation is the caller's own business and went through, and the repair stopped before forcing anything.
    expect(fs.lstatSync(sessions).isDirectory()).toBe(true);
    expect(modeOf(sessions)).toBe(0o755);
  },
);

skipOnWindows(
  'refuses a state base whose name ends in a SEPARATOR, when that name is a link',
  async () => {
    // `AGENT_DEVICE_STATE_DIR=/trusted/state/` — a trailing slash is what a script or an expansion hands over.
    // Resolving `state/` is the kernel following the link at `state`, so the `lstat` of the base answers a
    // directory, the `O_NOFOLLOW` open opens the far side, and the `fchmod` that follows changes a mode nobody
    // asked it to. The reported shape: `outside` at 0755 becomes 0700 while the daemon calls the chain private.
    const trusted = mkdtempForTestSync('agent-device-state-trailing-slash-');
    fs.chmodSync(trusted, 0o700);
    const outside = path.join(trusted, 'outside');
    fs.mkdirSync(outside);
    fs.chmodSync(outside, 0o755);
    const spelled = `${path.join(trusted, 'state')}/`;
    fs.symlinkSync(outside, path.join(trusted, 'state'));

    const { answer, skips } = await withDiagnosticsScope({ session: 'daemon' }, () => ({
      answer: ensurePrivateDaemonStateDir(`${spelled}sessions`, spelled),
      skips: countDiagnosticEventsByPhase(SKIPPED),
    }));

    expect(answer.privateChain).toBe(false);
    expect(skips).toBe(1);
    // The mode the directory's owner chose, not the one a repair that stepped through the link would have forced.
    expect(modeOf(outside)).toBe(0o755);
  },
);

skipOnWindows('repairs the chain the walk reached, not the one the base spells', async () => {
  // The base is spelled `alias/../state`, which the kernel resolves as a step BACK out of wherever `alias`
  // physically stands: its real base is `actual/state`. Deriving the levels with `path.relative` and
  // `path.join` folds that step away, and the tail is then re-attached to `state` beside the ALIAS — a
  // different tree, one the ancestry was never asked about. Here that folded name is a link out of the state
  // tree, so a descent built from the spelling judges and forces a directory on the far side of a link nobody
  // walked, while the real chain the daemon writes under is left alone.
  const root = mkdtempForTestSync('agent-device-state-alias-base-');
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, 'actual', 'x'), { recursive: true });
  const alias = path.join(root, 'alias');
  fs.symlinkSync(path.join(root, 'actual', 'x'), alias);
  const state = path.join(root, 'actual', 'state');
  const sessions = path.join(state, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  // Left loose, the way a state dir made by an older version under a shared umask is found.
  for (const directory of [state, sessions]) fs.chmodSync(directory, 0o755);
  // The name the folded spelling leads to, and the directory its link leads to: the mode the old descent
  // forced there belongs to a tree this call has nothing to do with.
  const outside = path.join(root, 'outside');
  const farSessions = path.join(outside, 'sessions');
  fs.mkdirSync(farSessions, { recursive: true });
  for (const directory of [outside, farSessions]) fs.chmodSync(directory, 0o755);
  fs.symlinkSync(outside, path.join(root, 'state'));

  const base = `${alias}/../state`;
  const { answer, skips } = await withDiagnosticsScope({ session: 'daemon' }, () => ({
    answer: ensurePrivateDaemonStateDir(`${base}/sessions`, base),
    skips: countDiagnosticEventsByPhase(SKIPPED),
  }));

  // The chain the walk arrived at, repaired and reported as it is: nothing here had to be refused.
  expect(answer.privateChain).toBe(true);
  expect(skips).toBe(0);
  expect(modeOf(state)).toBe(0o700);
  expect(modeOf(sessions)).toBe(0o700);
  // The folded spelling was never judged, so nothing on it is touched — which is the point. A descent built
  // off the spelled base reached `state/sessions` through that link and forced its mode.
  expect(modeOf(farSessions)).toBe(0o755);
  expect(fs.lstatSync(path.join(root, 'state')).isSymbolicLink()).toBe(true);
});

/** The host error an ancestry walk can only answer by stopping: it cannot judge ground it could not read. */
const ancestorFailure = Object.assign(new Error('test EIO'), { code: 'EIO' });

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

skipOnWindows(
  'still makes the state it runs on over an ancestor it will not judge, never a script destination',
  async () => {
    // The same shared-ancestor ground the startup case builds, asked of the two entry points directly. A
    // caller that writes no script under the directory is given that directory: the daemon's log, lock and
    // every artifact path sit below it, and a recursive `mkdir` has always made it. A script destination on
    // the same chain is refused and created nowhere (#4584 review).
    const shared = mkdtempForTestSync('agent-device-state-untrusted-own-');
    fs.chmodSync(shared, 0o777);
    const base = path.join(shared, 'agent-device');
    const remote = path.join(base, 'sessions', 'remote-scripts');

    // The mode is what this process's own recursive `mkdir` gives it under the current umask; the repair
    // forces nothing here, so the pin is ownership rather than one particular spelling of the bits.
    expect(await skipCountFor(() => ensureDaemonStateDir(base, base))).toBe(1);
    expect(Number(fs.lstatSync(base).uid)).toBe(process.getuid?.() ?? -1);
    expect(modeOf(base) & 0o700).toBe(0o700);

    expect(ensurePrivateDaemonStateDir(remote, base)).toEqual({
      path: remote,
      privateChain: false,
    });
    expect(fs.existsSync(remote)).toBe(false);
    expect(fs.readdirSync(base)).toEqual([]);
  },
);

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
