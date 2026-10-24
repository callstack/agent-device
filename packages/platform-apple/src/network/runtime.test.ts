import { expect, test, vi } from 'vitest';
import type {
  NetworkDumpInput,
  NetworkProviderDumpResult,
  NetworkTransport,
  NetworkTransportScope,
} from '@agent-device/contracts/network-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { dumpAppleNetworkTraffic } from './runtime.ts';

const simulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone',
  kind: 'simulator',
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
  const readRecent = vi.fn(async () => {
    throw new Error('the app log must not be read once the provider answered');
  });
  const runtimeHost = host({ runSimctl: vi.fn() });
  const result = await dumpAppleNetworkTraffic(
    {
      ...runtimeHost,
      appLogs: { ...runtimeHost.appLogs, readRecent },
      networkTransports: {
        resolve: async (_device, scope) => {
          expect(scope).toMatchObject({
            sessionId: 'one',
            appBundleId: 'com.example.app',
            maxPayloadChars: 2048,
          });
          return {
            mode: 'transport-composed',
            dump: async () => providerResult,
          };
        },
      },
    },
    simulator,
    input({ stateDir: '/state' }),
    new AbortController().signal,
  );

  expect(result).toEqual({ source: 'provider', ...providerResult });
  expect(readRecent).not.toHaveBeenCalled();
});

test('the dump that only arms the in-app capture still reports the app log window', async () => {
  const armingNote = 'In-app network capture was installed by this dump.';
  const result = await dumpAppleNetworkTraffic(
    host({
      text: '2026-08-10T10:00:00Z GET https://from-log.example.test status=200\n',
      runSimctl: vi.fn(),
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
    simulator,
    input({ appLogSnapshot: { state: 'active', startedAt: 1_000 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.dump.entries).toEqual([
    expect.objectContaining({ url: 'https://from-log.example.test' }),
  ]);
  expect(result.notes).toContain(armingNote);
});

test('an armed provider over an inactive log stream keeps the lifecycle guidance beside the arming note', async () => {
  const result = await dumpAppleNetworkTraffic(
    host({
      text: '',
      runSimctl: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
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
    simulator,
    input({ appLogSnapshot: { state: 'ended', startedAt: 1_000 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.notes).toContainEqual(
    expect.stringContaining('Session app log stream is inactive'),
  );
  expect(result.notes).toContainEqual(
    expect.stringContaining('In-app network capture was installed by this dump'),
  );
  expect(
    result.notes!.indexOf(result.notes!.find((note) => note.includes('inactive'))!),
  ).toBeLessThan(
    result.notes!.indexOf(result.notes!.find((note) => note.includes('installed by this dump'))!),
  );
});

test('an in-app capture that cannot answer falls back to the app log with its reason', async () => {
  const result = await dumpAppleNetworkTraffic(
    host({
      text: '2026-08-10T10:00:00Z GET https://from-log.example.test status=200\n',
      runSimctl: vi.fn(),
      transport: {
        mode: 'transport-composed',
        dump: async () => {
          throw new Error('No React Native runtime is connected to the dev server.');
        },
      },
    }),
    simulator,
    input({ appLogSnapshot: { state: 'active', startedAt: 1_000 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.dump.entries).toHaveLength(1);
  expect(result.notes[0]).toContain('In-app network capture could not answer');
});

test('recovers an empty iOS simulator dump from bounded simctl log history', async () => {
  const runSimctl = vi.fn(async () => ({
    stdout: [
      'Timestamp               Ty Process[PID:TID]',
      '2026-08-10T10:00:00Z GET https://recovered.example.test status=200',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  }));
  const result = await dumpAppleNetworkTraffic(
    host({ runSimctl }),
    simulator,
    input({ appLogSnapshot: { state: 'active', startedAt: 1_000 } }),
    new AbortController().signal,
  );

  expect(result).toMatchObject({
    source: 'app-log',
    backend: 'ios-simulator',
    dump: { entries: [{ url: 'https://recovered.example.test' }] },
  });
  expect(result.source).toBe('app-log');
  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.notes[0]).toContain('Recovered 1 iOS simulator HTTP entry');
  expect(runSimctl).toHaveBeenCalledWith(
    expect.objectContaining({
      tool: 'simctl',
      args: expect.arrayContaining(['spawn', 'sim-1', '--start', '@1']),
      timeoutMs: 4_000,
    }),
    expect.any(AbortSignal),
  );
});

test.each([
  ['a session start', { state: 'active', startedAt: 1_000 } as const, ['--start', '@1']],
  ['no session start', undefined, ['--last', '5m']],
])(
  'scopes the whole log-show argv of a scoped-set simulator after %s',
  async (_label, snapshot, window) => {
    const runSimctl = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await dumpAppleNetworkTraffic(
      host({ runSimctl }),
      { ...simulator, simulatorSetPath: '/tmp/scoped-set' },
      input(snapshot ? { appLogSnapshot: snapshot } : {}),
      new AbortController().signal,
    );

    expect(runSimctl).toHaveBeenCalledWith(
      {
        tool: 'simctl',
        args: [
          '--set',
          '/tmp/scoped-set',
          'spawn',
          'sim-1',
          'log',
          'show',
          '--style',
          'compact',
          '--info',
          '--predicate',
          expect.any(String),
          ...window,
        ],
        allowFailure: true,
        timeoutMs: 4_000,
      },
      expect.any(AbortSignal),
    );
  },
);

test('preserves the simulator no-HTTP explanation after recovery returns app lines', async () => {
  const result = await dumpAppleNetworkTraffic(
    host({
      runSimctl: async () => ({
        stdout: '2026-08-10T10:00:00Z application diagnostic only\n',
        stderr: '',
        exitCode: 0,
      }),
    }),
    simulator,
    input({ appLogSnapshot: { state: 'ended', startedAt: 1_000 } }),
    new AbortController().signal,
  );

  expect(result.source).toBe('app-log');
  expect(result.notes).toEqual([
    expect.stringContaining('none looked like HTTP traffic'),
    expect.stringContaining('No HTTP(s) entries were found in recent iOS simulator app logs'),
  ]);
});

test('parses macOS session app-log traffic without loading simulator recovery', async () => {
  const runSimctl = vi.fn();
  const result = await dumpAppleNetworkTraffic(
    host({
      runSimctl,
      text: '2026-08-10T10:00:00Z GET https://mac.example.test status=204\n',
    }),
    { ...simulator, appleOs: 'macos', kind: 'device', target: 'desktop' },
    input(),
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    source: 'app-log',
    backend: 'macos',
    dump: { entries: [{ url: 'https://mac.example.test', status: 204 }] },
  });
  expect(runSimctl).not.toHaveBeenCalled();
});

function input(overrides: Partial<NetworkDumpInput> = {}): NetworkDumpInput {
  return {
    sessionId: 'one',
    appBundleId: 'com.example.app',
    maxEntries: 25,
    include: 'summary' as const,
    maxPayloadChars: 2048,
    maxScanLines: 4000,
    ...overrides,
  };
}

function host(options: {
  text?: string;
  runSimctl: PlatformRuntimeHost['appleTools']['run'];
  transport?: NetworkTransport;
  /** Extra booted names in the session device's own set, besides the device itself. */
  bootedNames?: readonly string[];
  /** Booted names the OTHER reachable set reports (the default set for a tenant-set device). */
  otherSetBootedNames?: readonly string[];
  /** The session device lives in a tenant simulator set, not the default set. */
  tenantDevice?: boolean;
  /** devicectl answers with these connected physical device names; the default is a bare host. */
  physicalNames?: readonly string[];
  devicectlFails?: boolean;
  env?: Record<string, string>;
  scopes?: NetworkTransportScope[];
}): PlatformRuntimeHost {
  // The identity probe answers only when a test resolves the scope's identity. The harness answers
  // it as a default-set host with one simulator named after the session device, unless a test
  // names more booted devices, another set's booted devices, or physical devices.
  const runSimctl: PlatformRuntimeHost['appleTools']['run'] = async (request, signal) => {
    if (request.tool === 'devicectl') {
      if (options.devicectlFails) {
        return { stdout: '', stderr: 'devicectl failed', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (request.args.includes('booted')) {
      const own = [
        { udid: 'sim-1', name: 'iPhone', state: 'Booted' as const },
        ...(options.bootedNames ?? []).map((name, index) => ({
          udid: `other-${index}`,
          name,
          state: 'Booted' as const,
        })),
      ];
      const other = (options.otherSetBootedNames ?? []).map((name, index) => ({
        udid: `tenant-${index}`,
        name,
        state: 'Booted' as const,
      }));
      const scopedRequest = request.args.includes('--set');
      const devices = options.tenantDevice
        ? scopedRequest
          ? own
          : other
        : scopedRequest
          ? other
          : own;
      return {
        stdout: JSON.stringify({
          devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': devices },
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    return options.runSimctl(request, signal);
  };
  const physicalNames = options.physicalNames ?? [];
  return {
    ...unusedAppLogHost(),
    hostEnvironment: { env: options.env ?? {}, cwd: '/' },
    temporaryFiles: {
      create: async () => ({
        path: '/tmp/devicectl.json',
        readText: async () =>
          JSON.stringify({
            result: {
              devices: [
                // CoreDevice registers the booted session simulator itself as a connected device.
                {
                  name: 'iPhone',
                  hardwareProperties: { platform: 'iOS', udid: 'sim-1', reality: 'simulated' },
                  deviceProperties: { name: 'iPhone' },
                  connectionProperties: { tunnelState: 'connected' },
                },
                ...physicalNames.map((name) => ({
                  name,
                  hardwareProperties: { platform: 'iOS', udid: `phys-${name}` },
                  connectionProperties: { tunnelState: 'connected' },
                })),
              ],
            },
          }),
        writeText: async () => {},
        [Symbol.asyncDispose]: async () => {},
      }),
    },
    commands: {
      which: async () => undefined,
      run: async () => {
        throw new Error('generic command runner must not own Apple network recovery');
      },
    },
    appleTools: { isXcrunAvailable: async () => true, run: runSimctl },
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/one/app.log',
        exists: options.text !== undefined,
        text: options.text ?? '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => ({ status: 'missing' }),
    },
    networkTransports: {
      resolve: async (_device, scope) => {
        options.scopes?.push(scope!);
        return options.transport ?? { mode: 'local' };
      },
    },
  };
}

async function identityOf(scope: NetworkTransportScope | undefined): Promise<string | undefined> {
  return await scope?.resolveMetroDeviceIdentity?.(new AbortController().signal);
}

test('a simulator whose display name another booted simulator shares gets no identity', async () => {
  const scopes: NetworkTransportScope[] = [];
  await dumpAppleNetworkTraffic(
    host({
      text: '',
      runSimctl: vi.fn(),
      transport: { mode: 'transport-composed', dump: async () => providerResult },
      bootedNames: ['iPhone'],
      scopes,
    }),
    simulator,
    input({ stateDir: '/state' }),
    new AbortController().signal,
  );
  expect(await identityOf(scopes[0])).toBeUndefined();
});

test('a same-named booted simulator in another reachable set takes the identity away', async () => {
  // The session device lives in a tenant set; the default set on the same host boots a
  // same-named simulator that could attach to the same dev server, so the name is no identity.
  const scopes: NetworkTransportScope[] = [];
  await dumpAppleNetworkTraffic(
    host({
      text: '',
      runSimctl: vi.fn(),
      transport: { mode: 'transport-composed', dump: async () => providerResult },
      tenantDevice: true,
      otherSetBootedNames: ['iPhone'],
      scopes,
    }),
    { ...simulator, simulatorSetPath: '/tenant/set' },
    input({ stateDir: '/state' }),
    new AbortController().signal,
  );
  expect(await identityOf(scopes[0])).toBeUndefined();
});

test('a connected physical device with the same name takes the identity away', async () => {
  const scopes: NetworkTransportScope[] = [];
  await dumpAppleNetworkTraffic(
    host({
      text: '',
      runSimctl: vi.fn(),
      transport: { mode: 'transport-composed', dump: async () => providerResult },
      physicalNames: ['iPhone'],
      scopes,
    }),
    simulator,
    input({ stateDir: '/state' }),
    new AbortController().signal,
  );
  expect(await identityOf(scopes[0])).toBeUndefined();
});

test('a host whose physical devices cannot be listed gets no identity', async () => {
  // Unknown physical devices fail the identity closed: one of them could report this name.
  const scopes: NetworkTransportScope[] = [];
  await dumpAppleNetworkTraffic(
    host({
      text: '',
      runSimctl: vi.fn(),
      transport: { mode: 'transport-composed', dump: async () => providerResult },
      devicectlFails: true,
      scopes,
    }),
    simulator,
    input({ stateDir: '/state' }),
    new AbortController().signal,
  );
  expect(await identityOf(scopes[0])).toBeUndefined();
});

test('a host configured for a set this device does not belong to gets no identity', async () => {
  // The daemon operator scoped the host to one set; this device lives elsewhere, so the host
  // cannot state which sets are reachable and the identity fails closed.
  const scopes: NetworkTransportScope[] = [];
  await dumpAppleNetworkTraffic(
    host({
      text: '',
      runSimctl: vi.fn(),
      transport: { mode: 'transport-composed', dump: async () => providerResult },
      env: { AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET: '/operator/set' },
      scopes,
    }),
    simulator,
    input({ stateDir: '/state' }),
    new AbortController().signal,
  );
  expect(await identityOf(scopes[0])).toBeUndefined();
});

test('one booted simulator gives the provider its display name as the identity', async () => {
  const scopes: NetworkTransportScope[] = [];
  await dumpAppleNetworkTraffic(
    host({
      text: '',
      runSimctl: vi.fn(),
      transport: { mode: 'transport-composed', dump: async () => providerResult },
      scopes,
    }),
    simulator,
    input({ stateDir: '/state' }),
    new AbortController().signal,
  );
  expect(await identityOf(scopes[0])).toBe('iPhone');
});

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

// Real iOS simulator lines: `/init` reused the connection `/v4/messages/en_US`
// opened, and CFNetwork logged no URL for it.
const CONNECTION_START =
  '2026-09-09 18:22:27.805 Df app[1:2] [com.apple.network:connection] [C9 EA66F890 Hostname#c6f77afc:3040 tcp, url: http://localhost:3040/v4/messages/en_US, definite] start';
const REUSED_SUMMARY =
  '2026-09-09 18:22:28.167 Df app[1:2] [com.apple.CFNetwork:Summary] Task <2FAEF670>.<2> summary for task success {transaction_duration_ms=1, response_status=200, connection=9, reused=1, request_bytes=236, response_bytes=624}';

test('a keep-alive request reported against its origin does not silence lifecycle guidance', async () => {
  const result = await dumpAppleNetworkTraffic(
    host({
      text: `${[CONNECTION_START, REUSED_SUMMARY].join('\n')}\n`,
      runSimctl: vi.fn(),
    }),
    simulator,
    input({ appLogSnapshot: { state: 'ended', startedAt: 1_000 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.notes).toEqual([
    expect.stringContaining('Session app log stream is inactive'),
    expect.stringContaining('reused a keep-alive connection'),
  ]);
  expect(result.notes[1]).toContain('1 listed against the origin');
});

test('a keep-alive request whose connection predates the window keeps the dump from reading empty', async () => {
  const result = await dumpAppleNetworkTraffic(
    host({
      text: `${REUSED_SUMMARY}\n`,
      runSimctl: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 })),
    }),
    simulator,
    input({ appLogSnapshot: { state: 'active', startedAt: 1_000 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.dump.entries).toEqual([]);
  expect(result.dump.unnamedRequests).toBe(1);
  expect(result.notes).toEqual([
    expect.stringContaining('1 opened before this scan window'),
    expect.stringContaining('No HTTP(s) entries were found'),
  ]);
  expect(result.notes[0]).toContain('does not prove it was not called');
});

test('simulator recovery keeps traffic it saw but could not name', async () => {
  const runSimctl = vi.fn(async () => ({
    stdout: ['Timestamp               Ty Process[PID:TID]', REUSED_SUMMARY].join('\n'),
    stderr: '',
    exitCode: 0,
  }));
  const result = await dumpAppleNetworkTraffic(
    host({ text: '', runSimctl }),
    simulator,
    input({ appLogSnapshot: { state: 'active', startedAt: 1_000 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.dump.entries).toEqual([]);
  expect(result.dump.unnamedRequests).toBe(1);
  expect(result.notes).toEqual([
    expect.stringContaining('1 opened before this scan window'),
    expect.stringContaining('No HTTP(s) entries were found'),
  ]);
  expect(result.notes.join(' ')).not.toContain('none looked like HTTP traffic');
});

test('recovery-only traffic that cannot be named is still reported, not called empty', async () => {
  const runSimctl = vi.fn(async () => ({
    stdout: ['Timestamp               Ty Process[PID:TID]', REUSED_SUMMARY].join('\n'),
    stderr: '',
    exitCode: 0,
  }));
  const result = await dumpAppleNetworkTraffic(
    host({ text: '', runSimctl }),
    simulator,
    input({ appLogSnapshot: { state: 'active', startedAt: 1_000 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.dump.unnamedRequests).toBe(1);
  expect(result.notes).toEqual([
    expect.stringContaining('1 opened before this scan window'),
    expect.stringContaining('No HTTP(s) entries were found'),
  ]);
  expect(result.notes.join(' ')).not.toContain('none looked like HTTP traffic');
});

test('a response bounded to one entry still reports every unnamed request, without their ids', async () => {
  // Five reused tasks, none resolvable: far more than the requested entry limit.
  const summaries = Array.from({ length: 5 }, (_, index) =>
    REUSED_SUMMARY.replace('Task <2FAEF670>.<2>', `Task <2FAEF670>.<${index + 10}>`),
  );
  const result = await dumpAppleNetworkTraffic(
    host({
      text: `${summaries.join('\n')}\n`,
      runSimctl: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 })),
    }),
    simulator,
    input({ maxEntries: 1, appLogSnapshot: { state: 'active', startedAt: 1_000 } }),
    new AbortController().signal,
  );

  if (result.source !== 'app-log') throw new Error('expected app-log result');
  expect(result.dump.entries).toEqual([]);
  expect(result.dump.unnamedRequests).toBe(5);
  // The identities are a reconciliation detail and must not reach the response,
  // where their number is bounded by the scan window rather than by maxEntries.
  expect(result.dump).not.toHaveProperty('unnamedRequestIds');
  expect(result.notes[0]).toContain('5 requests reused a keep-alive connection');
});
