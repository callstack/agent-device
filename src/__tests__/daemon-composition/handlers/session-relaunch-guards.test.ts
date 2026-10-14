import { test, expect } from 'vitest';
import * as path from 'node:path';
import {
  mockResolveTargetDevice,
  makeSessionStore,
  makeSession,
  noopInvoke,
  assertInvalidArgsMessage,
} from '../../../daemon/handlers/__tests__/session-test-harness.ts';
import { handleSessionCommands } from '../../../daemon/handlers/__tests__/session-command-harness.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { fakeCreateCommandSurface } from '../../../daemon/__tests__/support/command-surface-fake.ts';
import { composedPlatformServicesFixture } from '../platform-services-fixture.ts';

// These relaunch cases pin the REAL open-target validation rules (the URL-target refusal and the
// Android installed-package classification with its exact message) reached through the daemon's
// `open --relaunch` flow. The daemon-lane port fixture answers `validateOpenRelaunchTarget` with a
// canned accept, so the rule-pinning cases run here on the real composed services.

test('open --relaunch rejects URL targets', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['https://example.com/path'],
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
    expect(response.error.message).toMatch(/does not support URL targets/i);
  }
});

test('open --relaunch rejects Android app binary paths', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['/tmp/app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
  sessionStore.publish('default', session);

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['/tmp/app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'open',
      positionals: ['/tmp/app-debug.apk'],
      flags: { relaunch: true, platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  assertInvalidArgsMessage(
    response,
    'Android runtime hints require an installed package name, not "/tmp/app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});
