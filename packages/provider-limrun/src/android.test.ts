import { expect, test, vi } from 'vitest';
import {
  serializeAndroidAdbInvocation,
  type AndroidAdbInvocation,
} from '@agent-device/platform-android/mechanics';
import {
  cleanupLimrunAndroidAdbTunnel,
  limrunDeviceAdbInvocation,
  limrunHostAdbInvocation,
  type LimrunAndroidSession,
} from './android.ts';
import type { LimrunAdbCommandOptions, LimrunAdbProvider } from './runtime-dependencies.ts';

const ok = { exitCode: 0, stdout: '', stderr: '' };

test('carries the tunnel serial on the invocation target and never in the command', () => {
  const device = limrunDeviceAdbInvocation('127.0.0.1:62001', ['shell', 'pm', 'list', 'packages']);
  expect(device.target).toEqual({
    selector: { kind: 'serial', serial: '127.0.0.1:62001' },
    server: { kind: 'ambient' },
  });
  expect(device.command).toEqual(['shell', 'pm', 'list', 'packages']);
  expect(device.rawArgv).toBeUndefined();
  expect(serializeAndroidAdbInvocation(device)).toEqual([
    '-s',
    '127.0.0.1:62001',
    'shell',
    'pm',
    'list',
    'packages',
  ]);
});

test('addresses a server-level command to no device', () => {
  const host = limrunHostAdbInvocation(['disconnect', '127.0.0.1:62001']);
  expect(host.target.selector).toEqual({ kind: 'unspecified' });
  expect(serializeAndroidAdbInvocation(host)).toEqual(['disconnect', '127.0.0.1:62001']);
});

test('cleanup disconnects the tunnel serial as a server-level command and drops it', async () => {
  const calls: Array<{ argv: string[]; options: LimrunAdbCommandOptions | undefined }> = [];
  const close = vi.fn();
  const provider: LimrunAdbProvider = { exec: async () => ok };
  const session = {
    platform: 'android',
    adbProvider: provider,
    adbSerial: '127.0.0.1:62001',
    adbTunnel: { close },
    adbTunnelPromise: Promise.resolve(),
    dependencies: {
      host: {
        runAdb: async (invocation: AndroidAdbInvocation, options?: LimrunAdbCommandOptions) => {
          calls.push({ argv: serializeAndroidAdbInvocation(invocation), options });
          return ok;
        },
      },
    },
  } as unknown as LimrunAndroidSession;

  await cleanupLimrunAndroidAdbTunnel(session);

  expect(calls).toEqual([
    {
      argv: ['disconnect', '127.0.0.1:62001'],
      options: { allowFailure: true, timeoutMs: 10_000 },
    },
  ]);
  expect(close).toHaveBeenCalledOnce();
  expect(session.adbSerial).toBeUndefined();
  expect(session.adbTunnel).toBeUndefined();
  expect(session.adbTunnelPromise).toBeUndefined();
});
