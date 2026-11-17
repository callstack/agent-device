import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FOREIGN_UID,
  createLiveTestHostEnvironment,
  mkdtempForTestSync,
  serveHostOwnership,
} from '@agent-device/test-kit';
import { ensurePrivateDaemonStateDir } from '@agent-device/daemon-contracts/daemon-registration-owner';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { SessionStore } from '../session-store.ts';
import {
  authoringPublication,
  makeAuthoringSession,
} from '../../__tests__/support/session-factories.ts';

test('teardown of an armed ordinary recording whose script write fails still retires the session', () => {
  const root = mkdtempForTestSync('agent-device-teardown-script-failure-');
  const store = new SessionStore(path.join(root, 'sessions'), createLiveTestHostEnvironment());
  const targetPath = path.join(root, 'existing.ad');
  fs.writeFileSync(targetPath, 'context platform=ios device="x"\n');
  const ref = store.publish(
    'teardown-script',
    makeAuthoringSession('teardown-script', {
      scriptPublication: authoringPublication('armed', { path: targetPath }),
      actions: [{ ts: 1, command: 'click', positionals: ['id="save"'], flags: {} }],
    }),
  );

  // Idle-reap, shutdown and lease-end teardown have no caller to report to, so the failure stays
  // in the writer's diagnostic and the session must not be leaked.
  const write = vi.spyOn(store, 'writeSessionLog');
  expect(() => store.finalizeRepairTeardown(ref)).not.toThrow();
  expect(write.mock.results[0]?.value).toMatchObject({
    written: false,
    error: { details: { reason: 'script_target_exists', path: targetPath } },
  });
  expect(store.retire(ref)).toBe(true);
  expect(fs.readFileSync(targetPath, 'utf8')).toBe('context platform=ios device="x"\n');
});

test('teardown of a remote recording writes no daemon file', () => {
  const root = mkdtempForTestSync('agent-device-teardown-remote-script-');
  const store = new SessionStore(path.join(root, 'sessions'), createLiveTestHostEnvironment());
  const targetPath = path.join(root, 'daemon.ad');
  const ref = store.publish(
    'teardown-remote',
    makeAuthoringSession('teardown-remote', {
      scriptPublication: authoringPublication('armed', {
        path: targetPath,
        remote: true,
      }),
      actions: [{ ts: 1, command: 'open', positionals: ['Demo'], flags: {} }],
    }),
  );

  store.finalizeRepairTeardown(ref);
  expect(fs.existsSync(targetPath)).toBe(false);
  expect(store.retire(ref)).toBe(true);
});

test.skipIf(process.platform === 'win32')(
  'a remote recording writes each version and its close-time script privately',
  () => {
    const root = mkdtempForTestSync('agent-device-remote-script-mode-');
    const store = new SessionStore(path.join(root, 'sessions'), createLiveTestHostEnvironment());
    const local = path.join(root, 'local.ad');
    const session = (name: string, remote: boolean) =>
      store.publish(
        name,
        makeAuthoringSession(name, {
          scriptPublication: authoringPublication('armed', { path: local, remote }),
          actions: [{ ts: 1, command: 'open', positionals: ['Demo'], flags: {} }],
        }),
      );
    const remote = session('remote', true);

    const version = store.writeRemoteScriptVersion(remote);
    const closed = store.writeSessionLog(remote);
    const localWrite = store.writeSessionLog(session('local', false));

    const directory = path.join(root, 'sessions', 'remote-scripts');
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    for (const result of [version, closed]) {
      if (!result.written) throw new Error('remote script not written');
      expect(path.dirname(result.path)).toBe(directory);
      expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
    }
    expect(localWrite).toMatchObject({ written: true, path: local });
    // A recording is a transcript of what someone did on this machine, so the caller's own file is
    // private too, whatever the umask would have allowed (#4565).
    expect(fs.statSync(local).mode & 0o777).toBe(0o600);
  },
);

test.skipIf(process.platform === 'win32')(
  'on a umask-002 host the daemon creates and repairs its own state directories at 0700',
  () => {
    // A stock Ubuntu login runs umask 002, and the daemon creates `sessions/` itself: a mode-less `mkdir`
    // there is 0775. Every script path the daemon picks for itself is walked through that directory, and a
    // group-writable directory on the way is refused, so the daemon would refuse its own default recordings
    // and every remote-delivered version. `ensureSessionDir` runs on `open`, so this is the first thing a
    // session does. (ADR 0016)
    const root = mkdtempForTestSync('agent-device-shared-umask-');
    // What the daemon's own state dir is forced to on startup, whatever created it.
    fs.chmodSync(root, 0o700);
    const store = new SessionStore(path.join(root, 'sessions'), createLiveTestHostEnvironment());
    const session = (name: string, remote: boolean) =>
      store.publish(
        name,
        makeAuthoringSession(name, {
          scriptPublication: authoringPublication('armed', { remote }),
          actions: [{ ts: 1, command: 'open', positionals: ['Demo'], flags: {} }],
        }),
      );
    const previous = process.umask(0o002);
    let defaultPath: ReturnType<SessionStore['writeSessionLog']>;
    let version: ReturnType<SessionStore['writeRemoteScriptVersion']>;
    try {
      store.ensureSessionDir('journey');
      defaultPath = store.writeSessionLog(session('journey', false));
      version = store.writeRemoteScriptVersion(session('download', true));
    } finally {
      process.umask(previous);
    }

    if (!defaultPath.written) throw new Error(`default recording refused: ${refusal(defaultPath)}`);
    if (!version.written) throw new Error(`remote version refused: ${refusal(version)}`);
    expect(path.dirname(defaultPath.path)).toBe(path.join(root, 'sessions'));
    expect(path.dirname(version.path)).toBe(path.join(root, 'sessions', 'remote-scripts'));
    for (const directory of [
      path.join(root, 'sessions'),
      path.join(root, 'sessions', 'journey'),
      path.join(root, 'sessions', 'remote-scripts'),
    ]) {
      expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700);
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'repairs state directories a legacy version or a shared checkout created at 0775',
  () => {
    // The test above starts from fresh 0700 directories, so it would pass even with the repair disabled:
    // only the creation carries the mode. What a host already has is the other half — an older release, or
    // a checkout shared under umask 002, leaves `sessions/` and `remote-scripts/` at 0775, and the rule
    // refuses a recording walked through one. (ADR 0016)
    const root = mkdtempForTestSync('agent-device-legacy-state-');
    fs.chmodSync(root, 0o755);
    const sessions = path.join(root, 'sessions');
    const remote = path.join(sessions, 'remote-scripts');
    for (const directory of [sessions, remote]) {
      fs.mkdirSync(directory);
      fs.chmodSync(directory, 0o775);
    }
    const store = new SessionStore(sessions, createLiveTestHostEnvironment());
    const session = (name: string, remoteDelivery: boolean) =>
      store.publish(
        name,
        makeAuthoringSession(name, {
          scriptPublication: authoringPublication('armed', { remote: remoteDelivery }),
          actions: [{ ts: 1, command: 'open', positionals: ['Demo'], flags: {} }],
        }),
      );

    // How the daemon reaches this state: startup forces `sessions/` private, an `open` then ensures its own
    // session directory, and the remote route is the one that puts `remote-scripts/` in place.
    ensurePrivateDaemonStateDir(sessions, root);
    store.ensureSessionDir('journey');
    expect(fs.lstatSync(sessions).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(path.join(sessions, 'journey')).mode & 0o777).toBe(0o700);

    const defaultPath = store.writeSessionLog(session('journey', false));
    const version = store.writeRemoteScriptVersion(session('download', true));
    if (!defaultPath.written) throw new Error(`default recording refused: ${refusal(defaultPath)}`);
    if (!version.written) throw new Error(`remote version refused: ${refusal(version)}`);
    expect(fs.lstatSync(remote).mode & 0o777).toBe(0o700);
  },
);

test.skipIf(process.platform === 'win32')(
  'skips a `sessions` directory another user owns, and changes nothing there',
  async () => {
    // Repair is what fixes a host the daemon did not create, so the repair is itself the dangerous step: a
    // `chmod` given the NAME acts on whatever that name answers. Simulated root ownership (state an older
    // release left owned by another uid) makes this process foreign to `sessions/`, as it is on that host.
    // The mode is therefore applied through an `O_NOFOLLOW` descriptor whose `fstat` says whose entry it is,
    // and a foreign one is left as its owner set it — the daemon still starts, and the destination walk is
    // what refuses a recording under that tree.
    const root = mkdtempForTestSync('agent-device-foreign-state-');
    fs.chmodSync(root, 0o755);
    const sessions = path.join(root, 'sessions');
    fs.mkdirSync(sessions);
    fs.chmodSync(sessions, 0o775);
    serveHostOwnership({ [sessions]: FOREIGN_UID });

    expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions, root))).toBe(1);

    // Nothing was touched: the owner's directory keeps the mode they set for it.
    expect(fs.lstatSync(sessions).mode & 0o777).toBe(0o775);
  },
);

test.skipIf(process.platform === 'win32')(
  'skips a planted `sessions` link under state another user can write, and leaves where it leads alone',
  async () => {
    // The shape of the blocker: `sessions` is writable by another local user, they leave a link at that
    // name, and a root daemon forcing its own state private is handed the name. Repairing it by pathname
    // travels through the link and changes the mode of the attacker's directory — as root, with privileges.
    // The mode comes from a descriptor that cannot follow a link, so this call reports the level and starts.
    const root = mkdtempForTestSync('agent-device-planted-state-');
    fs.chmodSync(root, 0o777);
    const planted = path.join(root, 'attacker');
    fs.mkdirSync(planted);
    fs.chmodSync(planted, 0o777);
    const sessions = path.join(root, 'sessions');
    fs.symlinkSync(planted, sessions);

    expect(await skipCountFor(() => ensurePrivateDaemonStateDir(sessions, root))).toBe(1);

    expect(fs.lstatSync(planted).mode & 0o777).toBe(0o777);
    expect(fs.readdirSync(planted)).toEqual([]);
    expect(fs.lstatSync(sessions).isSymbolicLink()).toBe(true);
  },
);

/** Why a write that had to succeed did not, from the typed reason the writer returned. */
function refusal(result: object): string {
  return JSON.stringify(result);
}

/**
 * Runs one state repair inside its own diagnostics scope and reports how often it said it skipped a level.
 * No `logPath`, so the events are tallied and written nowhere.
 */
async function skipCountFor(repair: () => unknown): Promise<number> {
  return await withDiagnosticsScope({ session: 'daemon' }, () => {
    expect(repair()).toBeDefined();
    return countDiagnosticEventsByPhase(['daemon_state_mode_repair_skipped']);
  });
}
