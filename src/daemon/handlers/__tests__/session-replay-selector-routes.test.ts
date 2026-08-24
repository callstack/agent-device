import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { SessionStore } from '../../session-store.ts';
import { runReplayScriptSource } from '../session-replay-runtime.ts';
import {
  captureSnapshotThroughLegacyDispatchFixture,
  legacyDispatchCapture,
} from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { captureSnapshotWithInteractor } from '../snapshot-interactor-capture.ts';
import { baseReplayRequest, writeReplayFile } from './session-replay-runtime.fixtures.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, resolveTargetDevice: vi.fn() };
});

vi.mock('../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));

const mockDispatchCommand = legacyDispatchCapture;
const mockCaptureSnapshotWithInteractor = vi.mocked(captureSnapshotWithInteractor);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));
  mockCaptureSnapshotWithInteractor.mockReset();
  mockCaptureSnapshotWithInteractor.mockImplementation(captureSnapshotThroughLegacyDispatchFixture);
});

test('replay executes selector reads before reporting a covered-target divergence', async () => {
  const root = mkdtempForTestSync('agent-device-replay-selector-routes-');
  const sessionName = 'default';
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, [
    'open "Demo"',
    'get text "id=\\"field-name\\""',
    'get attrs "id=\\"field-name\\""',
    'is visible "id=\\"field-name\\""',
    'find id "field-name" get attrs',
    'click "id=\\"field-name\\""',
  ]);
  const invoked: string[] = [];

  const response = await runReplayScriptSource({
    req: baseReplayRequest({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (request) => {
      invoked.push(request.command);
      if (request.command !== 'click') return { ok: true, data: {} };
      return {
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message: 'Target is covered by another visible element',
        },
      };
    },
  });

  expect(invoked).toEqual(['open', 'get', 'get', 'is', 'find', 'click']);
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  expect(response.error.details?.divergence).toMatchObject({
    kind: 'action-failure',
    step: { index: 6 },
    cause: {
      code: 'COMMAND_FAILED',
      message: 'Target is covered by another visible element',
    },
  });
});
