import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  FOREIGN_UID,
  createLiveTestHostEnvironment,
  mkdtempForTestSync,
  seedPrivateGroupHost,
  seedUntrustedMembershipHost,
  serveHostOwnership,
} from '@agent-device/test-kit';
import { SessionScriptWriter } from '../session-script-writer.ts';
import { SessionStore } from '../session-store.ts';
import { remoteScriptVersionDelivery } from '../session-script-publication-capability.ts';
import {
  authoringPublication,
  makeAuthoringSession,
} from '../../__tests__/support/session-factories.ts';

const hostCwd = createLiveTestHostEnvironment().cwd;
const skipOnWindows = process.platform === 'win32' ? test.skip : test;

/** This process's ids. Windows has neither, and every test that uses them is skipped there. */
const currentUid = process.getuid?.() ?? -1;
const currentGid = process.getgid?.() ?? -1;

afterEach(() => {
  vi.restoreAllMocks();
});

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

skipOnWindows('a refused destination with a missing parent leaves no directories behind', () => {
  // `close --save-script /shared/recordings/journey.ad` where `recordings` is absent. Creating the missing
  // parent is what the caller asked for, so it cannot be judged only once it exists: a `mkdir -p` that runs
  // first leaves `recordings` standing in the open directory after the publish refuses, which is a
  // directory this user made in ground another local user owns the naming of. The chain that exists is
  // therefore asked about BEFORE anything is created, and again afterwards.
  const directory = root();
  const shared = sharedDirectory(path.join(directory, 'shared'), 0o777);
  const destination = path.join(shared, 'recordings', 'journey.ad');

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
    ancestor: shared,
  });
  expect(fs.readdirSync(shared)).toEqual([]);
});

skipOnWindows(
  'a recording that steps back out of a missing directory leaves no directories behind',
  () => {
    // `<private>/missing/../../shared/recordings/journey.ad`. The walk ends at `missing`, so `shared` is
    // never judged, and the `mkdir -p` this route runs resolves the two steps up as TEXT and builds
    // `<root>/shared/recordings` — the entry would be created in a world-writable directory the rule saw
    // nothing of. The kernel is no better here: it applies those steps only once `missing` exists, which
    // is a directory this call would have to create first. Refusing before the first `mkdir` is what keeps
    // the promise that a refused destination leaves no directories behind.
    const directory = root();
    const privateDir = path.join(directory, 'private');
    fs.mkdirSync(privateDir);
    fs.chmodSync(privateDir, 0o700);
    const shared = sharedDirectory(path.join(directory, 'shared'), 0o777);
    const destination = `${privateDir}/missing/../../shared/recordings/journey.ad`;

    const details = refusal(writerFor(directory).write(recordingTo(destination)));

    expect(details).toMatchObject({
      reason: 'script_ancestor_untrusted',
      exposure: 'unresolvable_parent',
    });
    expect(fs.readdirSync(privateDir)).toEqual([]);
    expect(fs.readdirSync(shared)).toEqual([]);
  },
);

skipOnWindows('a recording refuses a destination inside a directory another user owns', () => {
  // The fixture says WHOSE directory it is, so this is the real question — a second local user's
  // directory, mode 0755 and readable, judged by a rule that runs as THIS user. Moving the caller's uid
  // instead would make every directory in the scratch tree foreign and refuse for the wrong reason.
  const directory = root();
  const foreign = path.join(directory, 'foreign');
  fs.mkdirSync(foreign);
  fs.chmodSync(foreign, 0o755);
  const destination = path.join(foreign, 'journey.ad');
  serveHostOwnership({ [foreign]: FOREIGN_UID });

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'foreign_owned',
    ancestor: foreign,
  });
  expect(fs.existsSync(destination)).toBe(false);
});

skipOnWindows('a recording refuses a directory another user made sticky and owns', () => {
  // `chmod 1777` on a directory of THEIRS: the sticky bit keeps me from clearing their entries, and does
  // nothing to stop them renaming the component my path runs through.
  const directory = root();
  const team = path.join(directory, 'team');
  fs.mkdirSync(team);
  fs.chmodSync(team, 0o1777);
  const destination = path.join(team, 'journey.ad');
  serveHostOwnership({ [team]: FOREIGN_UID });

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'foreign_owned',
    ancestor: team,
  });
  expect(fs.readdirSync(team)).toEqual([]);
});

skipOnWindows('a recording refuses a shared directory another user claimed first', () => {
  // The `mkdir -p <shared>/recordings` shape in a sticky shared directory: whoever creates it owns it,
  // and the owner can swap it for one of their own whenever they like. Only `recordings` is theirs: the
  // sticky `tmp` above it is this user's, so the refusal has to name the claimed directory and not the
  // scratch root above it.
  const directory = root();
  const tmp = path.join(directory, 'tmp');
  fs.mkdirSync(tmp);
  fs.chmodSync(tmp, 0o1777);
  const recordings = path.join(tmp, 'recordings');
  fs.mkdirSync(recordings);
  fs.chmodSync(recordings, 0o755);
  const destination = path.join(recordings, 'journey.ad');
  serveHostOwnership({ [recordings]: FOREIGN_UID });

  const details = refusal(writerFor(directory).write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'foreign_owned',
    ancestor: recordings,
  });
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

skipOnWindows('a recording stages inside the directory the entry is created in', () => {
  // `home/work -> priv/x`, `priv/y` is private and `home/y` is open to others. The entry lands in
  // `priv/y`. `path.dirname` + `path.join` of the SAME spelling answers `home/y`, because `path.join`
  // folds `work/..` away, so a writer that stages beside the spelled parent puts a file it is about to
  // publish into ground no rule judged — where anyone who can list it can put their own bytes behind that
  // name before the rename. The staging directory has to be the directory the walk judged.
  const directory = root();
  const home = path.join(directory, 'home');
  fs.mkdirSync(home);
  fs.chmodSync(home, 0o700);
  const sharedY = path.join(home, 'y');
  fs.mkdirSync(sharedY);
  fs.chmodSync(sharedY, 0o777);
  const priv = path.join(directory, 'priv');
  const privX = path.join(priv, 'x');
  fs.mkdirSync(privX, { recursive: true });
  const privY = path.join(priv, 'y');
  fs.mkdirSync(privY);
  fs.chmodSync(privY, 0o700);
  fs.symlinkSync(privX, path.join(home, 'work'));
  const destination = `${home}/work/../y/journey.ad`;
  const staged: string[] = [];
  const realWriteFileSync = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
    if (typeof file === 'string' && file.endsWith('.tmp')) staged.push(path.dirname(file));
    return (realWriteFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.writeFileSync);

  expect(writerFor(directory).write(recordingTo(destination)).written).toBe(true);

  expect(staged).toEqual([privY]);
  expect(fs.readFileSync(path.join(privY, 'journey.ad'), 'utf8')).toContain('Demo');
  expect(fs.readdirSync(sharedY)).toEqual([]);
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

skipOnWindows('a recording saves to a group-writable home whose group is this user alone', () => {
  // The stock Ubuntu and Debian shape: the home directory is 0775, this user owns it, and its group is a
  // private group carrying that user alone. The exception reads that from the host's own account files, so
  // a plain Linux home directory is ground a recording may be saved to (#4565).
  seedPrivateGroupHost();
  const directory = root();
  const home = homeDirectory(path.join(directory, 'home'), 0o775);

  const result = writerFor(directory).write(recordingTo(path.join(home, 'journey.ad')));

  expect(result.written).toBe(true);
  expect(fs.readFileSync(path.join(home, 'journey.ad'), 'utf8')).toContain('open');
});

skipOnWindows('a recording refuses a group-writable home whose members cannot be proven', () => {
  // The same directory and mode, on a host whose name service answers membership from elsewhere: nothing
  // settles whether another user is in that group, so the mode alone refuses and the hint names the fix.
  seedUntrustedMembershipHost();
  const directory = root();
  const home = homeDirectory(path.join(directory, 'home'), 0o775);

  const details = refusal(writerFor(directory).write(recordingTo(path.join(home, 'journey.ad'))));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'shared_group_writable',
    ancestor: home,
  });
  expect(String(details.hint)).toContain(`chmod g-w ${home}`);
  expect(fs.readdirSync(home)).toEqual([]);
});

skipOnWindows('a recording creates a missing parent at 0700 on a shared umask', () => {
  // The umask of a shared checkout: a mode-less creation is 0775, which is the mode the check right after
  // it refuses, so the save both fails and leaves the directory it made standing in the project. host-kit
  // creates at 0700 and a recursive mkdir applies that to every level, so the new parent passes the check
  // it is judged by and the save goes through.
  const directory = root();
  const home = homeDirectory(path.join(directory, 'home'), 0o700);
  const destination = path.join(home, 'workflows', 'recordings', 'journey.ad');
  const previous = process.umask(0o002);
  let result: ReturnType<SessionScriptWriter['write']>;
  try {
    result = writerFor(directory).write(recordingTo(destination));
  } finally {
    process.umask(previous);
  }

  expect(result.written).toBe(true);
  expect(fs.readFileSync(destination, 'utf8')).toContain('open');
  expect(fs.lstatSync(path.join(home, 'workflows')).mode & 0o777).toBe(0o700);
  expect(fs.lstatSync(path.join(home, 'workflows', 'recordings')).mode & 0o777).toBe(0o700);
});

skipOnWindows(
  'a delivery failure the wire names no cause for is disclosed generically, not by its internal reason',
  () => {
    // #4584 review: the per-action route reads the write error's reason to say WHICH recovery a caller has
    // (`state_chain_untrusted` is not a full disk), but the wire contract names its causes (ADR 0016). An
    // error carrying a reason outside that set — here a `sessions` link reported by a filesystem error — is
    // disclosed as the generic delivery failure, and never leaks the daemon's own string.
    const stateDir = root();
    const outside = path.join(stateDir, 'outside');
    fs.mkdirSync(outside);
    const sessions = path.join(stateDir, 'sessions');
    fs.symlinkSync(outside, sessions);
    const store = new SessionStore(sessions, createLiveTestHostEnvironment());
    const ref = store.publish(
      'journey',
      makeAuthoringSession('journey', {
        scriptPublication: authoringPublication('armed', { remote: true }),
        actions: [action('open')],
      }),
    );
    const deliver = remoteScriptVersionDelivery(store, 'journey');
    ref.session.actions.push(action('click'));
    // The write answers with a reason the wire does not carry: an internal string with no client meaning.
    vi.spyOn(store, 'writeRemoteScriptVersion').mockReturnValue({
      written: false,
      error: new AppError('COMMAND_FAILED', 'permission denied', { reason: 'EACCES' }),
    });

    const response = deliver({ ok: true, data: {} });
    if (!response.ok) throw new Error('a failed version keeps the action successful');

    expect(response.data?.scriptDeliveryFailure).toMatchObject({
      reason: 'script_delivery_failed',
      cause: 'script_download_failed',
    });
    expect(JSON.stringify(response.data?.scriptDeliveryFailure)).not.toContain('EACCES');
  },
);
