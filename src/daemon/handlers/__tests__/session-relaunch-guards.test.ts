import { test, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  mockResolveTargetDevice,
  mockEnsureDeviceReady,
  makeSessionStore,
  makeSession,
  noopInvoke,
  assertInvalidArgsMessage,
} from './session-test-harness.ts';
import { handleSessionCommands } from '../session.ts';

test('open --relaunch rejects URL targets', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['https://example.com/path'],
      flags: { relaunch: true },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/does not support URL targets/i);
  }
});

test('open --relaunch fails without app when no session exists', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: [],
      flags: { relaunch: true },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
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

test('open --relaunch rejects Android app binary paths', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['/tmp/app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Android runtime hints require an installed package name, not "/tmp/app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
});

test('open --relaunch rejects bare Android app binary filenames', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Android runtime hints require an installed package name, not "app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
});

test('open --relaunch rejects Android app binary paths for active sessions', async () => {
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
  sessionStore.set('default', session);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['/tmp/app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Android runtime hints require an installed package name, not "/tmp/app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
});

test('open --relaunch rejects Android app binary paths for active sessions before device refresh', async () => {
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
  sessionStore.set('default', session);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['/tmp/app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Android runtime hints require an installed package name, not "/tmp/app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
});

test('open --relaunch rejects Android app binary paths before resolving a new device', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['/tmp/app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Android runtime hints require an installed package name, not "/tmp/app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
});

test('open on in-use device returns DEVICE_IN_USE before readiness checks', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.set(
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
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['settings'],
      flags: { platform: 'ios' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
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
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  });
  recordingSession.recordOnlySession = true;
  recordingSession.recording = {
    platform: 'ios',
    child: { kill: vi.fn(), pid: 123 },
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    outPath: '/tmp/recording.mp4',
    startedAt: Date.now(),
    showTouches: false,
    gestureEvents: [],
  };
  sessionStore.set('default', recordingSession);

  mockResolveTargetDevice.mockResolvedValue({
    platform: 'apple',
    id: 'ios-device-1',
    name: 'iPhone Device',
    kind: 'device',
    booted: true,
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'test-attempt',
      command: 'open',
      positionals: ['settings'],
      flags: { platform: 'ios' },
    },
    sessionName: 'test-attempt',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
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
