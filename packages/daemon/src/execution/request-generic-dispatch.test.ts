import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./android-system-dialog.ts', () => ({
  ensureAndroidBlockingSystemDialogReady: vi.fn(async () => ({ status: 'clear' })),
  recoverAndroidBlockingSystemDialog: vi.fn(async () => ({ status: 'absent' })),
}));

import { daemonPlatformServicesFixture } from '../__tests__/support/platform-services-fixture.ts';
import { makeAndroidSession } from '../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../__tests__/support/store-factory.ts';
import { makeTestScreenRecordingResource } from '../__tests__/support/screen-recording-live-handle.ts';
import { fakeCreateCommandSurface } from '../__tests__/support/command-surface-fake.ts';
import { selectorCaptureFixture } from '../__tests__/support/selector-capture-fixture.ts';
import {
  ensureAndroidBlockingSystemDialogReady,
  recoverAndroidBlockingSystemDialog,
} from './android-system-dialog.ts';
import { dispatchGenericCommand } from './request-generic-dispatch.ts';

const guard = vi.mocked(ensureAndroidBlockingSystemDialogReady);
const recordingRecovery = vi.mocked(recoverAndroidBlockingSystemDialog);

beforeEach(() => {
  guard.mockClear();
  recordingRecovery.mockClear();
});

/** One `lock-screen` request on a local Android session with a screen recording running. */
async function dispatchLockScreen(action: string) {
  const sessionStore = makeSessionStore();
  const session = makeAndroidSession('lock-screen-dispatch');
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'adb screenrecord',
    outPath: '/tmp/lock-screen-dispatch.mp4',
    startedAt: 0,
  });
  const ref = sessionStore.publish(session.name, session);
  return await dispatchGenericCommand({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: { token: 't', session: session.name, command: 'lock-screen', positionals: [action] },
    ref,
    sessionName: session.name,
    logPath: '',
    sessionStore,
    contextFromFlags: () => ({}) as never,
    executePlatformCommand: async () => ({ action: 'lock-screen', state: 'unlocked' }),
    ...selectorCaptureFixture({
      capture: { available: false, reason: 'unsupported-platform-leaf' },
      withoutActiveApp: { available: false, reason: 'unsupported-platform-leaf' },
    }),
  });
}

// A status read must not change the device, so neither Android dialog recovery may tap Close app
// or relaunch the app first: not the per-command guard, and not the one a recording runs.
test('lock-screen status runs no Android dialog recovery, even while a recording runs', async () => {
  const response = await dispatchLockScreen('status');
  expect(response.ok).toBe(true);
  expect(guard).not.toHaveBeenCalled();
  expect(recordingRecovery).not.toHaveBeenCalled();
});

test('lock-screen lock keeps both Android dialog recoveries', async () => {
  const response = await dispatchLockScreen('lock');
  expect(response.ok).toBe(true);
  expect(guard).toHaveBeenCalledTimes(2);
  expect(recordingRecovery).toHaveBeenCalledTimes(1);
});
