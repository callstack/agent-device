// The host this suite's destinations are judged against: the directory owners a test chooses, and the
// scratch directories it builds them in. The ancestry rule reads the real host for its own identity, so a
// test that leaves that alone is asserting against whatever account the machine it runs on happens to have.

import { expect, vi } from 'vitest';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { publishScriptFileSync } from './atomic-file.ts';
import { PRIVATE_GROUP_HOST_FILES } from './owner-identity.ts';

/** This process's uid. Windows has none, and every test that uses it is skipped there. */
export const currentUid = process.getuid?.() ?? -1;

/** The group a directory gets when a test does not name one: this user's primary group. */
export const currentGid = process.getgid?.() ?? -1;

/**
 * Answers the three account files the private-group exception reads, for tests that must not depend on the
 * machine's own name service. Each test that judges a group-writable directory names which host it is stood
 * on: a real `/etc/nsswitch.conf` differs between a container, a CI runner and a developer's laptop, so a test
 * that left these alone would pass on one and fail on another for a reason that has nothing to do with the
 * rule under test. `vi.restoreAllMocks()` in the suite's `afterEach` takes the answer away again.
 */
function seedAccountFiles(files: Record<string, string>): void {
  const real = fs.readFileSync;
  const seedable: ReadonlySet<string> = new Set(Object.values(PRIVATE_GROUP_HOST_FILES));
  vi.spyOn(fs, 'readFileSync').mockImplementation(((pathname: unknown, ...rest: unknown[]) => {
    const name = String(pathname);
    const seeded = files[name];
    if (seeded !== undefined) return seeded;
    if (seedable.has(name)) throw new Error(`ENOENT: no seeded account file ${name}`);
    return (real as (...args: unknown[]) => unknown)(pathname, ...rest);
  }) as typeof fs.readFileSync);
}

/**
 * The account name the seeded records use. The rule compares the name in the passwd record with the members
 * each group line lists, so any name both files agree on proves as much as the machine's real one, and the
 * account a CI runner runs under may have no readable record at all.
 */
const SEEDED_ACCOUNT = 'tester';

/** This user's own login and private group, spelled for the seeded databases. */
const OWN_ACCOUNT_RECORDS = {
  [PRIVATE_GROUP_HOST_FILES.passwd]: `${SEEDED_ACCOUNT}:x:${String(currentUid)}:${String(
    currentGid,
  )}:${SEEDED_ACCOUNT},,,:/home/${SEEDED_ACCOUNT}:/bin/bash\n`,
  [PRIVATE_GROUP_HOST_FILES.group]: `${SEEDED_ACCOUNT}:x:${String(currentGid)}:\n`,
};

/**
 * The stock Ubuntu and Debian shape: `files` and `systemd` only, this user's own login, and a private group
 * carrying this user alone. Under it a group-writable home is ground with nobody else in it.
 */
export function seedPrivateGroupHost(): void {
  seedAccountFiles({
    ...OWN_ACCOUNT_RECORDS,
    [PRIVATE_GROUP_HOST_FILES.nsswitch]: 'passwd: files systemd\ngroup: files systemd\n',
  });
}

/**
 * A host that answers membership from somewhere other than its own root-owned files. The exception cannot
 * settle a group on such a host, so a group-writable directory keeps its refusal no matter who owns it.
 */
export function seedUntrustedMembershipHost(): void {
  seedAccountFiles({
    ...OWN_ACCOUNT_RECORDS,
    [PRIVATE_GROUP_HOST_FILES.nsswitch]: 'passwd: files ldap\ngroup: files ldap\n',
  });
}

/**
 * A host with the local records in place but no name-service configuration at all: nothing says which
 * service answers membership, so nothing is proven and a group-writable directory keeps its refusal.
 */
export function seedMissingNsswitchHost(): void {
  seedAccountFiles(OWN_ACCOUNT_RECORDS);
}

/**
 * Some other local user: not the one running the suite, and not root.
 *
 * Ownership is judged against this process's own uid, so naming a fixed id only makes an entry foreign while the
 * suite stands somewhere else: CI runs a suite as `nobody` (65534), and there a hard-coded 65534 makes every
 * "foreign" case this user's own directory, so the ownership boundary is asserted nowhere at all. The same rule
 * is written in `@agent-device/test-kit`'s `host-ownership.fixtures.ts`; a package's tests may not reach
 * test-kit, and one package may not publish test support to another (R83), so each keeps its own copy — change
 * both together.
 */
export const FOREIGN_UID = (process.getuid?.() ?? -1) === 65534 ? 65533 : 65534;

/** A scratch root, spelled the way the kernel spells it, so a link's answer and a test's agree. */
export function ancestryRoot(): string {
  return fs.realpathSync(mkdtempForTestSync('host-kit-ancestry-'));
}

/**
 * A directory carrying `mode`, owned by this user. The ownership is set explicitly because a scratch
 * directory inherits one from its parent, not necessarily this user's.
 */
export function directoryWith(directory: string, mode: number): string {
  fs.mkdirSync(directory);
  fs.chownSync(directory, currentUid, currentGid);
  fs.chmodSync(directory, mode);
  return directory;
}

/** A publication of fixed contents, so a test says which destination and not what bytes. */
export function publish(destination: string): void {
  publishScriptFileSync({ destination, contents: 'context\n' });
}

/** Runs `run` under `process.umask(0o002)` — the umask of a shared checkout that breaks a mode-less `mkdir`. */
export function withSharedUmask(run: () => void): void {
  const previous = process.umask(0o002);
  try {
    run();
  } finally {
    process.umask(previous);
  }
}

export function expectUntrusted(run: () => void, exposure: string, ancestor: string): void {
  expectRefusal(run, 'script_ancestor_untrusted', exposure, ancestor);
}

export function expectUntrustedReplaced(run: () => void, ancestor: string): void {
  expectRefusal(run, 'script_ancestry_replaced', 'parent_replaced', ancestor);
}

/** Asserts the typed refusal a destination earns, naming the directory at fault. */
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

/** The permission bits of an entry, with the type and set-id bits cut off. */
export function modeOf(pathname: string): number {
  return fs.lstatSync(pathname).mode & 0o777;
}
