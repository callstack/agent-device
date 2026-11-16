import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FOREIGN_UID,
  createLiveTestHostEnvironment,
  mkdtempForTestSync,
  serveHostOwnership,
} from '@agent-device/test-kit';
import { SessionScriptWriter } from '../session-script-writer.ts';
import { makeAuthoringSession } from '../../__tests__/support/session-factories.ts';

const hostCwd = createLiveTestHostEnvironment().cwd;
const skipOnWindows = process.platform === 'win32' ? test.skip : test;

const realReadFileSync = fs.readFileSync;
/** The account the fixtures name for this process, the same one the rule reads back out of passwd. */
const currentUser = process.env.USER ?? '';

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
    // The private-group exception is admitted only where the host's own databases are the whole story.
    if (file === '/etc/nsswitch.conf') return 'passwd: files\ngroup: files\n';
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

  expect(details).toMatchObject({ reason: 'script_ancestor_untrusted', exposure: 'foreign_owned' });
  expect(fs.existsSync(destination)).toBe(false);
});

skipOnWindows('a recording refuses a directory another user made sticky and owns', () => {
  const directory = root();
  // `chmod 1777` on a directory of THEIRS: the sticky bit keeps me from clearing their entries, and does
  // nothing to stop them renaming the component my path runs through.
  const team = path.join(directory, 'team');
  fs.mkdirSync(team);
  fs.chmodSync(team, 0o1777);
  const destination = path.join(team, 'journey.ad');
  vi.spyOn(process, 'getuid').mockReturnValue(currentUid === 65534 ? 65535 : 65534);

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({ reason: 'script_ancestor_untrusted', exposure: 'foreign_owned' });
  expect(fs.readdirSync(team)).toEqual([]);
});

skipOnWindows('a recording refuses a shared directory another user claimed first', () => {
  const directory = root();
  // The `mkdir -p <shared>/recordings` shape in a sticky shared directory: whoever creates it owns it,
  // and the owner can swap it for one of their own whenever they like.
  const tmp = path.join(directory, 'tmp');
  fs.mkdirSync(tmp);
  fs.chmodSync(tmp, 0o1777);
  const recordings = path.join(tmp, 'recordings');
  fs.mkdirSync(recordings);
  fs.chmodSync(recordings, 0o755);
  const destination = path.join(recordings, 'journey.ad');
  vi.spyOn(process, 'getuid').mockReturnValue(currentUid === 65534 ? 65535 : 65534);

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({ reason: 'script_ancestor_untrusted', exposure: 'foreign_owned' });
  expect(fs.readdirSync(recordings)).toEqual([]);
});

skipOnWindows('a recording refuses an ancestor swapped out for a symbolic link', () => {
  const directory = root();
  const shared = sharedDirectory(path.join(directory, 'shared'), 0o777);
  const attacker = path.join(directory, 'attacker');
  fs.mkdirSync(attacker);
  fs.symlinkSync(attacker, path.join(shared, 'work'));
  const destination = path.join(shared, 'work', 'journey.ad');

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  // The shared ground itself is the first exposure: anyone can rename `work` aside there, sticky or not.
  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
  });
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

skipOnWindows('a recording refuses a private link standing on shared ground two levels up', () => {
  // `<root>/shared` is 0777 and not sticky, `<root>/shared/mine` is 0700, and `mine/rec` links to a
  // private directory. Every directory the destination's real path names is private, so only judging
  // each prefix the kernel traverses sees that another local user owns the ground under `mine` and `rec`.
  const directory = root();
  const shared = path.join(directory, 'shared');
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o777);
  const mine = path.join(shared, 'mine');
  fs.mkdirSync(mine);
  fs.chmodSync(mine, 0o700);
  const privateWork = path.join(directory, 'private');
  fs.mkdirSync(privateWork);
  fs.symlinkSync(privateWork, path.join(mine, 'rec'));
  const destination = path.join(mine, 'rec', 'journey.ad');

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
    ancestor: shared,
  });
  expect(fs.readdirSync(privateWork)).toEqual([]);
});

skipOnWindows('a recording refuses a chain that leaves a shared directory through a link', () => {
  // `~/rec -> <root>/srv/team/relay -> ~/chosen`. The team ground is 0777, and any teammate can swap the
  // `relay` link for a target of their own, though the destination's real path never names it.
  const directory = root();
  const home = path.join(directory, 'home');
  fs.mkdirSync(home);
  const team = path.join(directory, 'srv', 'team');
  fs.mkdirSync(team, { recursive: true });
  fs.chmodSync(team, 0o777);
  const chosen = path.join(directory, 'chosen');
  fs.mkdirSync(chosen);
  fs.chmodSync(chosen, 0o700);
  fs.symlinkSync(chosen, path.join(team, 'relay'));
  fs.symlinkSync(path.join(team, 'relay'), path.join(home, 'rec'));
  const destination = path.join(home, 'rec', 'journey.ad');

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
    ancestor: team,
  });
  expect(fs.readdirSync(chosen)).toEqual([]);
});

skipOnWindows('a recording refuses the directory a .. steps back into', () => {
  // `home/work -> priv/x`, and `priv/y` at 0777 while `home/y` is private. Normalizing the spelling first
  // answers `home/y`, so it accepts a write that the kernel lands in `priv/y`, where any local user can
  // take the recording.
  const directory = root();
  const home = path.join(directory, 'home');
  fs.mkdirSync(home);
  fs.chmodSync(home, 0o700);
  const priv = path.join(directory, 'priv');
  const privX = path.join(priv, 'x');
  fs.mkdirSync(privX, { recursive: true });
  const privY = path.join(priv, 'y');
  fs.mkdirSync(privY);
  fs.chmodSync(privY, 0o777);
  fs.mkdirSync(path.join(home, 'y'));
  fs.symlinkSync(privX, path.join(home, 'work'));
  const destination = `${home}/work/../y/journey.ad`;

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
    ancestor: privY,
  });
  expect(fs.readdirSync(privY)).toEqual([]);
});

skipOnWindows('a recording refuses the ground a link target crosses on the way in', () => {
  // `home/rec -> <root>/shared/relay/sub`, with `shared` at 0777 and not sticky and `shared/relay` a link
  // into a directory of mine. Every directory at the destination looks private; only walking the target
  // component by component shows that getting there crossed `shared`, where any other local user can swap
  // `relay` for one of their own.
  const directory = root();
  const shared = sharedDirectory(path.join(directory, 'shared'), 0o777);
  const relayTarget = path.join(directory, 'chosen');
  fs.mkdirSync(relayTarget);
  fs.chmodSync(relayTarget, 0o700);
  fs.symlinkSync(relayTarget, path.join(shared, 'relay'));
  const sub = path.join(relayTarget, 'sub');
  fs.mkdirSync(sub);
  const home = path.join(directory, 'home');
  fs.mkdirSync(home);
  fs.chmodSync(home, 0o700);
  fs.symlinkSync(path.join(shared, 'relay', 'sub'), path.join(home, 'rec'));
  const destination = path.join(home, 'rec', 'journey.ad');

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
    ancestor: shared,
  });
  expect(fs.readdirSync(relayTarget)).toEqual(['sub']);
});

skipOnWindows('a recording refuses a link another local user owns on the way in', () => {
  // `~/rec -> <root>/tmp/relay -> ~/chosen`, with `relay` another user's file in a sticky shared
  // directory: they can unlink it and leave one of their own, and the second hop is theirs to choose.
  const directory = root();
  const home = path.join(directory, 'home');
  fs.mkdirSync(home);
  const chosen = path.join(directory, 'chosen');
  fs.mkdirSync(chosen);
  const relay = path.join(directory, 'relay');
  fs.symlinkSync(chosen, relay);
  const tmp = path.join(directory, 'tmp');
  fs.mkdirSync(tmp);
  fs.chmodSync(tmp, 0o1777);
  fs.renameSync(relay, path.join(tmp, 'relay'));
  fs.symlinkSync(path.join(tmp, 'relay'), path.join(home, 'rec'));
  const destination = path.join(home, 'rec', 'journey.ad');
  serveHostOwnership({ [path.join(tmp, 'relay')]: FOREIGN_UID });

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({ reason: 'script_ancestor_untrusted', exposure: 'planted_link' });
  expect(fs.readdirSync(chosen)).toEqual([]);
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
