import { expect, test, vi } from 'vitest';
import type { HostCommandRequest } from '@agent-device/contracts/platform-runtime-host';
import type { NetworkDumpInput } from '@agent-device/contracts/network-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { dumpAndroidNetworkTraffic } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test('recovers inactive Android traffic for current and previous package pids before stale entries', async () => {
  const result = await dumpAndroidNetworkTraffic(
    host({
      marker: { status: 'missing' },
      command: (request) => commandResult(request, '222'),
      appLogText: '01-01 00:00:00.000 D/App (99): GET https://stale.example.test status=200',
      logcat: [
        '01-01 00:00:00.000 I/ActivityManager( 100): Start proc 111:com.example.app/u0a1',
        '01-01 00:00:01.000 D/App (111): GET https://previous.example.test status=200',
        '01-01 00:00:02.000 D/App (222): GET https://current.example.test status=201',
      ].join('\n'),
    }),
    device,
    input({ appLogSnapshot: { state: 'ended', startedAt: 1 } }),
    new AbortController().signal,
  );

  expect(result).toMatchObject({
    source: 'app-log',
    backend: 'android',
    dump: {
      entries: [
        { url: 'https://current.example.test' },
        { url: 'https://previous.example.test' },
        { url: 'https://stale.example.test' },
      ],
    },
  });
  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.notes[0]).toContain('PID set 222, 111');
});

test('detects an active stream still bound to the previous Android pid', async () => {
  const command = vi.fn((request: HostCommandRequest) => commandResult(request, '222'));
  const result = await dumpAndroidNetworkTraffic(
    host({
      marker: {
        status: 'decoded',
        marker: { pid: 42, startTime: 'start', command: 'adb logcat --pid 111' },
      },
      command,
      logcat: '01-01 00:00:02.000 D/App (222): GET https://fresh.example.test status=201',
    }),
    device,
    input({ appLogSnapshot: { state: 'active', startedAt: 1 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.notes[0]).toContain('prior Android PID 111');
  expect(command.mock.calls.some(([request]) => request.args.includes('logcat'))).toBe(true);
});

test('keeps canonical traffic when optional logcat recovery fails', async () => {
  const result = await dumpAndroidNetworkTraffic(
    host({
      marker: { status: 'missing' },
      command: (request) => commandResult(request, '222'),
      appLogText: '01-01 00:00:00.000 D/App (222): GET https://canonical.example.test status=200',
      logcat: new Error('adb transport unavailable'),
    }),
    device,
    input({ appLogSnapshot: { state: 'ended', startedAt: 1 } }),
    new AbortController().signal,
  );

  expect(result).toMatchObject({
    source: 'app-log',
    dump: { entries: [{ url: 'https://canonical.example.test', status: 200 }] },
  });
});

test('preserves the exact request cancellation reason during optional recovery', async () => {
  const controller = new AbortController();
  const reason = new Error('request cancelled');
  controller.abort(reason);

  await expect(
    dumpAndroidNetworkTraffic(
      host({
        marker: { status: 'missing' },
        command: (request) => commandResult(request, '222'),
        logcat: new Error('transport error after cancellation'),
      }),
      device,
      input({ appLogSnapshot: { state: 'ended', startedAt: 1 } }),
      controller.signal,
    ),
  ).rejects.toBe(reason);
});

function input(overrides: Partial<NetworkDumpInput> = {}): NetworkDumpInput {
  return {
    sessionId: 'one',
    appBundleId: 'com.example.app',
    maxEntries: 25,
    include: 'summary',
    maxPayloadChars: 2048,
    maxScanLines: 4000,
    ...overrides,
  };
}

function host(options: {
  marker: Awaited<ReturnType<PlatformRuntimeHost['appLogs']['readProcessMarker']>>;
  command(request: HostCommandRequest): { stdout: string; stderr: string; exitCode: number };
  appLogText?: string;
  logcat: string | Error;
}): PlatformRuntimeHost {
  return {
    ...unusedAppLogHost(),
    commands: {
      which: async () => undefined,
      run: async (request) => {
        if (!request.args.includes('logcat')) return options.command(request);
        options.command(request);
        if (options.logcat instanceof Error) throw options.logcat;
        return { stdout: options.logcat, stderr: '', exitCode: 0 };
      },
    },
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => {
        throw new Error('unused');
      },
    },
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/one/app.log',
        exists: options.appLogText !== undefined,
        text: options.appLogText ?? '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => options.marker,
    },
    networkTransports: { resolve: async () => ({ mode: 'local' }) },
    appInventory: {
      apple: { listApps: async () => [] },
      android: { listApps: async () => [] },
      harmonyos: { listApps: async () => [] },
    },
  };
}

function commandResult(request: HostCommandRequest, pid: string) {
  return request.args.includes('pidof')
    ? { stdout: `${pid}\n`, stderr: '', exitCode: 0 }
    : { stdout: '', stderr: '', exitCode: 0 };
}

function unusedAppLogHost(): Omit<
  PlatformRuntimeHost,
  'appleTools' | 'commands' | 'appLogs' | 'networkTransports'
> {
  return {
    toolchains: { prepare: async () => {} },
    artifacts: {
      resolveSession: () => ({
        outputPath: '/sessions/one/app.log',
        pidPath: '/sessions/one/app-log.pid',
      }),
    },
    outputs: {
      openAppend: async () => {
        throw new Error('unused');
      },
      readTail: async () => '',
    },
    processes: {
      start: async () => {
        throw new Error('unused');
      },
      readMarker: async () => ({ status: 'missing' }),
      clearMarker: async () => {},
      inspect: async () => 'missing',
      terminate: async () => 'already-missing',
    },
    processTransports: { resolve: async () => ({ mode: 'local' }) },
    appInventory: {
      apple: { listApps: async () => [] },
      android: { listApps: async () => [] },
      harmonyos: { listApps: async () => [] },
    },
    clock: { now: () => 1, sleep: async () => {} },
    appState: {
      android: { run: async () => ({ stdout: '' }) },
      harmonyos: { run: async () => ({ stdout: '' }) },
    },
    deviceReadiness: {
      applePhysical: { ensureConnected: async () => {} },
      appleAutomation: {
        keepHot: () => {},
        markBooted: () => {},
        wasRecentlyObservedBooted: async () => false,
      },
      androidEmulator: { discover: async () => [], launch: () => 1, terminate: async () => {} },
    },
    deviceShutdown: {
      apple: {
        shutdownTarget: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
      },
      android: {
        shutdownTarget: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
      },
    },
    screenRecording: {
      outputs: { prepare: async () => {} },
      apple: {
        availability: async () => ({ available: true }),
        runRunner: async () => ({}),
        startSimulator: async () => {
          throw new Error('unused');
        },
        inspectProcess: async () => 'missing',
        terminateProcess: async () => 'already-missing',
        inspectRunner: async () => 'missing',
        retrieveRunnerRecording: async () => {},
        captureClockAnchor: async () => undefined,
        isRunnerBundleId: async () => false,
      },
      android: {
        resolve: async () => {
          throw new Error('unused');
        },
      },
      harmony: {
        start: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        stop: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        findMedia: async () => undefined,
        stageMedia: async () => false,
        stagedFileSize: async () => undefined,
        pull: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        remove: async () => true,
        removeMedia: async () => true,
      },
      web: { resolve: async () => undefined },
      finalize: { complete: async () => ({}) },
    },
  } as unknown as Omit<
    PlatformRuntimeHost,
    'appleTools' | 'commands' | 'appLogs' | 'networkTransports'
  >;
}
