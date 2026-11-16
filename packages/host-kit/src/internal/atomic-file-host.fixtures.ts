// The host this suite's destinations are judged against: a group and passwd database the test names,
// directory owners the test chooses, and the scratch directories it builds them in. The ancestry rule reads
// the real host for its own identity, so a test that leaves those two alone is asserting against whatever
// accounts and modes the machine it runs on happens to have.

import { expect, vi } from 'vitest';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { publishScriptFileSync } from './atomic-file.ts';

/** The group database a test stands in for `/etc/group` and `/etc/passwd`. */
export type Database = Readonly<{
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
export const currentUser = process.env.USER ?? '';

/** This process's ids. Windows has neither, and every test that uses them is skipped there. */
export const currentUid = process.getuid?.() ?? -1;
export const currentGid = process.getgid?.() ?? -1;

/**
 * Serves `database` for the two group files and the real host for everything else, so the
 * private-group decision is the fixture's and not the CI image's user list.
 */
export function serveGroupDatabase(database: Database): void {
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
export function hostDatabase(privateGid: number, sharedGid: number): Database {
  return {
    groups: ['root:x:0:root', `${currentUser}:x:${privateGid}:`, `team:x:${sharedGid}:ada`],
    passwd: [`root:x:0:0`, `${currentUser}:x:${currentUid}:${privateGid}:`],
    nsswitch: undefined,
  };
}

/** The database of a host whose group files cannot be read at all. */
export function unreadableDatabases(): Database {
  return { groups: undefined, passwd: undefined };
}

/** Some other local user, not this one and not root. */
export const FOREIGN_UID = 65534;

/** A scratch root, spelled the way the kernel spells it, so a link's answer and a test's agree. */
export function ancestryRoot(): string {
  return fs.realpathSync(mkdtempForTestSync('host-kit-ancestry-'));
}

/**
 * A directory carrying `mode` and `gid`, so the rule reads the group the test chose. The group is set
 * explicitly because a scratch directory inherits one from its parent, not necessarily this user's.
 */
export function directoryWith(directory: string, mode: number, gid = currentGid): string {
  fs.mkdirSync(directory);
  fs.chownSync(directory, currentUid, gid);
  fs.chmodSync(directory, mode);
  return directory;
}

/** A publication of fixed contents, so a test says which destination and not what bytes. */
export function publish(destination: string): void {
  publishScriptFileSync({ destination, contents: 'context\n' });
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
