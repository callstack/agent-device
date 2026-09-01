import { beforeEach, expect, test, vi } from 'vitest';
import {
  sessionCloseShutdownFixture,
  type DeviceBinding,
  type PlatformRuntimeOperations,
} from './session-close-shutdown.fixtures.ts';

const {
  handleSessionCommands,
  lifecycleRuntimeFacts,
  makeSession,
  makeSessionStore,
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
  mockShutdownTargetRuntime,
  narrowDeviceBinding,
  noopInvoke,
  os,
  path,
  providerRuntimeOwner,
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
  sessionStore.set(
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
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
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

test('close --shutdown keeps a selected provider-owned iOS simulator off local simulator shutdown', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'provider-ios-shutdown-session';
  const device = {
    platform: 'apple' as const,
    id: 'limrun:ios:lease-a',
    name: 'Limrun iOS',
    kind: 'simulator' as const,
    booted: true,
  };
  sessionStore.set(sessionName, makeSession(sessionName, device));
  const providerClose = vi.fn(async () => undefined);
  const providerFinalize = vi.fn(async () => ({}));
  mockInspectDeviceRuntimeFacts.mockImplementationOnce(async (candidate) => {
    const facts = lifecycleRuntimeFacts(candidate);
    return { ...facts, device: { ...facts.device, providerMode: 'provider-runtime' as const } };
  });
  mockBindDeviceRuntime.mockImplementationOnce(async (candidate, use) => {
    const facts = await mockInspectDeviceRuntimeFacts(candidate);
    return narrowDeviceBinding(
      {
        device: candidate,
        owner: providerRuntimeOwner('limrun', 'lease-a'),
        facts,
        operations: {
          closeApplication: providerClose,
          finalizeApplicationClose: providerFinalize,
        },
        [Symbol.asyncDispose]: async () => undefined,
      } satisfies DeviceBinding<PlatformRuntimeOperations>,
      use,
    );
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(providerClose).not.toHaveBeenCalled();
  expect(providerFinalize).toHaveBeenCalledWith(expect.objectContaining({ shutdownTarget: true }));
  if (response?.ok) expect(response.data?.shutdown).toBeUndefined();
});

test('close --shutdown calls shutdownAndroidEmulator for Android emulator and includes result in response', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-shutdown-session';
  sessionStore.set(
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
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
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

test('close --shutdown is ignored for non-simulator iOS devices', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-shutdown-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'physical-device-1',
      name: 'My iPhone',
      kind: 'device',
      booted: true,
    }),
  );

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)).toBeUndefined();
  if (response && response.ok) {
    expect(response.data?.session).toBe(sessionName);
    expect(response.data?.shutdown).toBeUndefined();
  }
});

test('close --shutdown is ignored for Android devices', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-device-shutdown-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'R5CT123456A',
      name: 'Pixel 9',
      kind: 'device',
      booted: true,
    }),
  );

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(mockShutdownTargetRuntime).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)).toBeUndefined();
  if (response && response.ok) {
    expect(response.data?.session).toBe(sessionName);
    expect(response.data?.shutdown).toBeUndefined();
  }
});

test('close --shutdown returns success and failure payload when shutdownAndroidEmulator throws', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-shutdown-failure-session';
  sessionStore.set(
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
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(sessionStore.get(sessionName)).toBeUndefined();
  expectShutdownFailure(response, sessionName, 'adb emu kill failed');
});

test('close --shutdown returns success and failure payload when shutdownSimulator throws', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-shutdown-failure-session';
  sessionStore.set(
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
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { shutdown: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(sessionStore.get(sessionName)).toBeUndefined();
  expectShutdownFailure(response, sessionName, 'simctl shutdown failed');
});
