import { test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mockRunCmd, makeSessionStore, makeSession, noopInvoke } from './session-test-harness.ts';
import { handleSessionCommands } from '../session.ts';

test('network requires an active session', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'network',
      positionals: ['dump'],
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

test('network dump adds a targeted note when the session app log stream is inactive', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-network-inactive';
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
      getState: () => 'failed',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.active).toBe(true);
    expect(response.data?.state).toBe('failed');
    expect(response.data?.notes).toContain(
      'Session app log stream is inactive. Run logs clear --restart, reproduce the request window again, then rerun network dump.',
    );
  }
});

test('network dump recovers Android entries from adb logcat when the session stream is inactive', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-network-recovery';
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
      getState: () => 'failed',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.join(' ') === '-s emulator-5554 shell pidof com.example.app') {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (args.join(' ') === '-s emulator-5554 logcat -d -v time -t 4000') {
      return {
        stdout:
          '04-01 10:00:14.500 I/ActivityManager( 9999): Start proc 4321:com.example.app/u0a123 for top-activity\n' +
          '04-01 10:00:15.000 D/GIBSDK  (4321): POST https://api.example.com/v1/documents status=200 duration=15032\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.path).toContain('adb logcat recovery');
    expect(response.data?.state).toBe('failed');
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(1);
    const latest = entries[0] as Record<string, unknown>;
    expect(latest.method).toBe('POST');
    expect(latest.url).toBe('https://api.example.com/v1/documents');
    expect(latest.status).toBe(200);
    expect(response.data?.notes).toContain(
      'Session app log stream was inactive. Recovered recent Android HTTP entries from adb logcat for PID set 4321.',
    );
  }
});

test('network dump merges Android recovery entries ahead of stale session log traffic', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-network-merge';
  const appLogPath = sessionStore.resolveAppLogPath(sessionName);
  fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  fs.writeFileSync(
    appLogPath,
    '2026-04-01T09:59:00Z GET https://api.example.com/v1/stale status=200\n',
    'utf8',
  );
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
      outPath: appLogPath,
      startedAt: Date.now(),
      getState: () => 'failed',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.join(' ') === '-s emulator-5554 shell pidof com.example.app') {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (args.join(' ') === '-s emulator-5554 logcat -d -v time -t 4000') {
      return {
        stdout:
          '04-01 10:00:14.500 I/ActivityManager( 9999): Start proc 4321:com.example.app/u0a123 for top-activity\n' +
          '04-01 10:00:15.000 D/GIBSDK  (4321): POST https://api.example.com/v1/fresh status=201 duration=15032\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(2);
    expect((entries[0] as Record<string, unknown>).url).toBe('https://api.example.com/v1/fresh');
    expect((entries[1] as Record<string, unknown>).url).toBe('https://api.example.com/v1/stale');
  }
});

test('network dump recovers Android entries from previous package pid in bounded logcat window', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-network-previous-pid';
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
      getState: () => 'failed',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.join(' ') === '-s emulator-5554 shell pidof com.example.app') {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (args.join(' ') === '-s emulator-5554 logcat -d -v time -t 4000') {
      return {
        stdout:
          '04-01 10:00:00.000 I/ActivityManager( 9999): Process com.example.app (pid 1234) has died\n' +
          '04-01 10:00:00.500 D/GIBSDK  (1234): POST https://api.example.com/v1/submit status=504 duration=15000\n' +
          '04-01 10:00:01.000 I/ActivityManager( 9999): Start proc 4321:com.example.app/u0a123 for top-activity\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(1);
    expect((entries[0] as Record<string, unknown>).url).toBe('https://api.example.com/v1/submit');
    expect(response.data?.notes).toContain(
      'Session app log stream was inactive. Recovered recent Android HTTP entries from adb logcat for PID set 4321, 1234.',
    );
  }
});

test('network dump recovers Android entries when an active stream is still bound to a prior pid', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-network-stale-active-pid';
  const appLogPath = sessionStore.resolveAppLogPath(sessionName);
  const appLogPidPath = sessionStore.resolveAppLogPidPath(sessionName);
  fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  fs.writeFileSync(
    appLogPath,
    '2026-04-01T09:59:00Z GET https://api.example.com/v1/stale status=200\n',
    'utf8',
  );
  fs.writeFileSync(
    appLogPidPath,
    `${JSON.stringify({
      pid: 9999,
      startTime: 'Tue Apr  1 09:59:00 2026',
      command: 'adb -s emulator-5554 logcat -v time --pid 1234',
    })}\n`,
    'utf8',
  );
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
      outPath: appLogPath,
      startedAt: Date.now(),
      getState: () => 'active',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.join(' ') === '-s emulator-5554 shell pidof com.example.app') {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (args.join(' ') === '-s emulator-5554 logcat -d -v time -t 4000') {
      return {
        stdout:
          '04-01 10:00:14.500 I/ActivityManager( 9999): Start proc 4321:com.example.app/u0a123 for top-activity\n' +
          '04-01 10:00:15.000 D/GIBSDK  (4321): POST https://api.example.com/v1/fresh status=201 duration=15032\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.path).toContain('adb logcat recovery');
    expect(response.data?.state).toBe('active');
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(2);
    expect((entries[0] as Record<string, unknown>).url).toBe('https://api.example.com/v1/fresh');
    expect((entries[1] as Record<string, unknown>).url).toBe('https://api.example.com/v1/stale');
    expect(response.data?.notes).toContain(
      'Session app log stream was still bound to prior Android PID 1234. Recovered recent Android HTTP entries from adb logcat for PID set 4321.',
    );
  }
});

test('network dump recovers iOS simulator entries from simctl log show when the live stream is empty', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-network-recovery';
  const appLogPath = sessionStore.resolveAppLogPath(sessionName);
  fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  fs.writeFileSync(
    appLogPath,
    'Filtering the log data using "subsystem == \\"com.agentdevice.tester\\""\n',
    'utf8',
  );
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.agentdevice.tester',
    appLog: {
      platform: 'apple',
      backend: 'ios-simulator',
      outPath: appLogPath,
      startedAt: 1_712_040_000_000,
      getState: () => 'active',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (
      args[0] === 'simctl' &&
      args[1] === 'spawn' &&
      args[2] === 'sim-1' &&
      args[3] === 'log' &&
      args[4] === 'show'
    ) {
      return {
        stdout:
          'Timestamp               Ty Process[PID:TID]\n' +
          '2026-04-02 08:08:50.665 I Agent Device Tester[32193:8c7411e] POST https://api.example.com/v1/search statusCode=200 duration=42\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.path).toContain('simctl log show recovery');
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(1);
    expect((entries[0] as Record<string, unknown>).url).toBe('https://api.example.com/v1/search');
    expect((entries[0] as Record<string, unknown>).status).toBe(200);
    expect((entries[0] as Record<string, unknown>).durationMs).toBe(42);
    expect(response.data?.notes).toContain(
      'Recovered 1 iOS simulator HTTP entry from simctl log show (1 app log lines scanned).',
    );
  }
});

test('network dump explains when iOS simulator recovery found app logs but no HTTP-shaped entries', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-network-no-http';
  const appLogPath = sessionStore.resolveAppLogPath(sessionName);
  fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  fs.writeFileSync(
    appLogPath,
    'Filtering the log data using "subsystem == \\"com.agentdevice.tester\\""\n',
    'utf8',
  );
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.agentdevice.tester',
    appLog: {
      platform: 'apple',
      backend: 'ios-simulator',
      outPath: appLogPath,
      startedAt: 1_712_040_000_000,
      getState: () => 'active',
      stop: async () => {},
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (
      args[0] === 'simctl' &&
      args[1] === 'spawn' &&
      args[2] === 'sim-1' &&
      args[3] === 'log' &&
      args[4] === 'show'
    ) {
      return {
        stdout:
          'Timestamp               Ty Process[PID:TID]\n' +
          '2026-04-02 08:08:50.665 E Agent Device Tester[32193:8c7411e] Airship config warning\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(Array.isArray(response.data?.entries) ? response.data.entries : []).toHaveLength(0);
    expect(response.data?.notes).toContain(
      'Recovered 1 recent iOS simulator app log lines from simctl log show, but none looked like HTTP traffic. This app may not emit request URLs, status, or timing into Unified Logging for this repro window.',
    );
    expect(response.data?.notes).toContain(
      'No HTTP(s) entries were found in recent iOS simulator app logs. If the app only emits non-HTTP diagnostics, inspect logs path or add app-side URLSession/network logging for per-request timing and payload details.',
    );
  }
});

test('network dump supports macOS desktop sessions', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-network';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-macos-local',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    appBundleId: 'com.apple.systempreferences',
  });
  const appLogPath = sessionStore.resolveAppLogPath(sessionName);
  fs.mkdirSync(path.dirname(appLogPath), { recursive: true });
  fs.writeFileSync(
    appLogPath,
    '2026-02-24T10:00:00Z GET https://example.com/mac status=204',
    'utf8',
  );
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'summary'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.backend).toBe('macos');
    const entries = Array.isArray(response.data?.entries) ? response.data.entries : [];
    expect(entries.length).toBe(1);
    expect((entries[0] as Record<string, unknown>).url).toBe('https://example.com/mac');
  }
});

test('network dump validates include mode and limit', async () => {
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

  const invalidLimit = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '0'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(invalidLimit).toBeTruthy();
  expect(invalidLimit?.ok).toBe(false);
  if (invalidLimit && !invalidLimit.ok) {
    expect(invalidLimit.error.code).toBe('INVALID_ARGS');
    expect(invalidLimit.error.message).toMatch(/1\.\.200/);
  }

  const invalidMode = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'network',
      positionals: ['dump', '10', 'verbose'],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(invalidMode).toBeTruthy();
  expect(invalidMode?.ok).toBe(false);
  if (invalidMode && !invalidMode.ok) {
    expect(invalidMode.error.code).toBe('INVALID_ARGS');
    expect(invalidMode.error.message).toMatch(/summary, headers, body, all/);
  }
});
