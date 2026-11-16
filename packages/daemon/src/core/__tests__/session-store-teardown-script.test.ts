import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
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

/** Why a write that had to succeed did not, from the typed reason the writer returned. */
function refusal(result: object): string {
  return JSON.stringify(result);
}
