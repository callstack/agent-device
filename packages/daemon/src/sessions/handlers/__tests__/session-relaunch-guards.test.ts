import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { test, expect, vi } from 'vitest';
import * as path from 'node:path';
import {
  mockResolveTargetDevice,
  mockEnsureDeviceReady,
  makeSessionStore,
  makeSession,
  noopInvoke,
  assertInvalidArgsMessage,
} from '../../../__tests__/support/handlers/session-test-harness.ts';
import { handleSessionCommands } from '../../../__tests__/support/handlers/session-command-harness.ts';
import { makeTestScreenRecordingResource } from '../../../__tests__/support/screen-recording-live-handle.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import type { DaemonPlatformServices } from '../../../core/platform-services.ts';

test('open --relaunch fails without app when no session exists', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/requires an app argument/i);
  }
});

test('open on in-use device returns DEVICE_IN_USE before readiness checks', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.publish(
    'busy-session',
    makeSession('busy-session', {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
  );

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    appleOs: 'ios',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  });

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['settings'],
      flags: { platform: 'ios' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('DEVICE_IN_USE');
    expect(response.error.details?.hint).toContain('agent-device session list');
    expect(response.error.details?.hint).toContain('--session busy-session');
    expect(response.error.details?.hint).toContain('agent-device close --session busy-session');
  }
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
});

test('open on device owned by recording session returns recording recovery hint', async () => {
  const sessionStore = makeSessionStore();
  const recordingSession = makeSession('default', {
    platform: 'apple',
    appleOs: 'ios',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  });
  recordingSession.recordOnlySession = true;
  recordingSession.screenRecording = makeTestScreenRecordingResource(recordingSession, {
    backend: 'simctl recordVideo',
    outPath: '/tmp/recording.mp4',
    startedAt: Date.now(),
    showTouches: false,
    recordOnlySession: true,
  });
  sessionStore.publish('default', recordingSession);

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    appleOs: 'ios',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  });

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'test-attempt',
      command: 'open',
      positionals: ['settings'],
      flags: { platform: 'ios' },
    },
    sessionName: 'test-attempt',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('DEVICE_IN_USE');
    expect(response.error.details?.hint).toContain('Recording session "default" owns this device');
    expect(response.error.details?.hint).toContain('agent-device record stop --session default');
    expect(response.error.details?.hint).toContain('agent-device close --session default');
    expect(response.error.details?.hint).toContain('agent-device session list');
  }
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
});

const RELAUNCH_REFUSAL = 'relaunch target refused by the platform';

async function openRelaunch(params: {
  sessionStore: ReturnType<typeof makeSessionStore>;
  validateOpenRelaunchTarget: DaemonPlatformServices['validateOpenRelaunchTarget'];
  positionals: string[];
  flags: Record<string, unknown>;
}) {
  return await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture({
      validateOpenRelaunchTarget: params.validateOpenRelaunchTarget,
    }),
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: params.positionals,
      flags: { relaunch: true, ...params.flags },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore: params.sessionStore,
    invoke: noopInvoke,
  });
}

test('open --relaunch answers a platform relaunch refusal as INVALID_ARGS with its message', async () => {
  const validateOpenRelaunchTarget = vi.fn(async () => RELAUNCH_REFUSAL);

  const response = await openRelaunch({
    sessionStore: makeSessionStore(),
    validateOpenRelaunchTarget,
    positionals: ['https://example.com/path'],
    flags: {},
  });

  assertInvalidArgsMessage(response, RELAUNCH_REFUSAL);
  expect(validateOpenRelaunchTarget).toHaveBeenCalledWith({
    target: 'https://example.com/path',
    platform: undefined,
  });
});

test('open --relaunch asks the platform about the requested target before resolving a new device', async () => {
  const validateOpenRelaunchTarget = vi.fn(async () => RELAUNCH_REFUSAL);

  const response = await openRelaunch({
    sessionStore: makeSessionStore(),
    validateOpenRelaunchTarget,
    positionals: ['/tmp/app-debug.apk'],
    flags: { platform: 'android' },
  });

  assertInvalidArgsMessage(response, RELAUNCH_REFUSAL);
  expect(validateOpenRelaunchTarget).toHaveBeenCalledWith({
    target: '/tmp/app-debug.apk',
    platform: 'android',
  });
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});

test('open --relaunch asks the platform about the active session device', async () => {
  const sessionStore = makeSessionStore();
  const session = makeSession('default', {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  session.appName = 'com.example.app';
  session.appBundleId = 'com.example.app';
  sessionStore.publish('default', session);
  const validateOpenRelaunchTarget = vi.fn(async () => RELAUNCH_REFUSAL);

  const response = await openRelaunch({
    sessionStore,
    validateOpenRelaunchTarget,
    positionals: ['/tmp/app-debug.apk'],
    flags: { platform: 'android' },
  });

  assertInvalidArgsMessage(response, RELAUNCH_REFUSAL);
  expect(validateOpenRelaunchTarget).toHaveBeenCalledWith(
    expect.objectContaining({ target: '/tmp/app-debug.apk', platform: 'android' }),
  );
});
