import type { AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';
import { describe, expect, test, vi } from 'vitest';
import { startLimrunAppLogPoller, type LimrunAppLogReader } from './app-log-poller.ts';

function reader(
  platform: LimrunAppLogReader['platform'],
  overrides: Partial<LimrunAppLogReader> = {},
): LimrunAppLogReader {
  return {
    platform,
    leaseId: 'lease-1',
    instanceId: 'instance-1',
    readLogs: async () => 'one line\n',
    [Symbol.asyncDispose]: async () => {},
    ...overrides,
  };
}

describe('Limrun app-log poller', () => {
  test.each([
    ['ios', 'ios-simulator'],
    ['android', 'android'],
  ] as const)(
    'derives the %s backend identity independently of the shared poller',
    async (platform, backend) => {
      const sleeps = deferredSleeps();
      const writes: string[] = [];
      const handle = await startLimrunAppLogPoller({
        host: pollerHost({ existingTail: '', writes, sleeps }),
        reader: reader(platform),
        appBundleId: 'com.example.app',
        outputPath: '/sessions/one/app.log',
      });
      await vi.waitFor(() => expect(writes).toEqual(['one line\n']));
      expect(handle.inspect().backend).toBe(backend);
      const finishing = handle.finish();
      sleeps.resolveNext(1_000);
      await expect(finishing).resolves.toMatchObject({
        status: 'completed',
        result: { backend },
      });
    },
  );

  test('keeps the Limrun cleanup wording when disposal fails', async () => {
    const sleeps = deferredSleeps();
    const handle = await startLimrunAppLogPoller({
      host: pollerHost({ existingTail: '', writes: [], sleeps }),
      reader: reader('ios', {
        [Symbol.asyncDispose]: async () => {
          throw new Error('reader cleanup failed');
        },
      }),
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
    });
    await vi.waitFor(() => expect(sleeps.hasPending(1_000)).toBe(true));
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await expect(finishing).resolves.toMatchObject({
      status: 'cleanup-pending',
      message: 'Limrun app-log cleanup did not settle every owned resource',
    });
  });

  test('settles an uncancelable read whose reader ignores the poller signal', async () => {
    const sleeps = deferredSleeps();
    let readerDisposed = false;
    const readLogs = vi.fn(async (_appBundleId: string, _lineLimit: number) => {
      return await new Promise<string>(() => {});
    });
    const handle = await startLimrunAppLogPoller({
      host: pollerHost({ existingTail: '', writes: [], sleeps }),
      reader: reader('android', {
        readLogs,
        [Symbol.asyncDispose]: async () => {
          readerDisposed = true;
        },
      }),
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
    });
    await vi.waitFor(() => expect(sleeps.hasPending(5_000)).toBe(true));
    sleeps.resolveNext(5_000);
    await vi.waitFor(() => expect(handle.inspect().state).toBe('failed'));
    expect(readLogs).toHaveBeenCalledTimes(1);
    await expect(handle.finish()).resolves.toMatchObject({ status: 'completed' });
    expect(readerDisposed).toBe(true);
  });
});

function pollerHost(options: {
  existingTail: string;
  writes: string[];
  sleeps: ReturnType<typeof deferredSleeps>;
}): AppLogRuntimeHost {
  return {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => {
        throw new Error('unused');
      },
    },
    toolchains: { prepare: async () => undefined },
    artifacts: {
      resolveSession: () => ({
        outputPath: '/sessions/one/app.log',
        pidPath: '/sessions/one/app-log.pid',
      }),
    },
    commands: {
      which: async () => undefined,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    outputs: {
      readTail: async () => options.existingTail,
      openAppend: async () => ({
        write: async (chunk) => {
          options.writes.push(String(chunk));
        },
        [Symbol.asyncDispose]: async () => {},
      }),
    },
    processTransports: {
      resolve: async () => ({ mode: 'local' }),
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
    clock: {
      now: () => 100,
      sleep: async (milliseconds) => await options.sleeps.wait(milliseconds),
    },
  };
}

function deferredSleeps() {
  const pending: Array<{ milliseconds: number; resolve: () => void }> = [];
  return {
    wait: async (milliseconds: number) =>
      await new Promise<void>((resolve) => pending.push({ milliseconds, resolve })),
    resolveNext: (milliseconds: number) => {
      const index = pending.findIndex((entry) => entry.milliseconds === milliseconds);
      if (index < 0) throw new Error(`No ${milliseconds}ms sleep is pending`);
      pending.splice(index, 1)[0]?.resolve();
    },
    hasPending: (milliseconds: number) =>
      pending.some((entry) => entry.milliseconds === milliseconds),
  };
}
