import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';

import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { SessionStore } from '../../../session-store.ts';
import { runReplayForTest } from '../../__tests__/replay-command-fixture.ts';
import {
  captureSnapshotThroughLegacyDispatchFixture,
  legacyDispatchCapture,
} from '../../../__tests__/legacy-snapshot-capture-fixture.ts';
import { captureSnapshotWithInteractor } from '../../../handlers/snapshot-interactor-capture.ts';
import {
  baseReplayRequest,
  writeReplayFile,
} from '../../__tests__/session-replay-runtime.fixtures.ts';

vi.mock('../../../../core/dispatch-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../core/dispatch-resolve.ts')>();
  return { ...actual, resolveTargetDevice: vi.fn() };
});

vi.mock('../../../handlers/snapshot-interactor-capture.ts', () => ({
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
    String.raw`get text "id=\"field-name\""`,
    String.raw`get attrs "id=\"field-name\""`,
    String.raw`is visible "id=\"field-name\""`,
    'find id "field-name" get attrs',
    String.raw`click "id=\"field-name\""`,
  ]);
  const invoked: string[] = [];

  const response = await runReplayForTest({
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
