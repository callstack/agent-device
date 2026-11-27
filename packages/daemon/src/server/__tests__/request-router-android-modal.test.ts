import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { afterEach, beforeEach, test, expect, vi } from 'vitest';

import path from 'node:path';
import { createTouchCommandSurface } from '../../__tests__/support/touch-command-surface-fake.ts';
import {
  createRequestHandler,
  gestureDeviceRuntimeGateway,
  gestureRuntimeSpies,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import type { SessionState } from '../../core/session-state.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { providerDeviceAdmissionFixture } from '../../__tests__/support/provider-device-admission-fixture.ts';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import { makeTestScreenRecordingResource } from '../../__tests__/support/screen-recording-live-handle.ts';
import {
  ANR_CLOSE_APP_TAP,
  makeAnrDialogObservation,
} from '../../__tests__/support/android-anr-observation.ts';
import type { SessionStore } from '../../core/session-store.ts';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';

// A screen recording does not change how the generic route treats an Android "isn't responding"
// dialog: the session app's own ANR is recovered, and another app's ANR is refused untouched.

const APP = 'com.android.settings';
const providerAdmission = providerDeviceAdmissionFixture();

beforeEach(() => gestureRuntimeSpies.scrollDirection.mockClear());
afterEach(() => providerAdmission.setActive([]));

function makeRecordingAndroidSession(name: string): SessionState {
  const session: SessionState = {
    name,
    createdAt: Date.now(),
    appBundleId: APP,
    actions: [],
    device: {
      platform: 'android',
      target: 'mobile',
      id: 'emulator-5554',
      name: 'Pixel 9 Pro XL',
      kind: 'emulator',
      booted: true,
    },
  };
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'adb screenrecord',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    showTouches: true,
  });
  return session;
}

async function scrollWhileRecording(params: {
  sessionStore: SessionStore;
  observation: AndroidObservationAdapter;
  requestId: string;
}) {
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: createTouchCommandSurface(),
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore: params.sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
    deviceRuntimeGateway: gestureDeviceRuntimeGateway,
    androidObservation: params.observation,
  });
  return await handler({
    token: 'test-token',
    session: 'default',
    command: 'scroll',
    positionals: ['down', '0.55'],
    meta: { requestId: params.requestId },
  });
}

test('another app ANR during recording refuses scroll and closes nothing', async () => {
  const sessionStore = makeSessionStore('agent-device-router-android-modal-');
  sessionStore.publish('default', makeRecordingAndroidSession('default'));
  const { observation, taps, openedApps } = makeAnrDialogObservation('com.example.other');

  const response = await scrollWhileRecording({
    sessionStore,
    observation,
    requestId: 'req-android-modal-foreign',
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: expect.stringContaining('Android system dialog is blocking scroll'),
      hint: expect.stringContaining('Run alert dismiss'),
    },
  });
  expect(taps).toEqual([]);
  expect(openedApps).toEqual([]);
  expect(gestureRuntimeSpies.scrollDirection).not.toHaveBeenCalled();
});

test('the session app ANR during recording is recovered before scroll', async () => {
  const sessionStore = makeSessionStore('agent-device-router-android-modal-');
  sessionStore.publish('default', makeRecordingAndroidSession('default'));
  const { observation, taps, openedApps } = makeAnrDialogObservation(APP);

  const response = await scrollWhileRecording({
    sessionStore,
    observation,
    requestId: 'req-android-modal-app',
  });

  expect(response).toMatchObject({
    ok: true,
    data: { warning: `Recovered Android app ANR before scroll: closed and relaunched ${APP}.` },
  });
  expect(taps).toEqual([ANR_CLOSE_APP_TAP]);
  expect(openedApps).toEqual([APP]);
  expect(gestureRuntimeSpies.scrollDirection).toHaveBeenCalledTimes(1);
});

test('generic Android commands skip local dialog recovery for provider devices', async () => {
  const sessionStore = makeSessionStore('agent-device-router-android-modal-provider-');
  const session = makeRecordingAndroidSession('default');
  sessionStore.publish('default', session);
  const runtime: ProviderDeviceRuntime = {
    provider: 'webdriver-fake',
    leaseLifecycle: {},
    deviceInventoryProvider: async () => [session.device],
    ownsDevice: (device) => device.id === session.device.id,
    getInteractor: () => undefined,
    shutdown: async () => {},
  };
  providerAdmission.setActive([runtime]);
  const { observation, taps } = makeAnrDialogObservation('com.example.other');
  const readBlockingDialog = vi.spyOn(observation, 'readBlockingDialog');

  const response = await scrollWhileRecording({
    sessionStore,
    observation,
    requestId: 'req-android-modal-provider',
  });

  expect(response.ok).toBe(true);
  expect(gestureRuntimeSpies.scrollDirection).toHaveBeenCalledTimes(1);
  expect(readBlockingDialog).not.toHaveBeenCalled();
  expect(taps).toEqual([]);
});
