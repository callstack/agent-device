import { normalizeError } from '@agent-device/kernel/errors';
import { parseApplePlist } from '@agent-device/platform-apple/plist';
import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { createLimrunIosAppLogReader } from './ios-app-logs.ts';

afterEach(() => vi.unstubAllGlobals());

test('scrubs retained, live console, and buffered unified app logs', async () => {
  const token = 'syntheticInstanceCredential';
  const consoleStream = Object.assign(new EventEmitter(), { stop() {} });
  const systemStream = Object.assign(new EventEmitter(), { stop() {} });
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
  const reader = createLimrunIosAppLogReader(
    {
      apiUrl: 'https://instance.invalid/api',
      token,
      client: {
        appLogTail: async () => 'retained ' + token,
        streamAppLog: () => consoleStream,
        streamSyslog: () => systemStream,
      },
    } as unknown as Parameters<typeof createLimrunIosAppLogReader>[0],
    async () => () => ({}),
  );
  const signal = new AbortController().signal;
  const app = 'com.example.app';
  const unified = '2026-11-22 12:00:00.000 Info process[123] (' + app + ') ';
  try {
    const retained = await reader.readLogs(app, 20, signal);
    consoleStream.emit('line', 'console ' + token);
    systemStream.emit('line', unified + token);
    await vi.waitFor(async () => {
      expect(await reader.readLogs(app, 20, signal)).toBe(
        ['retained [REDACTED]', 'console [REDACTED]', unified + '[REDACTED]'].join('\n'),
      );
    });
    expect(retained).toBe('retained [REDACTED]');
  } finally {
    await reader[Symbol.asyncDispose]();
  }
});

test('an unsupported Info.plist read for log metadata surfaces as COMMAND_FAILED with its reason', async () => {
  const stream = () => Object.assign(new EventEmitter(), { stop() {} });
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>A</key><openstep/></dict></plist>',
        { status: 200 },
      ),
  );
  const reader = createLimrunIosAppLogReader(
    {
      apiUrl: 'https://instance.invalid/api',
      token: 'syntheticInstanceCredential',
      client: { appLogTail: async () => '', streamAppLog: stream, streamSyslog: stream },
    } as unknown as Parameters<typeof createLimrunIosAppLogReader>[0],
    async () => parseApplePlist,
  );
  const signal = new AbortController().signal;
  try {
    let error: unknown;
    await vi.waitFor(async () => {
      error = await reader.readLogs('com.example.app', 20, signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBeDefined();
    });
    expect(normalizeError(error)).toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'apple_plist_unsupported_type' },
    });
  } finally {
    await reader[Symbol.asyncDispose]();
  }
});

test('plaintext iOS log attachments keep console and bundle-ID system logs', async () => {
  const consoleStream = Object.assign(new EventEmitter(), { stop: vi.fn() });
  const systemStream = Object.assign(new EventEmitter(), { stop: vi.fn() });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const reader = createLimrunIosAppLogReader(
    {
      apiUrl: 'http://127.0.0.1:8080/api',
      token: 'syntheticInstanceCredential',
      client: {
        appLogTail: async () => 'retained console',
        streamAppLog: () => consoleStream,
        streamSyslog: () => systemStream,
      },
    } as unknown as Parameters<typeof createLimrunIosAppLogReader>[0],
    async () => () => ({}),
  );
  const signal = new AbortController().signal;
  const app = 'com.example.app';
  const matching = '2026-11-22 12:00:00.000 Info Example[123] (com.example.app) matching';
  try {
    expect(await reader.readLogs(app, 20, signal)).toBe('retained console');
    consoleStream.emit('line', 'live console');
    systemStream.emit('line', matching);
    systemStream.emit(
      'line',
      '2026-11-22 12:00:00.000 Info Other[124] (com.example.other) excluded',
    );
    await vi.waitFor(async () => {
      expect(await reader.readLogs(app, 20, signal)).toBe(
        `retained console\nlive console\n${matching}`,
      );
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(consoleStream.stop).not.toHaveBeenCalled();
    expect(systemStream.stop).not.toHaveBeenCalled();
  } finally {
    await reader[Symbol.asyncDispose]();
  }
});
