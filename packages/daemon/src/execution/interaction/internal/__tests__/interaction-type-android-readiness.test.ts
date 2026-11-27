import { test, expect, beforeEach } from 'vitest';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { makeAndroidSession } from '../../../../__tests__/support/session-factories.ts';
import { makeTestScreenRecordingResource } from '../../../../__tests__/support/screen-recording-live-handle.ts';
import { makeSessionStore } from '../../../../__tests__/support/store-factory.ts';
import {
  ANR_CLOSE_APP_TAP_EVENT,
  ANR_DIALOG_CLEARED_EVENT,
  makeAnrDialogObservation,
} from '../../../../__tests__/support/android-anr-observation.ts';
import { handleInteractionCommands } from '../../index.ts';
import { contextFromFlags } from './interaction-touch-fixtures.ts';
import {
  getRuntimeBindings,
  mockTypeText,
  resetGetRuntimeFixture,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';

// A screen recording does not change how `type` treats an Android "isn't responding" dialog: the
// session app's own ANR is recovered, and another app's ANR is refused untouched.

const APP = 'com.example.demo';

beforeEach(() => resetGetRuntimeFixture());

async function typeWhileRecording(sessionName: string, observation: AndroidObservationAdapter) {
  const session = makeAndroidSession(sessionName, { appBundleId: APP });
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'adb screenrecord',
    outPath: `/tmp/${sessionName}.mp4`,
    startedAt: 0,
  });
  const sessionStore = makeSessionStore();
  sessionStore.publish(sessionName, session);
  return await handleInteractionCommands({
    createCommandSurface: fakeCreateCommandSurface,
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
    androidObservation: observation,
  });
}

test('another app ANR during recording refuses type and closes nothing', async () => {
  const { observation, events } = makeAnrDialogObservation('com.example.other');

  const response = await typeWhileRecording('type-foreign-anr', observation);

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: expect.stringContaining('Android system dialog is blocking type'),
      hint: expect.stringContaining('Run alert dismiss'),
    },
  });
  expect(events).toEqual([]);
  expect(mockTypeText).not.toHaveBeenCalled();
});

test('the session app ANR during recording is recovered before type', async () => {
  const { observation, events } = makeAnrDialogObservation(APP);

  const response = await typeWhileRecording('type-app-anr', observation);

  expect(response).toMatchObject({
    ok: true,
    data: { warning: `Recovered Android app ANR before type: closed and relaunched ${APP}.` },
  });
  // The relaunch waits until the dialog has left, after the process is gone.
  expect(events).toEqual([ANR_CLOSE_APP_TAP_EVENT, ANR_DIALOG_CLEARED_EVENT, `open ${APP}`]);
  expect(mockTypeText).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }));
});
