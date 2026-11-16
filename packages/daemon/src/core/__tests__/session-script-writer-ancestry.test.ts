import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
// oxlint-disable-next-line no-restricted-imports -- the private-group fixture is named after os.userInfo()'s user, not a scratch path
import os from 'node:os';
import path from 'node:path';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { SessionScriptWriter } from '../session-script-writer.ts';
import { makeAuthoringSession } from '../../__tests__/support/session-factories.ts';

const hostCwd = createLiveTestHostEnvironment().cwd;
const skipOnWindows = process.platform === 'win32' ? test.skip : test;

const realReadFileSync = fs.readFileSync;
const currentUser = os.userInfo().username;

/** This process's ids. Windows has neither, and every test that uses them is skipped there. */
const currentUid = process.getuid?.() ?? -1;
const currentGid = process.getgid?.() ?? -1;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Serves `groups` and `passwd` for the two group files and the real host for everything else, so the
 * private-group decision is the fixture's and this file's assertions run on every POSIX host instead of
 * only on one whose `/etc/group` happens to agree.
 */
function serveGroupDatabase(groups: readonly string[], passwd: readonly string[]): void {
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, options?: unknown) => {
    if (file === '/etc/group') return `${groups.join('\n')}\n`;
    if (file === '/etc/passwd') return `${passwd.join('\n')}\n`;
    return realReadFileSync(file as never, options as never) as never;
  }) as typeof fs.readFileSync);
}

/** This host's user owning `currentGid` alone, plus a team group that holds someone else. */
function privateGroupDatabase(): void {
  serveGroupDatabase(
    ['root:x:0:root', `${currentUser}:x:${currentGid}:`, 'team:x:4321:ada'],
    ['root:x:0:0', `${currentUser}:x:${currentUid}:${currentGid}:`],
  );
}

/** The same ids, with this host's group named after somebody else, so it is not private. */
function foreignGroupNameDatabase(): void {
  serveGroupDatabase(
    ['root:x:0:root', `${currentUser}:x:${currentGid + 1}:`, 'team:x:4321:ada'],
    ['root:x:0:0', `${currentUser}:x:${currentUid}:${currentGid}:`],
  );
}

function action(command: string): {
  ts: number;
  command: string;
  positionals: string[];
  flags: Record<string, unknown>;
} {
  return { ts: Date.now(), command, positionals: ['Demo'], flags: {} };
}

function recordingTo(destination: string) {
  return makeAuthoringSession('journey', {
    scriptPublication: {
      kind: 'authoring',
      status: 'armed',
      target: { kind: 'explicit', path: destination, force: false },
    },
    actions: [action('open')],
  });
}

function root(): string {
  return fs.realpathSync(mkdtempForTestSync('agent-device-script-ancestry-'));
}

function sharedDirectory(directory: string, mode: number): string {
  fs.mkdirSync(directory);
  fs.chmodSync(directory, mode);
  return directory;
}

/** A scratch directory in this host's own primary group, at `mode`. */
function homeDirectory(directory: string, mode: number): string {
  fs.mkdirSync(directory);
  fs.chownSync(directory, currentUid, currentGid);
  fs.chmodSync(directory, mode);
  return directory;
}

function writerFor(directory: string): SessionScriptWriter {
  return new SessionScriptWriter(path.join(directory, 'sessions'), hostCwd);
}

function refusal(result: ReturnType<SessionScriptWriter['write']>): Record<string, unknown> {
  expect(result.written).toBe(false);
  if (result.written || !result.error) throw new Error('expected a refused write');
  return result.error.details as Record<string, unknown>;
}

skipOnWindows('an ordinary recording saves under a chain only this user can write', () => {
  const directory = root();
  const destination = path.join(directory, 'workflows', 'journey.ad');

  const result = writerFor(directory).write(recordingTo(destination));

  expect(result.written).toBe(true);
  expect(fs.readFileSync(destination, 'utf8')).toContain('open');
});

skipOnWindows('a recording saves a script no other local user can read', () => {
  const directory = root();
  const destination = path.join(directory, 'workflows', 'journey.ad');

  const result = writerFor(directory).write(recordingTo(destination));

  expect(result.written).toBe(true);
  expect(fs.lstatSync(destination).mode & 0o777).toBe(0o600);
});

skipOnWindows('a recording refuses a destination under a world-writable directory', () => {
  const directory = root();
  const shared = sharedDirectory(path.join(directory, 'shared'), 0o777);
  const destination = path.join(shared, 'journey.ad');

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
  });
  expect(fs.existsSync(destination)).toBe(false);
});

skipOnWindows('a recording refuses a destination inside a directory another user owns', () => {
  const directory = root();
  const foreign = path.join(directory, 'foreign');
  fs.mkdirSync(foreign);
  fs.chmodSync(foreign, 0o755);
  const destination = path.join(foreign, 'journey.ad');
  // The directory is this test user's own, so the rule is run as somebody else: a real second local
  // user looking at a directory they cannot own but can read.
  vi.spyOn(process, 'getuid').mockReturnValue(currentUid === 65534 ? 65535 : 65534);

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'foreign_owned',
    ancestor: foreign,
  });
  expect(fs.existsSync(destination)).toBe(false);
});

skipOnWindows('a recording refuses an ancestor swapped out for a symbolic link', () => {
  const directory = root();
  const shared = sharedDirectory(path.join(directory, 'shared'), 0o777);
  const attacker = path.join(directory, 'attacker');
  fs.mkdirSync(attacker);
  fs.symlinkSync(attacker, path.join(shared, 'work'));
  const destination = path.join(shared, 'work', 'journey.ad');

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({ reason: 'script_ancestor_untrusted', exposure: 'planted_link' });
  expect(fs.readdirSync(attacker)).toEqual([]);
});

skipOnWindows('a recording refuses an ancestor whose target is a writable directory', () => {
  const directory = root();
  const shared = sharedDirectory(path.join(directory, 'shared'), 0o777);
  const privateWork = path.join(shared, 'private');
  fs.mkdirSync(privateWork);
  fs.symlinkSync(privateWork, path.join(directory, 'link'));
  const destination = path.join(directory, 'link', 'journey.ad');

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
    ancestor: shared,
  });
  expect(fs.readdirSync(privateWork)).toEqual([]);
});

skipOnWindows('a recording refuses an ancestor swapped out for a writable directory', () => {
  const directory = root();
  const work = path.join(directory, 'work');
  fs.mkdirSync(work);
  const destination = path.join(work, 'journey.ad');
  // Another local user replaces the destination directory by name before this write runs.
  fs.rmSync(work, { recursive: true });
  fs.mkdirSync(work);
  fs.chmodSync(work, 0o777);

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
  });
  expect(fs.readdirSync(work)).toEqual([]);
});

skipOnWindows('a recording still saves to a group-writable private-group home', () => {
  privateGroupDatabase();
  const directory = root();
  const home = homeDirectory(path.join(directory, 'home'), 0o775);
  const destination = path.join(home, 'journey.ad');

  const result = writerFor(directory).write(recordingTo(destination));

  expect(result.written).toBe(true);
  expect(fs.readFileSync(destination, 'utf8')).toContain('open');
});

skipOnWindows("a recording refuses the same home once the group is not this user's own", () => {
  foreignGroupNameDatabase();
  const directory = root();
  const home = homeDirectory(path.join(directory, 'home'), 0o775);

  const details = refusal(writerFor(directory).write(recordingTo(path.join(home, 'journey.ad'))));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'shared_group_writable',
    ancestor: home,
  });
});
