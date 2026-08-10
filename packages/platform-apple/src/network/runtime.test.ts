import { expect, test, vi } from 'vitest';
import type { NetworkDumpInput, PlatformRuntimeHost } from '@agent-device/contracts/platform';
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
  };
}
