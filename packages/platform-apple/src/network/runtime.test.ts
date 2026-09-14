import { expect, test, vi } from 'vitest';
import type { NetworkDumpInput } from '@agent-device/contracts/network-runtime';
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
}): PlatformRuntimeHost {
  return {
    ...unusedAppLogHost(),
    commands: {
      which: async () => undefined,
      run: async () => {
        throw new Error('generic command runner must not own Apple network recovery');
      },
    },
    appleTools: { isXcrunAvailable: async () => true, run: options.runSimctl },
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/one/app.log',
        exists: options.text !== undefined,
        text: options.text ?? '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => ({ status: 'missing' }),
    },
    networkTransports: { resolve: async () => ({ mode: 'local' }) },
  };
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
