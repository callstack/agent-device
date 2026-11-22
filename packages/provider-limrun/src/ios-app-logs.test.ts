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
