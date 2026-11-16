import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
// oxlint-disable-next-line no-restricted-imports -- the fixture's private group is named after os.userInfo()'s user, not a scratch path
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import {
  assertPrivateScriptDestination,
  privateGroupIds,
  publishDirectoryIdentity,
  publishScriptFileSync,
} from './atomic-file.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

/** The group database a test stands in for `/etc/group` and `/etc/passwd`. */
type Database = Readonly<{ groups: readonly string[]; passwd: readonly string[] }>;

const realReadFileSync = fs.readFileSync;
const currentUser = os.userInfo().username;

/** This process's ids. Windows has neither, and every test that uses them is skipped there. */
const currentUid = process.getuid?.() ?? -1;
const currentGid = process.getgid?.() ?? -1;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Serves `database` for the two group files and the real host for everything else, so the
 * private-group decision is the fixture's and not the CI image's user list.
 */
function serveGroupDatabase(database: Database): void {
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, options?: unknown) => {
    if (file === '/etc/group') return `${database.groups.join('\n')}\n`;
    if (file === '/etc/passwd') return `${database.passwd.join('\n')}\n`;
    return realReadFileSync(file as never, options as never) as never;
  }) as typeof fs.readFileSync);
}

/** This host's user with a group of their own, and a team group that holds someone else. */
function hostDatabase(privateGid: number, sharedGid: number): Database {
  return {
    groups: ['root:x:0:root', `${currentUser}:x:${privateGid}:`, `team:x:${sharedGid}:ada`],
    passwd: [`root:x:0:0`, `${currentUser}:x:${currentUid}:${privateGid}:`],
  };
}

function root(): string {
  return fs.realpathSync(mkdtempForTestSync('host-kit-ancestry-'));
}

/** A directory carrying `mode` and `gid`, so the rule reads the group the test chose. */
function directoryWith(directory: string, mode: number, gid = currentGid): string {
  fs.mkdirSync(directory);
  fs.chownSync(directory, currentUid, gid);
  fs.chmodSync(directory, mode);
  return directory;
}

function publish(destination: string, parentIdentity?: string): void {
  publishScriptFileSync({
    destination,
    contents: 'context\n',
    ...(parentIdentity === undefined ? {} : { parentIdentity }),
  });
}

function expectUntrusted(run: () => void, exposure: string, ancestor: string): void {
  expectRefusal(run, 'script_ancestor_untrusted', exposure, ancestor);
}

function expectUntrustedReplaced(run: () => void, ancestor: string): void {
  expectRefusal(run, 'script_ancestry_replaced', 'parent_replaced', ancestor);
}

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

// --- a chain another local user can act inside is refused ---

skipOnWindows('publishes to a chain only this user can write', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const workflows = path.join(root(), 'workflows');
  fs.mkdirSync(workflows);

  publish(path.join(workflows, 'journey.ad'));

  expect(fs.readFileSync(path.join(workflows, 'journey.ad'), 'utf8')).toBe('context\n');
});

skipOnWindows('refuses a destination under a world-writable directory', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const shared = directoryWith(path.join(root(), 'shared'), 0o777);
  const destination = path.join(shared, 'journey.ad');

  expectUntrusted(() => publish(destination), 'world_writable', shared);
  expect(fs.existsSync(destination)).toBe(false);
});

skipOnWindows('refuses a world-writable ancestor above the parent', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const shared = directoryWith(path.join(root(), 'shared'), 0o777);
  const work = path.join(shared, 'work');
  fs.mkdirSync(work);

  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(work, 'journey.ad')),
    'world_writable',
    shared,
  );
});

skipOnWindows('refuses a destination under a group-writable shared directory', () => {
  const gid = currentGid;
  serveGroupDatabase(hostDatabase(4321, gid));
  const team = directoryWith(path.join(root(), 'team'), 0o775, gid);
  const sub = path.join(team, 'sub');
  fs.mkdirSync(sub);

  expectUntrusted(() => publish(path.join(sub, 'journey.ad')), 'shared_group_writable', team);
  expect(fs.readdirSync(sub)).toEqual([]);
});

// --- the Ubuntu and Debian private-group home keeps working ---

skipOnWindows('publishes to a group-writable home directory of a private group', () => {
  const gid = currentGid;
  serveGroupDatabase(hostDatabase(gid, 4321));
  const home = directoryWith(path.join(root(), 'home'), 0o775, gid);

  publish(path.join(home, 'journey.ad'));

  expect(fs.readFileSync(path.join(home, 'journey.ad'), 'utf8')).toBe('context\n');
});

skipOnWindows("refuses the same mode and group once the group is not the user's own", () => {
  const gid = currentGid;
  serveGroupDatabase(hostDatabase(4321, gid));
  const home = directoryWith(path.join(root(), 'home'), 0o775, gid);

  expectUntrusted(() => publish(path.join(home, 'journey.ad')), 'shared_group_writable', home);
});

skipOnWindows('publishes to a setgid group-writable private-group home', () => {
  const gid = currentGid;
  serveGroupDatabase(hostDatabase(gid, 4321));
  const home = directoryWith(path.join(root(), 'home'), 0o2775, gid);

  publish(path.join(home, 'journey.ad'));

  expect(fs.existsSync(path.join(home, 'journey.ad'))).toBe(true);
});

// --- a sticky shared directory is safe, except through a link planted in it ---

skipOnWindows('publishes to a destination under a sticky world-writable directory', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const shared = directoryWith(path.join(root(), 'shared'), 0o1777);

  publish(path.join(shared, 'journey.ad'));

  expect(fs.existsSync(path.join(shared, 'journey.ad'))).toBe(true);
});

skipOnWindows('refuses a symbolic link planted in a directory others can write', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const shared = directoryWith(path.join(directory, 'shared'), 0o1777);
  const attacker = path.join(directory, 'attacker');
  fs.mkdirSync(attacker);
  fs.symlinkSync(attacker, path.join(shared, 'work'));

  expectUntrusted(
    () => assertPrivateScriptDestination(path.join(shared, 'work', 'journey.ad')),
    'planted_link',
    path.join(shared, 'work'),
  );
  expect(fs.readdirSync(attacker)).toEqual([]);
});

skipOnWindows('follows a symbolic link inside a directory only this user can write', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const real = path.join(directory, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(directory, 'link'));

  publish(path.join(directory, 'link', 'journey.ad'));

  expect(fs.existsSync(path.join(real, 'journey.ad'))).toBe(true);
});

// --- the destination directory swapped out while the file was staged ---

skipOnWindows('refuses a parent replaced by name while the file was staged', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const staged = path.join(directory, 'work');
  fs.mkdirSync(staged);
  const parentIdentity = publishDirectoryIdentity(staged);
  const destination = path.join(staged, 'journey.ad');
  fs.rmSync(staged, { recursive: true });
  const replaced = path.join(directory, 'work');
  fs.mkdirSync(replaced);

  expectUntrustedReplaced(() => publish(destination, parentIdentity), replaced);
  expect(fs.readdirSync(replaced)).toEqual([]);
});

skipOnWindows('re-checks the chain after staging the file, before the entry is created', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const directory = root();
  const staged = path.join(directory, 'work');
  fs.mkdirSync(staged);
  const destination = path.join(staged, 'journey.ad');
  const writeFileSync = fs.writeFileSync;
  // The window a second local user races: the file is staged, the entry is not created yet.
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
    const result = (writeFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(staged);
    fs.chmodSync(staged, 0o777);
    return result;
  }) as typeof fs.writeFileSync);

  expectUntrustedReplaced(() => publish(destination), staged);
  expect(fs.readdirSync(staged)).toEqual([]);
});

skipOnWindows('publishes into the parent the captured identity still names', () => {
  serveGroupDatabase(hostDatabase(currentGid, 4321));
  const staged = path.join(root(), 'work');
  fs.mkdirSync(staged);

  publish(path.join(staged, 'journey.ad'), publishDirectoryIdentity(staged));

  expect(fs.existsSync(path.join(staged, 'journey.ad'))).toBe(true);
});

// --- privateGroupIds: the one group shape the exception admits ---

const ADA = { uid: 1000, name: 'ada' };

function database(groups: readonly string[], passwd: readonly string[]) {
  return { groups, passwd };
}

test('treats the group named after the user, holding only them, as private', () => {
  const ids = privateGroupIds(
    database(['ada:x:1000:', 'staff:x:20:root'], ['ada:x:1000:1000:', 'root:x:0:0']),
    ADA,
  );
  expect([...ids]).toEqual([1000]);
});

test('treats a group as private when only its primary-group link names the user', () => {
  const ids = privateGroupIds(
    database(['ada:x:1000:', 'staff:x:20:'], ['root:x:0:0', 'ada:x:1000:1000:']),
    ADA,
  );
  expect([...ids]).toEqual([1000]);
});

test('still treats a group as private with root among its members', () => {
  const ids = privateGroupIds(
    database(['ada:x:1000:root', 'staff:x:20:'], ['ada:x:1000:1000:', 'root:x:0:0']),
    ADA,
  );
  expect([...ids]).toEqual([1000]);
});

test('treats the group named after the user as shared once another user is a member', () => {
  const ids = privateGroupIds(
    database(
      ['ada:x:1000:grace', 'staff:x:20:'],
      ['ada:x:1000:1000:', 'grace:x:1001:1001:', 'root:x:0:0'],
    ),
    ADA,
  );
  expect([...ids]).toEqual([]);
});

test('treats the group named after the user as shared once another user has it as primary group', () => {
  const ids = privateGroupIds(
    database(['ada:x:1000:', 'staff:x:20:'], ['ada:x:1000:1000:', 'grace:x:1001:1000:']),
    ADA,
  );
  expect([...ids]).toEqual([]);
});

test('never treats another group name as private, however few members it lists', () => {
  const ids = privateGroupIds(database(['team:x:4321:', 'ada:x:1000:'], ['ada:x:1000:1000:']), ADA);
  expect([...ids]).toEqual([1000]);
});

test('treats an unreadable group database as having no private group', () => {
  expect([...privateGroupIds(database([], []), ADA)]).toEqual([]);
});

test('gives a caller without a full identity no private group', () => {
  const groups = database(['ada:x:1000:'], ['ada:x:1000:1000:']);
  expect([...privateGroupIds(groups, { uid: undefined, name: 'ada' })]).toEqual([]);
  expect([...privateGroupIds(groups, { uid: 1000, name: undefined })]).toEqual([]);
});
