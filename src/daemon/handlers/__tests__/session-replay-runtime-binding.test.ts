import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { resolveTargetDevice } from '../../../core/dispatch.ts';
import { captureSnapshotThroughLegacyDispatchFixture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { SessionStore } from '../../session-store.ts';
import { runReplayScriptSource } from '../session-replay-runtime.ts';
import { captureSnapshotWithInteractor } from '../snapshot-interactor-capture.ts';
import { baseReplayRequest as baseReq } from './session-replay-runtime.fixtures.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, resolveTargetDevice: vi.fn() };
});

vi.mock('../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const mockCaptureSnapshotWithInteractor = vi.mocked(captureSnapshotWithInteractor);

beforeEach(() => {
  mockResolveTargetDevice.mockReset();
  mockResolveTargetDevice.mockResolvedValue(makeIosSession('resolved').device);
  mockCaptureSnapshotWithInteractor.mockReset();
  mockCaptureSnapshotWithInteractor.mockImplementation(captureSnapshotThroughLegacyDispatchFixture);
});

test('typed Maestro does not resolve a device before an explicit-platform flow needs one', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-explicit-platform-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const flowPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(flowPath, 'appId: com.example.app\n---\n- launchApp\n');
  const invoked: string[] = [];

  const response = await runReplayScriptSource({
    req: baseReq({
      positionals: [flowPath],
      flags: { replayBackend: 'maestro', platform: 'android' },
    }),
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (request) => {
      invoked.push(request.command);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
  expect(invoked).toEqual(['open']);
});

test('typed Maestro keeps a port-only runtime digest stable after launch binds the device', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-runtime-device-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const flowPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(flowPath, 'appId: com.example.app\n---\n- launchApp\n- back\n');
  const runtime = { metroPort: 8083 };

  const firstAttempt = await runReplayScriptSource({
    req: baseReq({
      positionals: [flowPath],
      flags: { replayBackend: 'maestro', platform: 'ios' },
      runtime,
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (request) => {
      if (request.command === 'open') {
        expect(request.runtime).toEqual({
          platform: 'ios',
          metroHost: '127.0.0.1',
          metroPort: 8083,
        });
        if (!request.runtime) throw new Error('open must carry effective runtime hints');
        sessionStore.set(sessionName, makeIosSession(sessionName));
        sessionStore.setRuntimeHints(sessionName, request.runtime);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'back failed' } };
    },
  });
  expect(firstAttempt.ok).toBe(false);
  if (firstAttempt.ok) return;
  const divergence = firstAttempt.error.details?.divergence as {
    resume: { from: number; planDigest: string };
  };
  expect(divergence.resume.from).toBe(2);

  const invoked: string[] = [];
  const resumedAttempt = await runReplayScriptSource({
    req: baseReq({
      positionals: [flowPath],
      flags: {
        replayBackend: 'maestro',
        platform: 'ios',
        replayFrom: divergence.resume.from,
        replayPlanDigest: divergence.resume.planDigest,
      },
      runtime,
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (request) => {
      invoked.push(request.command);
      return { ok: true, data: {} };
    },
  });

  expect(resumedAttempt.ok).toBe(true);
  expect(invoked).toEqual(['back']);
});
