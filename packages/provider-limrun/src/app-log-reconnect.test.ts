import { expect, test, vi } from 'vitest';

const iosClient = vi.hoisted(() => ({
  appLogTail: vi.fn(async () => 'provider line\n'),
  disconnect: vi.fn(),
}));
const androidClient = vi.hoisted(() => ({
  startAdbTunnel: vi.fn(async () => {
    throw new Error('tunnel failed');
  }),
  disconnect: vi.fn(),
}));

vi.mock('@limrun/api/ios-client', () => ({
  createInstanceClient: vi.fn(async () => iosClient),
}));
vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => androidClient),
}));

import { reconnectLimrunAppLogReader } from './app-log-reconnect.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';

test('reattaches an owned Limrun instance without persisting credentials', async () => {
  const get = vi.fn(async () => ({
    metadata: { labels: { provider: 'limrun', leaseId: 'lease-a' } },
    status: { state: 'ready', apiUrl: 'https://instance', token: 'secret' },
  }));
  const signal = new AbortController().signal;
  const outcome = await reconnectLimrunAppLogReader({
    limrun: {
      iosInstances: {
        get,
      },
    } as never,
    descriptor: {
      transport: 'limrun-log-poller',
      platform: 'ios',
      leaseId: 'lease-a',
      instanceId: 'instance-a',
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
    },
    dependencies: {} as LimrunRuntimeDependencies,
    signal,
  });
  expect(get).toHaveBeenCalledWith('instance-a', { timeout: 5_000, maxRetries: 0, signal });
  expect(outcome.status).toBe('opened');
  if (outcome.status !== 'opened') return;
  expect(await outcome.reader.readLogs('com.example.app', 20)).toBe('provider line\n');
  await outcome.reader[Symbol.asyncDispose]();
  expect(iosClient.disconnect).toHaveBeenCalledOnce();
});

test('fails closed when the instance labels do not match the descriptor lease', async () => {
  const outcome = await reconnectLimrunAppLogReader({
    limrun: {
      iosInstances: {
        get: vi.fn(async () => ({
          metadata: { labels: { provider: 'limrun', leaseId: 'another-lease' } },
          status: { state: 'ready', apiUrl: 'https://instance', token: 'secret' },
        })),
      },
    } as never,
    descriptor: {
      transport: 'limrun-log-poller',
      platform: 'ios',
      leaseId: 'lease-a',
      instanceId: 'instance-a',
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
    },
    dependencies: {} as LimrunRuntimeDependencies,
  });
  expect(outcome).toEqual({ status: 'ownership-lost' });
});

test('disconnects the Android instance client when tunnel acquisition fails', async () => {
  androidClient.disconnect.mockClear();
  await expect(
    reconnectLimrunAppLogReader({
      limrun: {
        androidInstances: {
          get: vi.fn(async () => ({
            metadata: { labels: { provider: 'limrun', leaseId: 'lease-a' } },
            status: {
              state: 'ready',
              apiUrl: 'https://instance',
              adbWebSocketUrl: 'wss://adb',
              token: 'secret',
            },
          })),
        },
      } as never,
      descriptor: {
        transport: 'limrun-log-poller',
        platform: 'android',
        leaseId: 'lease-a',
        instanceId: 'instance-a',
        appBundleId: 'com.example.app',
        outputPath: '/sessions/one/app.log',
      },
      dependencies: {} as LimrunRuntimeDependencies,
    }),
  ).rejects.toThrow('tunnel failed');
  expect(androidClient.disconnect).toHaveBeenCalledOnce();
});
