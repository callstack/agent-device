import { test, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { makeAndroidSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeTestScreenRecordingResource } from '../../../__tests__/test-utils/screen-recording-live-handle.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../interaction.ts';
import { contextFromFlags } from './interaction-touch-fixtures.ts';

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: mockDispatch };
});

vi.mock('../../../platforms/android/snapshot.ts', () => ({ snapshotAndroid: vi.fn() }));

vi.mock('../../../platforms/android/app-lifecycle.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/android/app-lifecycle.ts')>();
  return {
    ...actual,
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogFocus: vi.fn(async () => null),
  };
});

import { snapshotAndroid } from '../../../platforms/android/snapshot.ts';

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({ warning: 'The type response already carried a warning.' });
  vi.mocked(snapshotAndroid).mockReset();
  vi.mocked(snapshotAndroid).mockRejectedValue(
    new AppError(
      'COMMAND_FAILED',
      'Android snapshot helper is unavailable: helper artifact is missing',
      { hint: 'Run `pnpm build:android` to build the Android snapshot helper.' },
    ),
  );
});

test('type continues and composes the recording readiness warning', async () => {
  const sessionName = 'type-inspection-warning';
  const session = makeAndroidSession(sessionName);
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'adb screenrecord',
    outPath: '/tmp/type-inspection-warning.mp4',
    startedAt: 0,
  });
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'type',
      positionals: ['hello'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'android' }),
    'type',
    ['hello'],
    undefined,
    expect.anything(),
  );
  if (response?.ok) {
    expect(response.data?.warning).toMatch(
      /Android blocking-dialog readiness could not be inspected.*command continued/i,
    );
    expect(response.data?.warning).toContain('pnpm build:android');
    expect(response.data?.warning).toContain('The type response already carried a warning.');
  }
});
