import { expect, test } from 'vitest';
import fs from 'node:fs';
// oxlint-disable-next-line no-restricted-imports -- the private-group fixture is named after os.userInfo()'s user, not a scratch path
import os from 'node:os';
import path from 'node:path';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { SessionScriptWriter } from '../session-script-writer.ts';
import { makeAuthoringSession } from '../../__tests__/support/session-factories.ts';

const hostCwd = createLiveTestHostEnvironment().cwd;
const skipOnWindows = process.platform === 'win32' ? test.skip : test;

/** The private-group exception is decided by this host's group database. */
function groupDatabaseMatchesHost(gid: number): boolean {
  try {
    const name = os.userInfo().username;
    const groups = fs.readFileSync('/etc/group', 'utf8').split('\n');
    const passwd = fs.readFileSync('/etc/passwd', 'utf8').split('\n');
    const line = groups.find((entry) => entry.split(':')[0] === name);
    if (!line || Number(line.split(':')[2]) !== gid) return false;
    const extra = (line.split(':')[3] ?? '').split(',').filter(Boolean);
    return (
      extra.every((member) => member === name || member === 'root') &&
      passwd.every((entry) => {
        const [user, , , primary] = entry.split(':');
        return Number(primary) !== gid || user === name || user === 'root';
      })
    );
  } catch {
    return false;
  }
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

function refusal(result: ReturnType<SessionScriptWriter['write']>): Record<string, unknown> {
  expect(result.written).toBe(false);
  if (result.written || !result.error) throw new Error('expected a refused write');
  return result.error.details as Record<string, unknown>;
}

skipOnWindows('an ordinary recording saves under a chain only this user can write', () => {
  const destination = path.join(root(), 'workflows', 'journey.ad');
  const writer = new SessionScriptWriter(path.join(root(), 'sessions'), hostCwd);

  const result = writer.write(recordingTo(destination));

  expect(result.written).toBe(true);
  expect(fs.readFileSync(destination, 'utf8')).toContain('open');
});

skipOnWindows('a recording refuses a destination under a world-writable directory', () => {
  const shared = sharedDirectory(path.join(root(), 'shared'), 0o777);
  const destination = path.join(shared, 'journey.ad');
  const writer = new SessionScriptWriter(path.join(root(), 'sessions'), hostCwd);

  const details = refusal(writer.write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
  });
  expect(fs.existsSync(destination)).toBe(false);
});

skipOnWindows('a recording refuses an ancestor swapped out for a symbolic link', () => {
  const directory = root();
  const shared = sharedDirectory(path.join(directory, 'shared'), 0o1777);
  const attacker = path.join(directory, 'attacker');
  fs.mkdirSync(attacker);
  fs.symlinkSync(attacker, path.join(shared, 'work'));
  const destination = path.join(shared, 'work', 'journey.ad');
  const writer = new SessionScriptWriter(path.join(directory, 'sessions'), hostCwd);

  const details = refusal(writer.write(recordingTo(destination)));

  expect(details).toMatchObject({ reason: 'script_ancestor_untrusted', exposure: 'planted_link' });
  expect(fs.readdirSync(attacker)).toEqual([]);
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
  const writer = new SessionScriptWriter(path.join(directory, 'sessions'), hostCwd);

  const details = refusal(writer.write(recordingTo(destination)));

  expect(details).toMatchObject({
    reason: 'script_ancestor_untrusted',
    exposure: 'world_writable',
  });
  expect(fs.readdirSync(work)).toEqual([]);
});

skipOnWindows('a recording still saves to a group-writable private-group home', () => {
  const gid = process.getgid?.();
  if (gid === undefined || !groupDatabaseMatchesHost(gid)) return;
  const home = path.join(root(), 'home');
  fs.mkdirSync(home);
  fs.chmodSync(home, 0o775);
  const writer = new SessionScriptWriter(path.join(root(), 'sessions'), hostCwd);

  const result = writer.write(recordingTo(path.join(home, 'journey.ad')));

  expect(result.written).toBe(true);
});
