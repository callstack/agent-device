import { expect, test, vi } from 'vitest';

const iosClient = vi.hoisted(() => ({
  appLogTail: vi.fn(async () => 'provider line\n'),
  disconnect: vi.fn(),
}));
type FakeAndroidTunnel = {
  address: { address: string; port: number };
  close: () => void;
};

const androidClient = vi.hoisted(() => ({
  startAdbTunnel: vi.fn(async (): Promise<FakeAndroidTunnel> => {
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

import {
  androidAdbHostTarget,
  androidAdbInvocation,
  androidAdbSerialTarget,
  serializeAndroidAdbInvocation,
  type AndroidAdbInvocation,
} from '@agent-device/platform-android/mechanics';
import { reconnectLimrunAppLogReader } from './app-log-reconnect.ts';
import type {
  LimrunAdbCommandOptions,
  LimrunAdbExecutor,
  LimrunRuntimeDependencies,
} from './runtime-dependencies.ts';

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

test('addresses app-log adb traffic at the tunnel serial and hands cleanup a command that selects no device', async () => {
  const calls: Array<{
    selector: AndroidAdbInvocation['target']['selector'];
    command: string[];
    argv: string[];
    options: LimrunAdbCommandOptions | undefined;
  }> = [];
  const closeTunnel = vi.fn();
  androidClient.startAdbTunnel.mockImplementationOnce(async () => ({
    address: { address: '127.0.0.1', port: 62_001 },
    close: closeTunnel,
  }));
  androidClient.disconnect.mockClear();
  const outcome = await reconnectLimrunAppLogReader({
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
    dependencies: {
      host: {
        runAdb: async (
          invocation: AndroidAdbInvocation,
          options?: LimrunAdbCommandOptions,
        ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
          calls.push({
            selector: invocation.target.selector,
            command: [...invocation.command],
            argv: serializeAndroidAdbInvocation(invocation),
            options,
          });
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      android: {
        deviceAdbInvocation: (serial: string, command: readonly string[]) =>
          androidAdbInvocation(androidAdbSerialTarget(serial), command),
        hostAdbInvocation: (command: readonly string[]) =>
          androidAdbInvocation(androidAdbHostTarget(), command),
        readLogs: async (adb: LimrunAdbExecutor) => {
          await adb(['shell', 'logcat', '-d', '-T', '20']);
          return 'line\n';
        },
      },
    } as unknown as LimrunRuntimeDependencies,
  });
  expect(outcome.status).toBe('opened');
  if (outcome.status !== 'opened') return;

  await outcome.reader.readLogs('com.example.app', 20);
  // The tunnel serial is addressing, so the command the reader wrote travels unchanged: no `-s`
  // is stitched back into the payload the provider hands over.
  expect(calls[0]).toEqual({
    selector: { kind: 'serial', serial: '127.0.0.1:62001' },
    command: ['shell', 'logcat', '-d', '-T', '20'],
    argv: ['-s', '127.0.0.1:62001', 'shell', 'logcat', '-d', '-T', '20'],
    options: undefined,
  });

  await outcome.reader[Symbol.asyncDispose]();
  // Ending the tunnel's adb connection is a server-level command, so it addresses no device and
  // names the serial where adb expects it: in the command.
  expect(calls[1]).toEqual({
    selector: { kind: 'unspecified' },
    command: ['disconnect', '127.0.0.1:62001'],
    argv: ['disconnect', '127.0.0.1:62001'],
    options: { allowFailure: true, timeoutMs: 10_000 },
  });
  expect(closeTunnel).toHaveBeenCalledOnce();
  expect(androidClient.disconnect).toHaveBeenCalledOnce();
});
