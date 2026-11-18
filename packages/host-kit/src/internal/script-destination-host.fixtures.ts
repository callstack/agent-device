// The host this suite's destinations are judged against: the directory owners a test chooses, and the scratch
// directories it builds them on. The ancestry rule reads the real host for its own identity, so a test that
// leaves that alone is asserting against whatever account the machine it runs on happens to have.

import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { publishScriptFileSync } from './script-destination.ts';

/** A test that needs POSIX ownership or POSIX path rules, skipped on Windows. */
export const skipOnWindows: typeof test.skip = process.platform === 'win32' ? test.skip : test;

/** Every entry under `directory`, so a refusal can show it created nothing anywhere below it. */
export function tree(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true }).map(String).sort();
}

/** This process's uid. Windows has none, and every test that uses it is skipped there. */
export const currentUid = process.getuid?.() ?? -1;

/** The group a directory gets when a test does not name one: this user's primary group. */
export const currentGid = process.getgid?.() ?? -1;

/**
 * Some other local user: not the one running the suite, and not root.
 *
 * Ownership is judged against this process's own uid, so naming a fixed id only makes an entry foreign while the
 * suite stands somewhere else: CI runs a suite as `nobody` (65534), and there a hard-coded 65534 makes every
 * "foreign" case this user's own directory, so the ownership boundary is asserted nowhere at all. The same rule
 * is written in `@agent-device/test-kit`'s `host-ownership.fixtures.ts`; a package's tests may not reach
 * test-kit, and one package may not publish test support to another (R83), so each keeps its own copy — change
 * all three together: this one, test-kit's, and host-swift's `swift-cache-trust.test.ts`.
 */
export const FOREIGN_UID = (process.getuid?.() ?? -1) === 65534 ? 65533 : 65534;

/** A scratch root, spelled the way the kernel spells it, so a link's answer and a test's agree. */
export function ancestryRoot(): string {
  return fs.realpathSync(mkdtempForTestSync('host-kit-ancestry-'));
}

/**
 * A directory carrying `mode`, owned by this user. The ownership is set explicitly because a scratch
 * directory inherits one from its parent, not necessarily this user's.
 *
 * The mode is set with the host's real `chmod`, captured before any test installs a spy: a test that mocks
 * `chmodSync` to make a repair fail would otherwise be unable to build the directory it is testing.
 */
export function directoryWith(directory: string, mode: number): string {
  fs.mkdirSync(directory);
  fs.chownSync(directory, currentUid, currentGid);
  realChmodSync(directory, mode);
  return directory;
}

/** Captured at import, so a test's `chmodSync` spy cannot reach a fixture's own setup. */
const realChmodSync = fs.chmodSync.bind(fs);

/** A publication of fixed contents, so a test says which destination and not what bytes. */
export function publish(destination: string): void {
  publishScriptFileSync({ destination, contents: 'context\n' });
}

/** The unmocked lookup, so serving an owner never wraps a previously served one. */
const realLstatSync = fs.lstatSync.bind(fs);

/**
 * Reports `owners` for the named paths and the real host for everything else, so the ownership rule is
 * the fixture's and not the CI image's directory tree. Only the ids move: modes and inode numbers stay
 * what they are on disk.
 *
 * `lstat` is the only lookup served, because `lstat` is the only one host-kit's rules ask an ownership answer
 * from: the walk judges every name it resolves from its own `lstat` of the NAME, and the state boundary judges
 * the entry it opened by `fstat` of the descriptor it holds. `@agent-device/test-kit`'s `serveHostOwnership`
 * serves `stat` too, for rules outside this package. A package's tests may not reach test-kit, and one package
 * may not publish test support to another (R83), so each keeps its own copy — change both together.
 */
export function serveOwnership(owners: Readonly<Record<string, number>>): void {
  vi.spyOn(fs, 'lstatSync').mockImplementation(((name: never, ...rest: never[]) => {
    const stats = realLstatSync(name, ...rest);
    const uid = owners[String(name)];
    // Node hands a fresh Stats to every call, so the served id goes on that object and on nothing else. It
    // keeps the type the caller asked for: ids come back as bigint or as numbers depending on the options.
    if (stats !== undefined && uid !== undefined) {
      (stats as { uid: number | bigint }).uid = typeof stats.uid === 'bigint' ? BigInt(uid) : uid;
    }
    return stats;
  }) as typeof fs.lstatSync);
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
