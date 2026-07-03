import { test, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppError } from '../../../kernel/errors.ts';
import {
  IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED,
  IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED_NOTE,
} from '../../app-log-ios.ts';
import {
  mockStartAppLog,
  mockRunAppLogDoctor,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from './session-test-harness.ts';
import { handleSessionCommands } from '../session.ts';

test('logs requires an active session', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'logs',
      positionals: ['path'],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
  }
});

test('logs rejects invalid action', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.set(
    'default',
    makeSession('default', {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone',
      kind: 'simulator',
      booted: true,
    }),
  );
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'logs',
      positionals: ['invalid'],
      flags: {},
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
    expect(response.error.message).toMatch(/path, start, stop, doctor, mark, or clear/);
  }
});

test('logs start requires app session (appBundleId)', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.set(
    'default',
    makeSession('default', {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone',
      kind: 'simulator',
      booted: true,
    }),
  );
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'logs',
      positionals: ['start'],
      flags: {},
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
    expect(response.error.message).toMatch(/app session|open first/i);
  }
});

test('logs stop requires active app log stream', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.set(
    'default',
    makeSession('default', {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone',
      kind: 'simulator',
      booted: true,
    }),
  );
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'logs',
      positionals: ['stop'],
      flags: {},
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
    expect(response.error.message).toMatch(/no app log stream/i);
  }
});

test('logs clear requires stream to be stopped first', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    appLog: {
      platform: 'android',
      backend: 'android',
      outPath: '/tmp/app.log',
      startedAt: Date.now(),
      getState: () => 'active',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'logs',
      positionals: ['clear'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/logs stop/i);
  }
});

test('logs --restart is only supported with logs clear', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone Simulator',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
  });
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'logs',
      positionals: ['path'],
      flags: { restart: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/only supported with logs clear/i);
  }
});

test('logs clear --restart requires app session bundle id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'logs',
      positionals: ['clear'],
      flags: { restart: true },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/app session|open <app>/i);
  }
});

function makeIosDeviceLogSession(): {
  sessionStore: ReturnType<typeof makeSessionStore>;
  sessionName: string;
} {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-console-logs';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'ios',
      id: '00008150-0000AAAA',
      name: 'iPhone',
      kind: 'device',
    }),
    appBundleId: 'com.example.app',
  });
  return { sessionStore, sessionName };
}

function mockIosDeviceLogBackend(): void {
  mockStartAppLog.mockResolvedValue({
    backend: 'ios-device',
    startedAt: 1_712_040_000_000,
    getState: () => 'active',
    stop: async () => {},
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  });
  mockRunAppLogDoctor.mockResolvedValue({
    checks: { devicectlAvailable: true, devicectlConsoleCapture: true },
    notes: [],
  });
}

function mockUnsupportedIosDeviceLogBackend(): void {
  mockStartAppLog.mockRejectedValue(
    new AppError('UNSUPPORTED_OPERATION', IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED.message, {
      backend: 'ios-device',
      hint: IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED.hint,
    }),
  );
  mockRunAppLogDoctor.mockResolvedValue({
    checks: { devicectlAvailable: true, devicectlConsoleCapture: false },
    notes: [IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED_NOTE],
  });
}

async function runLogsCommandForSession(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
  action: 'clear' | 'path' | 'doctor',
  flags: Record<string, unknown> = {},
) {
  return await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'logs',
      positionals: [action],
      flags,
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
}

function expectActiveIosDeviceLogsPath(
  response: Awaited<ReturnType<typeof handleSessionCommands>>,
) {
  expect(response?.ok).toBe(true);
  if (!response || !response.ok) return;
  expect(response.data?.active).toBe(true);
  expect(response.data?.state).toBe('active');
  expect(response.data?.backend).toBe('ios-device');
  expect(response.data?.failureCode).toBeUndefined();
  expect(response.data?.failureMessage).toBeUndefined();
  expect(response.data?.startedAt).toBe('2024-04-02T06:40:00.000Z');
}

function expectEndedIosDeviceLogsPath(response: Awaited<ReturnType<typeof handleSessionCommands>>) {
  expect(response?.ok).toBe(true);
  if (!response || !response.ok) return;
  expect(response.data?.active).toBe(false);
  expect(response.data?.state).toBe('ended');
  expect(response.data?.backend).toBe('ios-device');
  expect(response.data?.notes).toContain(
    'The app log stream process ended. Run logs clear --restart before the next capture window.',
  );
}

function expectActiveIosDeviceLogsDoctor(
  response: Awaited<ReturnType<typeof handleSessionCommands>>,
) {
  expect(response?.ok).toBe(true);
  if (!response || !response.ok) return;
  expect(response.data?.active).toBe(true);
  expect(response.data?.state).toBe('active');
  expect(response.data?.backend).toBe('ios-device');
  expect(response.data?.checks).toEqual({
    devicectlAvailable: true,
    devicectlConsoleCapture: true,
  });
  expect(response.data?.notes).toEqual([]);
}

function expectUnsupportedIosDeviceLogsDoctor(
  response: Awaited<ReturnType<typeof handleSessionCommands>>,
) {
  expect(response?.ok).toBe(true);
  if (!response || !response.ok) return;
  expect(response.data?.active).toBe(false);
  expect(response.data?.state).toBe('failed');
  expect(response.data?.backend).toBe('ios-device');
  expect(response.data?.failureCode).toBe('UNSUPPORTED_OPERATION');
  expect(response.data?.notes).toEqual([IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED_NOTE]);
}

test('logs clear --restart starts active iOS physical-device console capture', async () => {
  const { sessionStore, sessionName } = makeIosDeviceLogSession();
  mockIosDeviceLogBackend();

  const restartResponse = await runLogsCommandForSession(sessionStore, sessionName, 'clear', {
    restart: true,
  });
  expect(restartResponse?.ok).toBe(true);
  if (restartResponse && restartResponse.ok) {
    expect(restartResponse.data?.restarted).toBe(true);
  }
  expect(mockStartAppLog).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', id: '00008150-0000AAAA' }),
    'com.example.app',
    expect.stringContaining('app.log'),
    expect.stringContaining('app-log.pid'),
  );

  expectActiveIosDeviceLogsPath(await runLogsCommandForSession(sessionStore, sessionName, 'path'));
  expectActiveIosDeviceLogsDoctor(
    await runLogsCommandForSession(sessionStore, sessionName, 'doctor'),
  );
});

test('logs path reports cleanly ended iOS physical-device console capture as inactive', async () => {
  const { sessionStore, sessionName } = makeIosDeviceLogSession();
  const session = sessionStore.get(sessionName);
  if (!session) throw new Error('Expected test session');
  sessionStore.set(sessionName, {
    ...session,
    appLog: {
      platform: 'apple',
      backend: 'ios-device',
      outPath: '/tmp/app.log',
      startedAt: 1_712_040_000_000,
      getState: () => 'ended',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  expectEndedIosDeviceLogsPath(await runLogsCommandForSession(sessionStore, sessionName, 'path'));
});

test('logs doctor deduplicates unsupported iOS physical-device console capture notes', async () => {
  const { sessionStore, sessionName } = makeIosDeviceLogSession();
  mockUnsupportedIosDeviceLogBackend();

  const restartResponse = await runLogsCommandForSession(sessionStore, sessionName, 'clear', {
    restart: true,
  });
  expect(restartResponse?.ok).toBe(false);
  expectUnsupportedIosDeviceLogsDoctor(
    await runLogsCommandForSession(sessionStore, sessionName, 'doctor'),
  );
});
