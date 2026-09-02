import { test, expect, vi, beforeEach } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { makeAndroidSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { makeTestScreenRecordingResource } from '../../../../__tests__/test-utils/screen-recording-live-handle.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../../index.ts';
import { contextFromFlags } from './interaction-touch-fixtures.ts';
import {
  getRuntimeBindings,
  mockTypeText,
  resetGetRuntimeFixture,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    snapshotAndroid: vi.fn(),
    getAndroidAppState: vi.fn(async () => ({})),
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

import { snapshotAndroid } from '@agent-device/platform-android/mechanics';

beforeEach(() => {
  resetGetRuntimeFixture();
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
    ...getRuntimeBindings(),
  });

  expect(response?.ok).toBe(true);
  // R41: the text reaches the device through the bound operation. That it reaches no other path
  // is R58's claim now — there is no dispatcher left for this suite to watch.
  expect(mockTypeText).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }));
  if (response?.ok) {
    expect(response.data?.warning).toMatch(
      /Android blocking-dialog readiness could not be inspected.*command continued/i,
    );
    expect(response.data?.warning).toContain('pnpm build:android');
  }
});
