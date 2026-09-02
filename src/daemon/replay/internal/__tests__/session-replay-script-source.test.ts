/**
 * #1802: `replay <path>` used to resolve the caller's path on the DAEMON and open it there. A
 * remote daemon shares no filesystem with the caller, so the command failed with `ENOENT` on a
 * path the caller could read. These pin the repair at the daemon's own boundary: the run reads
 * only the replay script source bundle the request carried, and a request that carries just a
 * path is refused with a message that says so.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../../../core/dispatch-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../core/dispatch-resolve.ts')>();
  return { ...actual, resolveTargetDevice: vi.fn() };
});
vi.mock('../../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

import fs from 'node:fs';
import path from 'node:path';
import { runReplayForTest } from '../../__tests__/replay-command-fixture.ts';
import { SessionStore } from '../../../session-store.ts';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import {
  maestroScriptSourceBundleFor,
  replayScriptSourceBundleFor,
} from '../../../../__tests__/test-utils/replay-script-source.ts';
import { REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE } from '../../../replay-script-source.ts';
import {
  captureSnapshotThroughLegacyDispatchFixture,
  legacyDispatchCapture,
} from '../../../__tests__/legacy-snapshot-capture-fixture.ts';
import { captureSnapshotWithInteractor } from '../../../snapshot-interactor-capture.ts';

const mockCaptureSnapshotWithInteractor = vi.mocked(captureSnapshotWithInteractor);

beforeEach(() => {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  mockCaptureSnapshotWithInteractor.mockReset();
  mockCaptureSnapshotWithInteractor.mockImplementation(captureSnapshotThroughLegacyDispatchFixture);
});

test('a bundled replay runs after the script file is gone from the daemon host', async () => {
  const root = mkdtempForTestSync('agent-device-replay-source-bundle-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set('default', makeIosSession('default'));
  const scriptPath = path.join(root, 'flow.ad');
  fs.writeFileSync(scriptPath, 'open "Demo"\nclick "Save"\n');
  const bundle = replayScriptSourceBundleFor(scriptPath);
  // Stand in for the remote daemon: nothing at the caller's path exists on this host.
  fs.rmSync(scriptPath);

  const response = await runReplayForTest({
    req: {
      token: 'token',
      session: 'default',
      command: 'replay',
      positionals: [scriptPath],
      flags: { replayScriptSource: bundle },
      meta: { cwd: '/a/directory/that/does/not/exist' },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.data).toMatchObject({ replayed: 2 });
});

test('a bundled Maestro replay resolves runFlow includes from the bundle, not the daemon disk', async () => {
  const root = mkdtempForTestSync('agent-device-replay-maestro-bundle-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set('default', makeIosSession('default'));
  const flowPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(flowPath, 'appId: com.example.app\n---\n- runFlow: included.yaml\n');
  fs.writeFileSync(path.join(root, 'included.yaml'), '---\n- back\n');
  const bundle = await maestroScriptSourceBundleFor(flowPath);
  fs.rmSync(root, { recursive: true, force: true });
  const invoked: string[] = [];

  const response = await runReplayForTest({
    req: {
      token: 'token',
      session: 'default',
      command: 'replay',
      positionals: [flowPath],
      flags: { replayBackend: 'maestro', platform: 'ios', replayScriptSource: bundle },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req.command);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(invoked).toContain('back');
});

test('a Maestro include missing from the bundle fails naming the include path', async () => {
  const root = mkdtempForTestSync('agent-device-replay-maestro-missing-include-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set('default', makeIosSession('default'));
  const flowPath = path.join(root, 'flow.yaml');
  const flow = 'appId: com.example.app\n---\n- runFlow: absent.yaml\n';
  fs.writeFileSync(flowPath, flow);

  const response = await runReplayForTest({
    req: {
      token: 'token',
      session: 'default',
      command: 'replay',
      positionals: [flowPath],
      flags: {
        replayBackend: 'maestro',
        platform: 'ios',
        replayScriptSource: { entry: flowPath, files: { [flowPath]: flow } },
      },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toContain(path.join(root, 'absent.yaml'));
});

// No path fallback: an older client that sends only a path is told what is missing instead of
// being served an ENOENT for a file that exists on the machine it ran on.
test('a request carrying only a path is refused with the client-must-send-sources message', async () => {
  const root = mkdtempForTestSync('agent-device-replay-path-only-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set('default', makeIosSession('default'));
  const scriptPath = path.join(root, 'flow.ad');
  fs.writeFileSync(scriptPath, 'open "Demo"\n');

  const response = await runReplayForTest({
    req: {
      token: 'token',
      session: 'default',
      command: 'replay',
      positionals: [scriptPath],
      flags: {},
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toBe(REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE);
});

// The bundle's entry is the path the caller resolved, so the divergence report a failing step
// produces still points at the script the operator ran — path and line alike.
test('a failing step reports the caller-resolved script path and line', async () => {
  const root = mkdtempForTestSync('agent-device-replay-source-display-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set('default', makeIosSession('default'));
  const scriptPath = path.join(root, 'flow.ad');
  fs.writeFileSync(scriptPath, 'open "Demo"\nclick "Nope"\n');

  const response = await runReplayForTest({
    req: {
      token: 'token',
      session: 'default',
      command: 'replay',
      positionals: [scriptPath],
      flags: { replayScriptSource: replayScriptSourceBundleFor(scriptPath) },
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) =>
      req.command === 'click'
        ? { ok: false, error: { code: 'NOT_FOUND', message: 'no match' } }
        : { ok: true, data: {} },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.details).toMatchObject({
    divergence: { step: { source: { path: scriptPath, line: 2 } } },
  });
});
