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
    const umask = process.umask();
    expect(fs.statSync(local).mode & 0o777).toBe(0o666 & ~umask);
  },
);
