// The daemon forces its own state directories to 0700, because the script-destination rule refuses a
// group-writable directory on the chain (ADR 0016). What this suite pins is the OTHER half: a state name
// this process may not touch is refused with nothing changed, rather than repaired through the name.
// (https://github.com/callstack/agent-device/pull/4584)

import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FOREIGN_UID, mkdtempForTestSync, serveHostOwnership } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { ensurePrivateDaemonStateDir } from './daemon-registration-owner.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

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

skipOnWindows('refuses a state name that is a link, and leaves where it leads alone', () => {
  // Repair reaches a legacy state directory another local user could write, and they use that write to
  // leave a link at `sessions`. A `chmod` given the NAME travels through it, so a root daemon forcing its
  // own state private would be changing the mode of a directory somebody else chose. The link itself is the
  // refusal: it is not the directory this call was told to make private.
  const base = mkdtempForTestSync('agent-device-state-link-');
  fs.chmodSync(base, 0o777);
  const planted = path.join(base, 'other-users-home');
  fs.mkdirSync(planted);
  fs.chmodSync(planted, 0o777);
  const sessions = path.join(base, 'sessions');
  fs.symlinkSync(planted, sessions);

  expectRefusal(() => ensurePrivateDaemonStateDir(sessions), 'state_dir_not_a_directory', sessions);

  // Nothing was changed: the mode the owner set is still the mode the directory has, and no state
  // directory appeared under the name.
  expect(fs.lstatSync(planted).mode & 0o777).toBe(0o777);
  expect(fs.lstatSync(sessions).isSymbolicLink()).toBe(true);
});

skipOnWindows('refuses a state directory another user owns, and leaves its mode', () => {
  // Ownership is judged from the same `lstat` the destination rule judges ground by, so a root daemon
  // repairs root-owned state and does NOT strip access from a directory somebody else owns — which a
  // `chmod 0700` by pathname would have done to their files.
  const base = mkdtempForTestSync('agent-device-state-foreign-');
  fs.chmodSync(base, 0o755);
  const sessions = path.join(base, 'sessions');
  fs.mkdirSync(sessions);
  fs.chmodSync(sessions, 0o775);
  serveHostOwnership({ [sessions]: FOREIGN_UID });

  expectRefusal(() => ensurePrivateDaemonStateDir(sessions), 'state_dir_foreign_owned', sessions);

  expect(fs.lstatSync(sessions).mode & 0o777).toBe(0o775);
});

skipOnWindows('warns and changes nothing when a state directory cannot be opened at all', () => {
  // A state directory left at 0000 is this process's own, so ownership does not refuse it, and no
  // descriptor can be opened to force its mode. Repair reports that and moves on: startup must not die on a
  // host it cannot fix, which is the rule `repairStateMode` already applied to a read-only mount.
  const base = mkdtempForTestSync('agent-device-state-unreadable-');
  fs.chmodSync(base, 0o755);
  const sessions = path.join(base, 'sessions');
  fs.mkdirSync(sessions);
  fs.chmodSync(sessions, 0o000);

  try {
    expect(() => ensurePrivateDaemonStateDir(sessions)).not.toThrow();
    expect(fs.lstatSync(sessions).mode & 0o777).toBe(0o000);
  } finally {
    fs.chmodSync(sessions, 0o700);
  }
});

/** The typed refusal the repair answers with, naming the state path it would not touch. */
function expectRefusal(run: () => void, reason: string, target: string): void {
  let seen: AppError | undefined;
  try {
    run();
  } catch (error) {
    seen = error instanceof AppError ? error : undefined;
  }
  expect(seen?.details).toMatchObject({ reason, path: target });
}
