// The daemon forces its own state directories to 0700, because the script-destination rule refuses a
// group-writable directory on the chain (ADR 0016). What this suite pins is the OTHER half: a state level
// whose mode this process may not force is SKIPPED with a warning, and the call still returns. A state
// repair never decides whether the daemon starts; the destination walk is the only thing that refuses.
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

afterEach(() => {
  vi.restoreAllMocks();
});

skipOnWindows('repairs the state directories it owns, whatever mode they were created with', () => {
  // An older version, or a checkout shared under umask 002, leaves `sessions/` at 0775 and the daemon then
  // refuses its own recordings. Repair is what fixes a host it did not create, so it has to work.
  const base = mkdtempForTestSync('agent-device-state-repair-');
  fs.chmodSync(base, 0o755);
  const sessions = path.join(base, 'sessions');
  const remote = path.join(sessions, 'remote-scripts');
  for (const directory of [sessions, remote]) {
    fs.mkdirSync(directory);
    fs.chmodSync(directory, 0o775);
  }

  // How the daemon actually calls it: startup ensures `sessions/`, the remote writer ensures
  // `remote-scripts/`, and each call repairs the levels it was asked for.
  ensurePrivateDaemonStateDir(sessions);
  expect(ensurePrivateDaemonStateDir(remote)).toBe(remote);

  for (const directory of [sessions, remote]) {
    expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700);
  }
});

skipOnWindows('asks nothing of a level that already stands private', () => {
  // The fast path, and the reason a normal start costs no extra work: a 0700 level is already what the
  // repair would force, so it is not even opened. Deleting the mode check makes this red.
  const base = mkdtempForTestSync('agent-device-state-private-');
  const sessions = path.join(base, 'sessions');
  fs.mkdirSync(sessions);
  fs.chmodSync(sessions, 0o700);
  const open = vi.spyOn(fs, 'openSync');

  ensurePrivateDaemonStateDir(sessions);

  expect(open).not.toHaveBeenCalled();
});

skipOnWindows('skips a state name that is a link, and leaves where it leads alone', async () => {
  // Repair reaches a legacy state directory another local user could write, and they use that write to
  // leave a link at `sessions`. A `chmod` given the NAME travels through it, so a root daemon forcing its
  // own state private would change the mode of a directory somebody else chose. So the mode is applied
  // through an `O_NOFOLLOW` descriptor instead, and a link cannot be opened as one: this call skips the
  // level, and the daemon starts as it did before the repair judged links at all.
  const base = mkdtempForTestSync('agent-device-state-link-');
  fs.chmodSync(base, 0o777);
  const planted = path.join(base, 'other-users-home');
  fs.mkdirSync(planted);
  fs.chmodSync(planted, 0o777);
  const sessions = path.join(base, 'sessions');
  fs.symlinkSync(planted, sessions);

  expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions))).toBe(1);

  // Nothing was changed: the mode the owner set is still the mode the directory has, the link is still a
  // link rather than a directory this call made, and nothing was created on its far side.
  expect(fs.lstatSync(planted).mode & 0o777).toBe(0o777);
  expect(fs.readdirSync(planted)).toEqual([]);
  expect(fs.lstatSync(sessions).isSymbolicLink()).toBe(true);
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

  expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions))).toBe(1);

  expect(fs.lstatSync(sessions).mode & 0o777).toBe(0o775);
});

skipOnWindows(
  'skips a state directory the host will not let it open, and starts anyway',
  async () => {
    // `EACCES` from the open is what a read-only mount, or a directory this user cannot even read, answers
    // with. A root process CAN open a 0000 directory it owns, so the denial is injected at the seam the mode
    // is forced through rather than staged as a mode: that keeps this the same case on any uid. Startup must
    // not die on a host it cannot fix, which is the rule `repairStateMode` already applied to the log file.
    const base = mkdtempForTestSync('agent-device-state-unopenable-');
    const sessions = path.join(base, 'sessions');
    fs.mkdirSync(sessions);
    fs.chmodSync(sessions, 0o755);
    const denied = Object.assign(new Error('test open denied'), { code: 'EACCES' });
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((
      target: fs.PathLike | number,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ) => {
      if (target === sessions) throw denied;
      return realOpen(target as fs.PathLike, flags, mode);
    }) as typeof fs.openSync);

    expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions))).toBe(1);

    expect(fs.lstatSync(sessions).mode & 0o777).toBe(0o755);
  },
);

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
