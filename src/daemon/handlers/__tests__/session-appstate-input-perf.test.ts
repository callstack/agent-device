import { test, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppError } from '../../../kernel/errors.ts';
import {
  mockDispatch,
  mockResolveTargetDevice,
  mockRunCmd,
  makeSessionStore,
  makeSession,
  noopInvoke,
} from './session-test-harness.ts';
import type { SessionState } from '../../types.ts';
import { handleSessionCommands } from '../session.ts';

test('appstate on iOS requires active session on selected device', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 15',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.apple.Preferences',
    appName: 'Settings',
  });
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);
  mockDispatch.mockRejectedValue(new Error('snapshot dispatch should not run'));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'appstate',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/requires an active session/i);
  }
});

test('appstate returns session appName when bundle id is unavailable', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'sim';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appName: 'Maps',
  });

  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);
  mockDispatch.mockRejectedValue(new Error('snapshot dispatch should not run'));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'appstate',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.platform).toBe('ios');
    expect(response.data?.appName).toBe('Maps');
    expect(response.data?.appBundleId).toBe(undefined);
    expect(response.data?.source).toBe('session');
    expect(response.data?.device_udid).toBe('sim-1');
    expect(response.data?.ios_simulator_device_set).toBe(null);
  }
});

test('appstate fails when iOS session has no tracked app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'sim';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
  );

  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'appstate',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toMatch(/no foreground app is tracked/i);
  }
});

test('appstate without session on iOS selector returns SESSION_NOT_FOUND', async () => {
  const sessionStore = makeSessionStore();
  const selectedDevice: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-2',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  };
  mockResolveTargetDevice.mockResolvedValue(selectedDevice);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'appstate',
      positionals: [],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
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

test('appstate with explicit missing session returns SESSION_NOT_FOUND', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'sim',
      command: 'appstate',
      positionals: [],
      flags: { session: 'sim', platform: 'ios', device: 'iPhone 17 Pro' },
    },
    sessionName: 'sim',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/no active session "sim"/i);
    expect(response.error.message).not.toMatch(/omit --session/i);
  }
});

test('clipboard requires an active session or explicit device selector', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'clipboard',
      positionals: ['read'],
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
    expect(response.error.message).toMatch(
      /clipboard requires an active session or an explicit device selector/i,
    );
  }
});

test('keyboard requires an active session or explicit device selector', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'keyboard',
      positionals: ['status'],
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
    expect(response.error.message).toMatch(
      /keyboard requires an active session or an explicit device selector/i,
    );
  }
});

test('keyboard dismiss requires active iOS session for explicit selectors', async () => {
  const sessionStore = makeSessionStore();

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'keyboard',
      positionals: ['dismiss'],
      flags: { platform: 'ios', device: 'iPhone 17 Pro' },
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
    expect(response.error.message).toMatch(/requires an active session/i);
  }
});

test('clipboard rejects unsupported iOS physical devices', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-session';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
  );

  mockDispatch.mockRejectedValue(new Error('dispatch should not run for unsupported targets'));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'clipboard',
      positionals: ['read'],
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
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/clipboard is not supported on this device/i);
  }
});

test('perf requires an active session', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'perf',
      positionals: [],
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

test('perf reports startup metric as unavailable when no sample exists', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-empty';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
  );

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    const startup = (response.data?.metrics as any)?.startup;
    const memory = (response.data?.metrics as any)?.memory;
    const cpu = (response.data?.metrics as any)?.cpu;
    expect(startup?.available).toBe(false);
    expect(String(startup?.reason ?? '')).toMatch(/no startup sample captured yet/i);
    expect(memory?.available).toBe(false);
    expect(String(memory?.reason ?? '')).toMatch(/run open <app> first/i);
    expect(cpu?.available).toBe(false);
    expect(String(cpu?.reason ?? '')).toMatch(/run open <app> first/i);
  }
});

test('perf preserves successful metrics and normalizes per-metric Android sampling failures', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-android-error';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
  });
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (args.includes('meminfo')) {
      throw new AppError('COMMAND_FAILED', 'adb exited with code 1', {
        stderr: 'error: device offline',
        exitCode: 1,
        processExitError: true,
      });
    }
    return {
      stdout: '0.0% 1234/com.example.app: 0% user + 0% kernel',
      stderr: '',
      exitCode: 0,
    };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    const startup = (response.data?.metrics as any)?.startup;
    const memory = (response.data?.metrics as any)?.memory;
    const cpu = (response.data?.metrics as any)?.cpu;
    expect(startup?.available).toBe(false);
    expect(memory?.available).toBe(false);
    expect(memory?.reason).toBe('error: device offline');
    expect(memory?.error?.code).toBe('COMMAND_FAILED');
    expect(memory?.error?.hint).toMatch(/adb reconnect/i);
    expect(memory?.error?.details?.metric).toBe('memory');
    expect(memory?.error?.details?.package).toBe('com.example.app');
    expect(cpu?.available).toBe(true);
    expect(cpu?.usagePercent).toBe(0);
  }
});

test('perf samples Apple cpu and memory metrics on macOS app sessions', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-macos';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'host-mac',
      name: 'Host Mac',
      kind: 'device',
      target: 'desktop',
      booted: true,
    }),
    appBundleId: 'com.example.mac',
  });
  mockRunCmd.mockImplementation(async (cmd, _args) => {
    if (cmd === 'mdfind') {
      return { stdout: '/Applications/Example.app\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: 'ExampleExec\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'ps') {
      return {
        stdout: [
          '111 7.5 4096 /Applications/Example.app/Contents/MacOS/ExampleExec',
          '222 0.5 1024 /Applications/Example.app/Contents/MacOS/ExampleExec --flag',
          '333 5.0 2048 /Applications/Other.app/Contents/MacOS/OtherExec',
        ].join('\n'),
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
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('Expected perf response to succeed for macOS session');
  const memory = (response.data?.metrics as any)?.memory;
  const cpu = (response.data?.metrics as any)?.cpu;
  expect(memory?.available).toBe(true);
  expect(memory?.residentMemoryKb).toBe(5120);
  expect(cpu?.available).toBe(true);
  expect(cpu?.usagePercent).toBe(8);
  expect(cpu?.matchedProcesses).toEqual(['ExampleExec']);
});

test('perf samples Apple cpu and memory metrics on iOS simulator app sessions', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-ios-sim';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.example.sim',
  });
  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'xcrun' && args.includes('get_app_container')) {
      return { stdout: '/tmp/Example.app\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'plutil') {
      return { stdout: 'ExampleSimExec\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'xcrun' && args.includes('spawn') && args.includes('ps')) {
      return {
        stdout: ['111 11.0 6144 ExampleSimExec', '222 2.0 2048 SpringBoard'].join('\n'),
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
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('Expected perf response to succeed for iOS simulator session');
  const memory = (response.data?.metrics as any)?.memory;
  const cpu = (response.data?.metrics as any)?.cpu;
  expect(memory?.available).toBe(true);
  expect(memory?.residentMemoryKb).toBe(6144);
  expect(cpu?.available).toBe(true);
  expect(cpu?.usagePercent).toBe(11);
  expect(cpu?.matchedProcesses).toEqual(['ExampleSimExec']);
});

test('perf samples Apple cpu and memory metrics on physical iOS devices', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-01T10:00:00.000Z'));
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-ios-device';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
    appBundleId: 'com.example.device',
  });
  let exportCount = 0;
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    if (
      args[0] === 'devicectl' &&
      args[1] === 'device' &&
      args[2] === 'info' &&
      args[3] === 'apps'
    ) {
      const outputIndex = args.indexOf('--json-output');
      fs.writeFileSync(
        args[outputIndex + 1]!,
        JSON.stringify({
          result: {
            apps: [
              {
                bundleIdentifier: 'com.example.device',
                name: 'Example Device App',
                url: 'file:///private/var/containers/Bundle/Application/ABC123/ExampleDevice.app/',
              },
            ],
          },
        }),
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (
      args[0] === 'devicectl' &&
      args[1] === 'device' &&
      args[2] === 'info' &&
      args[3] === 'processes'
    ) {
      const outputIndex = args.indexOf('--json-output');
      fs.writeFileSync(
        args[outputIndex + 1]!,
        JSON.stringify({
          result: {
            runningProcesses: [
              {
                executable:
                  'file:///private/var/containers/Bundle/Application/ABC123/ExampleDevice.app/ExampleDeviceApp',
                processIdentifier: 4001,
              },
            ],
          },
        }),
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'xctrace' && args[1] === 'record') {
      vi.setSystemTime(new Date(Date.now() + 1000));
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (args[0] === 'xctrace' && args[1] === 'export') {
      const outputIndex = args.indexOf('--output');
      exportCount += 1;
      await fs.promises.writeFile(
        args[outputIndex + 1]!,
        [
          '<?xml version="1.0"?>',
          '<trace-query-result>',
          '<node xpath="//trace-toc[1]/run[1]/data[1]/table[7]">',
          '<schema name="activity-monitor-process-live">',
          '<col><mnemonic>start</mnemonic></col>',
          '<col><mnemonic>process</mnemonic></col>',
          '<col><mnemonic>cpu-total</mnemonic></col>',
          '<col><mnemonic>memory-real</mnemonic></col>',
          '<col><mnemonic>pid</mnemonic></col>',
          '</schema>',
          '<row>',
          '<start-time fmt="00:00.123">123</start-time>',
          '<process fmt="ExampleDeviceApp (4001)"><pid fmt="4001">4001</pid></process>',
          exportCount === 1
            ? '<duration-on-core fmt="100.00 ms">100000000</duration-on-core>'
            : '<duration-on-core fmt="350.00 ms">350000000</duration-on-core>',
          '<size-in-bytes fmt="8.00 MiB">8388608</size-in-bytes>',
          '<pid fmt="4001">4001</pid>',
          '</row>',
          '</node>',
          '</trace-query-result>',
        ].join(''),
      );
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) throw new Error('Expected perf response to succeed for physical iOS session');
  const memory = (response.data?.metrics as any)?.memory;
  const cpu = (response.data?.metrics as any)?.cpu;
  expect(memory?.available).toBe(true);
  expect(memory?.residentMemoryKb).toBe(8192);
  expect(cpu?.available).toBe(true);
  expect(cpu?.usagePercent).toBe(25);
  expect(cpu?.matchedProcesses).toEqual(['ExampleDeviceApp']);
});

test('perf reports physical iOS cpu and memory as unavailable without an app bundle id', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'perf-session-ios-device-no-bundle';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-2',
      name: 'iPhone Device',
      kind: 'device',
      booted: true,
    }),
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'perf',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) {
    throw new Error('Expected perf response to succeed for physical iOS session without bundle id');
  }
  const memory = (response.data?.metrics as any)?.memory;
  const cpu = (response.data?.metrics as any)?.cpu;
  expect(memory?.available).toBe(false);
  expect(memory?.reason).toMatch(/no apple app bundle id is associated with this session/i);
  expect(cpu?.available).toBe(false);
  expect(cpu?.reason).toMatch(/no apple app bundle id is associated with this session/i);
});
