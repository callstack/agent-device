import { AppError } from '@agent-device/kernel/errors';
import { expect, test, vi } from 'vitest';
import type { DoublespeedApiClient } from './api-client.ts';
import { reconnectDoublespeedAppLogReader } from './app-log-reconnect.ts';
import { readySimulator, scriptedFetch } from './runtime.fixtures.ts';

const descriptor = {
  transport: 'doublespeed-log-poller',
  leaseId: 'lease-a',
  simulatorId: 'sim-a',
  appBundleId: 'com.example.app',
  outputPath: '/sessions/one/app.log',
} as const;

test('reattaches an owned simulator through its session URL', async () => {
  const { fetch } = scriptedFetch([
    () => ({ body: { bundle_id: 'com.example.app', text: 'provider line\n' } }),
  ]);
  vi.stubGlobal('fetch', fetch);
  const getSimulator = vi.fn(async () => readySimulator());
  try {
    const signal = new AbortController().signal;
    const outcome = await reconnectDoublespeedAppLogReader({
      api: { getSimulator } as unknown as DoublespeedApiClient,
      descriptor,
      signal,
    });
    expect(getSimulator).toHaveBeenCalledWith('sim-a', { signal });
    expect(outcome.status).toBe('opened');
    if (outcome.status !== 'opened') return;
    expect(await outcome.reader.readLogs('com.example.app', 20)).toBe('provider line\n');
    await outcome.reader[Symbol.asyncDispose]();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('fails closed when the simulator labels do not match the descriptor lease', async () => {
  const outcome = await reconnectDoublespeedAppLogReader({
    api: {
      getSimulator: async () =>
        readySimulator({ labels: { provider: 'doublespeed', leaseId: 'other' } }),
    } as unknown as DoublespeedApiClient,
    descriptor,
  });
  expect(outcome).toEqual({ status: 'ownership-lost' });
});

test('reports a missing reader for an ended or unknown simulator', async () => {
  const ended = await reconnectDoublespeedAppLogReader({
    api: {
      getSimulator: async () =>
        readySimulator({ ready: false, status: 'cancelled', api_url: null }),
    } as unknown as DoublespeedApiClient,
    descriptor,
  });
  expect(ended).toEqual({ status: 'missing' });
  const unknown = await reconnectDoublespeedAppLogReader({
    api: {
      getSimulator: async () => {
        throw new AppError('COMMAND_FAILED', 'not found', { status: 404 });
      },
    } as unknown as DoublespeedApiClient,
    descriptor,
  });
  expect(unknown).toEqual({ status: 'missing' });
});
