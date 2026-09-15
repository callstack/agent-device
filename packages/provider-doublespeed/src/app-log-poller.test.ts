import type { AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';
import { describe, expect, test, vi } from 'vitest';
import { startDoublespeedAppLogPoller, type DoublespeedAppLogReader } from './app-log-poller.ts';

function reader(overrides: Partial<DoublespeedAppLogReader> = {}): DoublespeedAppLogReader {
  return {
    leaseId: 'lease-1',
    simulatorId: 'sim-1',
    readLogs: async () => 'one line\n',
    [Symbol.asyncDispose]: async () => {},
    ...overrides,
  };
}

describe('Doublespeed app-log poller', () => {
  test('reports the ios-simulator backend identity independently of the shared poller', async () => {
    const sleeps = deferredSleeps();
    const writes: string[] = [];
    const handle = await startDoublespeedAppLogPoller({
      host: pollerHost({ existingTail: '', writes, sleeps }),
      reader: reader(),
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
    });
    await vi.waitFor(() => expect(writes).toEqual(['one line\n']));
    expect(handle.inspect().backend).toBe('ios-simulator');
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await expect(finishing).resolves.toMatchObject({
      status: 'completed',
      result: { backend: 'ios-simulator' },
    });
  });

  test('keeps the Doublespeed cleanup wording when disposal fails', async () => {
    const sleeps = deferredSleeps();
    const handle = await startDoublespeedAppLogPoller({
      host: pollerHost({ existingTail: '', writes: [], sleeps }),
      reader: reader({
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
      message: 'Doublespeed app-log cleanup did not settle every owned resource',
    });
  });

  test('forwards an abort signal to the provider reader read', async () => {
    const sleeps = deferredSleeps();
    const writes: string[] = [];
    let seenSignal: AbortSignal | undefined;
    const readLogs = vi.fn(async (_appId: string, _limit: number, signal?: AbortSignal) => {
      seenSignal = signal;
      return 'one line\n';
    });
    const handle = await startDoublespeedAppLogPoller({
      host: pollerHost({ existingTail: '', writes, sleeps }),
      reader: reader({ readLogs }),
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
    });
    await vi.waitFor(() => expect(writes).toEqual(['one line\n']));
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await finishing;
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
