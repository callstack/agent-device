import { expect, test, vi } from 'vitest';
import type { HostCommandRequest } from '@agent-device/contracts/platform-runtime-host';
import type {
  NetworkDumpInput,
  NetworkProviderDumpResult,
  NetworkTransport,
  NetworkTransportScope,
} from '@agent-device/contracts/network-runtime';
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

const providerResult: NetworkProviderDumpResult = {
  backend: 'react-native-app',
  entries: [
    {
      url: 'https://api.example.test/v1/items?page=2',
      method: 'POST',
      status: 201,
      durationMs: 41,
    },
  ],
};

test('in-app capture answers with the full URL and status, and the app log is not read', async () => {
  const runtimeHost = host({
    marker: { status: 'missing' },
    command: () => {
      throw new Error('an in-app capture answer must not run adb');
    },
    logcat: '',
    transport: {
      mode: 'transport-composed',
      dump: async (dumpInput) => {
        expect(dumpInput).toEqual({ maxEntries: 25, include: 'summary' });
        return providerResult;
      },
    },
  });
  const readRecent = vi.fn(runtimeHost.appLogs.readRecent);
  const result = await dumpAndroidNetworkTraffic(
    { ...runtimeHost, appLogs: { ...runtimeHost.appLogs, readRecent } },
    device,
    input({ stateDir: '/state' }),
    new AbortController().signal,
  );

  expect(result).toEqual({ source: 'provider', ...providerResult });
  expect(readRecent).not.toHaveBeenCalled();
});

async function identityOf(scope: NetworkTransportScope | undefined): Promise<string | undefined> {
  return await scope?.resolveMetroDeviceIdentity?.(new AbortController().signal);
}

test('a second attached emulator of the same model takes the identity away from the provider', async () => {
  // Two emulators of one system image report one `ro.product.model`; naming either one could hook
  // and drain the other's runtime, so the platform passes no identity and the dump fails closed.
  const scopes: NetworkTransportScope[] = [];
  const runtimeHost = host({
    marker: { status: 'missing' },
    command: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    logcat: '',
    appLogText: '',
    attached: 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n',
    transport: { mode: 'transport-composed', dump: async () => providerResult },
    scopes,
  });
  await dumpAndroidNetworkTraffic(
    runtimeHost,
    device,
    input({ stateDir: '/state' }),
    new AbortController().signal,
  );
  expect(await identityOf(scopes[0])).toBeUndefined();
});

test('a listed serial whose properties cannot be read takes the identity away from the provider', async () => {
  // An offline or unauthorized serial cannot answer getprop. It is an unknown device that could
  // share the model, so the fail-closed rule withholds the identity for the whole host.
  const scopes: NetworkTransportScope[] = [];
  const runtimeHost = host({
    marker: { status: 'missing' },
    command: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    logcat: '',
    appLogText: '',
    attached: 'List of devices attached\nemulator-5554\tdevice\nZY22\toffline\n',
    getpropFailures: new Set(['ZY22']),
    transport: { mode: 'transport-composed', dump: async () => providerResult },
    scopes,
  });
  await dumpAndroidNetworkTraffic(
    runtimeHost,
    device,
    input({ stateDir: '/state' }),
    new AbortController().signal,
  );
  expect(await identityOf(scopes[0])).toBeUndefined();
});

test('one attached device gives the provider the composed dev-server name as its identity', async () => {
  const scopes: NetworkTransportScope[] = [];
  const runtimeHost = host({
    marker: { status: 'missing' },
    command: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    logcat: '',
    appLogText: '',
    transport: { mode: 'transport-composed', dump: async () => providerResult },
    scopes,
  });
  await dumpAndroidNetworkTraffic(
    runtimeHost,
    device,
    input({ stateDir: '/state' }),
    new AbortController().signal,
  );
  expect(await identityOf(scopes[0])).toBe('sdk_gphone64_arm64 - 15 - API 35');
});

test('the dump that only arms the in-app capture still reports the app log window', async () => {
  const armingNote = 'In-app network capture was installed by this dump.';
  const result = await dumpAndroidNetworkTraffic(
    host({
      marker: { status: 'missing' },
      command: () => {
        throw new Error('an in-app capture answer must not run adb');
      },
      appLogText: '01-01 00:00:00.000 D/App (222): GET https://from-log.example.test status=200',
      logcat: '',
      transport: {
        mode: 'transport-composed',
        dump: async () => ({
          backend: 'react-native-app',
          entries: [],
          armed: true,
          notes: [armingNote],
        }),
      },
    }),
    device,
    input({ appLogSnapshot: { state: 'active', startedAt: 1 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.dump.entries).toEqual([
    expect.objectContaining({ url: 'https://from-log.example.test' }),
  ]);
  expect(result.notes).toContain(armingNote);
});

test('an armed provider over an inactive log stream keeps the lifecycle guidance beside the arming note', async () => {
  const result = await dumpAndroidNetworkTraffic(
    host({
      marker: { status: 'missing' },
      command: () => {
        throw new Error('an in-app capture answer must not run adb');
      },
      appLogText: '',
      logcat: '',
      transport: {
        mode: 'transport-composed',
        dump: async () => ({
          backend: 'react-native-app',
          entries: [],
          armed: true,
          notes: ['In-app network capture was installed by this dump.'],
        }),
      },
    }),
    device,
    input({ appLogSnapshot: { state: 'ended', startedAt: 1 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  const inactiveIndex = result.notes!.findIndex((note) => note.includes('inactive'));
  const armingIndex = result.notes!.findIndex((note) => note.includes('installed by this dump'));
  expect(inactiveIndex).toBeGreaterThanOrEqual(0);
  expect(armingIndex).toBeGreaterThanOrEqual(0);
  expect(inactiveIndex).toBeLessThan(armingIndex);
});

test('an in-app capture that cannot answer falls back to the app log with its reason', async () => {
  const result = await dumpAndroidNetworkTraffic(
    host({
      marker: { status: 'missing' },
      command: () => {
        throw new Error('an in-app capture answer must not run adb');
      },
      appLogText: '01-01 00:00:00.000 D/App (222): GET https://from-log.example.test status=200',
      logcat: '',
      transport: {
        mode: 'transport-composed',
        dump: async () => {
          throw new Error('No React Native runtime is connected to the dev server.');
        },
      },
    }),
    device,
    input({ appLogSnapshot: { state: 'active', startedAt: 1 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.dump.entries).toHaveLength(1);
  expect(result.notes[0]).toContain('In-app network capture could not answer');
});

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
  transport?: NetworkTransport;
  attached?: string;
  getpropFailures?: ReadonlySet<string>;
  scopes?: NetworkTransportScope[];
}): PlatformRuntimeHost {
  return {
    ...unusedAppLogHost(),
    commands: {
      which: async () => undefined,
      run: async (request) => {
        // The identity probe answers only when a test resolves the scope's identity; the harness
        // answers it as a host with exactly these listed devices under one unique name.
        if (request.args.includes('devices')) {
          return {
            stdout: options.attached ?? 'List of devices attached\nemulator-5554\tdevice\n',
            stderr: '',
            exitCode: 0,
          };
        }
        if (request.args.some((arg) => arg.includes('getprop ro.product.model'))) {
          const serial = request.args[request.args.indexOf('-s') + 1];
          if (serial !== undefined && options.getpropFailures?.has(serial)) {
            return { stdout: '', stderr: 'device offline', exitCode: 1 };
          }
          return {
            stdout: 'sdk_gphone64_arm64\n15\n35\n',
            stderr: '',
            exitCode: 0,
          };
        }
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
    networkTransports: {
      resolve: async (_device, scope) => {
        options.scopes?.push(scope!);
        return options.transport ?? { mode: 'local' };
      },
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
    clock: { now: () => 1, sleep: async () => {} },
    deviceReadiness: {
      applePhysical: { ensureConnected: async () => {} },
      appleAutomation: {
        keepHot: () => {},
        markBooted: () => {},
        wasRecentlyObservedBooted: async () => false,
      },
      androidEmulator: {
        discover: async () => [],
        launch: async () => 1,
        terminate: async () => {},
      },
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
