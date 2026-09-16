import { expect, test, vi } from 'vitest';
import {
  androidAdbHostTarget,
  androidAdbInvocation,
  serializeAndroidAdbInvocation,
  type AndroidAdbInvocation,
} from '@agent-device/platform-android/mechanics';
import { cleanupLimrunAndroidAdbTunnel, type LimrunAndroidSession } from './android.ts';
import type { LimrunAdbCommandOptions, LimrunAdbProvider } from './runtime-dependencies.ts';

const ok = { exitCode: 0, stdout: '', stderr: '' };

test('cleanup asks the platform to address the disconnect as a server-level command and hands it over unchanged', async () => {
  const calls: Array<{ argv: string[]; options: LimrunAdbCommandOptions | undefined }> = [];
  const close = vi.fn();
  const provider: LimrunAdbProvider = { exec: async () => ok };
  const hostAdbInvocation = vi.fn((command: readonly string[]) =>
    androidAdbInvocation(androidAdbHostTarget(), command),
  );
  const session = {
    platform: 'android',
    adbProvider: provider,
    adbSerial: '127.0.0.1:62001',
    adbTunnel: { close },
    adbTunnelPromise: Promise.resolve(),
    dependencies: {
      android: { hostAdbInvocation },
      host: {
        runAdb: async (invocation: AndroidAdbInvocation, options?: LimrunAdbCommandOptions) => {
          calls.push({ argv: serializeAndroidAdbInvocation(invocation), options });
          return ok;
        },
      },
    },
  } as unknown as LimrunAndroidSession;

  await cleanupLimrunAndroidAdbTunnel(session);

  expect(hostAdbInvocation).toHaveBeenCalledWith(['disconnect', '127.0.0.1:62001']);
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
