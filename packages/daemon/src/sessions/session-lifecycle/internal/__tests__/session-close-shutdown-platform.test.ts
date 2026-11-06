import { daemonPlatformServicesFixture } from '../../../../__tests__/support/platform-services-fixture.ts';
import { beforeEach, expect, test } from 'vitest';
import { sessionCloseShutdownFixture } from './session-close-shutdown.fixtures.ts';
import {
  mkdtempForTestSync,
  bindTestCommandHost,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { fakeCreateCommandSurface } from '../../../../__tests__/support/command-surface-fake.ts';
import { lifecycleOperationsSpy } from '../../../../__tests__/support/lifecycle-operations-spy.ts';

bindTestCommandHost();

const {
  handleSessionCommands,
  makeSession,
  makeSessionStore,
  mockShutdownTargetRuntime,
  mockInspectDeviceRuntimeFacts,
  mockBindDeviceRuntime,
  noopInvoke,
  path,
  resetSessionCloseShutdownMocks,
} = sessionCloseShutdownFixture;

beforeEach(resetSessionCloseShutdownMocks);

function expectShutdownFailure(
  response: Awaited<ReturnType<typeof handleSessionCommands>>,
  sessionName: string,
  message: string,
): void {
  expect(response).toBeTruthy();
  if (!response?.ok) throw new Error('expected a successful close response');
  const shutdown = response.data?.shutdown as
    | {
        success?: boolean;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        error?: { code?: string; message?: string };
      }
    | undefined;
  expect(response.data?.session).toBe(sessionName);
  expect(shutdown).toMatchObject({
    success: false,
    exitCode: -1,
    stdout: '',
    stderr: message,
    error: { code: 'COMMAND_FAILED', message },
  });
}

test('close --shutdown calls shutdownSimulator for iOS simulator and includes result in response', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-shutdown-session';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-udid-1',
      name: 'iPhone 15',
      kind: 'simulator',
      booted: true,
    }),
  );

  mockShutdownTargetRuntime.mockResolvedValue({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  });

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledTimes(1);
  expect(mockBindDeviceRuntime).toHaveBeenCalledTimes(1);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(sessionStore.get(sessionName)).toBeUndefined();
  if (response && response.ok) {
    expect(response.data?.session).toBe(sessionName);
    expect(response.data?.shutdown).toEqual({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  }
});

test('close --shutdown calls shutdownAndroidEmulator for Android emulator and includes result in response', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-shutdown-session';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel_9_API_35',
      kind: 'emulator',
      booted: true,
    }),
  );

  mockShutdownTargetRuntime.mockResolvedValue({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  });

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).toHaveBeenCalledTimes(1);
  expect(sessionStore.get(sessionName)).toBeUndefined();
  if (response && response.ok) {
    expect(response.data?.session).toBe(sessionName);
    expect(response.data?.shutdown).toEqual({
      success: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
  }
});

test('close --shutdown returns success and failure payload when shutdownAndroidEmulator throws', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-shutdown-failure-session';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5556',
      name: 'Pixel_9_API_35',
      kind: 'emulator',
      booted: true,
    }),
  );

  mockShutdownTargetRuntime.mockResolvedValue({
    success: false,
    exitCode: -1,
    stdout: '',
    stderr: 'adb emu kill failed',
    error: { code: 'COMMAND_FAILED', message: 'adb emu kill failed' },
  });

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(sessionStore.get(sessionName)).toBeUndefined();
  expectShutdownFailure(response, sessionName, 'adb emu kill failed');
});

test('close --shutdown returns success and failure payload when shutdownSimulator throws', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-shutdown-failure-session';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-udid-3',
      name: 'iPhone 15',
      kind: 'simulator',
      booted: true,
    }),
  );

  mockShutdownTargetRuntime.mockResolvedValue({
    success: false,
    exitCode: -1,
    stdout: '',
    stderr: 'simctl shutdown failed',
    error: { code: 'COMMAND_FAILED', message: 'simctl shutdown failed' },
  });

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(sessionStore.get(sessionName)).toBeUndefined();
  expectShutdownFailure(response, sessionName, 'simctl shutdown failed');
});

test.each([
  {
    label: 'a non-simulator iOS device',
    device: {
      platform: 'apple' as const,
      id: 'physical-device-1',
      name: 'My iPhone',
      kind: 'device' as const,
      booted: true,
    },
  },
  {
    label: 'an Android device',
    device: {
      platform: 'android' as const,
      id: 'R5CT123456A',
      name: 'Pixel 9',
      kind: 'device' as const,
      booted: true,
    },
  },
])(
  'close --shutdown reaches the platform finalization for $label and reports no shutdown when the platform declines',
  async ({ device }) => {
    const sessionStore = makeSessionStore();
    const sessionName = `${device.platform}-device-shutdown-session`;
    sessionStore.publish(sessionName, makeSession(sessionName, device));
    const { loader, finalizeApplicationClose } = lifecycleOperationsSpy();

    const response = await handleSessionCommands({
      host: createTestHostEnvironment(),
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      lifecycleOperationsLoader: loader,
      req: {
        token: 't',
        session: sessionName,
        command: 'close',
        positionals: [],
        flags: { shutdown: true },
      },
      sessionName,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    });

    expect(response?.ok).toBe(true);
    expect(finalizeApplicationClose).toHaveBeenCalledWith(
      expect.objectContaining({ shutdownTarget: true }),
    );
    expect(sessionStore.get(sessionName)).toBeUndefined();
    if (response?.ok) {
      expect(response.data?.session).toBe(sessionName);
      expect(response.data?.shutdown).toBeUndefined();
    }
  },
);
