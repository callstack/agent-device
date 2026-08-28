import type { AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';
import { describe, expect, test, vi } from 'vitest';
import { startDoublespeedAppLogPoller, type DoublespeedAppLogReader } from './app-log-poller.ts';

function reader(overrides: Partial<DoublespeedAppLogReader> = {}): DoublespeedAppLogReader {
  return {
    leaseId: 'lease-1',
    simulatorId: 'sim-1',
    readLogs: async () => '',
    [Symbol.asyncDispose]: async () => {},
    ...overrides,
  };
}

describe('Doublespeed app-log poller', () => {
  test('deduplicates the persisted tail and stops before disposing its resources', async () => {
    const sleeps = deferredSleeps();
    const writes: string[] = [];
    let outputDisposed = false;
    let readerDisposed = false;
    const logReader = reader({
      readLogs: vi.fn(async () => 'old line\nshared\nnew line\n'),
      [Symbol.asyncDispose]: async () => {
        readerDisposed = true;
      },
    });
    const handle = await startDoublespeedAppLogPoller({
      host: pollerHost({
        existingTail: 'old line\nshared\n[agent-device][mark][time] checkpoint\n',
        writes,
        sleeps,
        onOutputDispose: () => {
          outputDisposed = true;
        },
      }),
      reader: logReader,
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
    });
    await vi.waitFor(() => expect(writes).toEqual(['new line\n']));
    expect(handle.inspect().backend).toBe('ios-simulator');

    const finishing = handle.finish();
    expect(readerDisposed).toBe(false);
    expect(outputDisposed).toBe(false);
    sleeps.resolveNext(1_000);
    await finishing;
    expect(logReader.readLogs).toHaveBeenCalledTimes(1);
    expect(readerDisposed).toBe(true);
    expect(outputDisposed).toBe(true);
  });

  test.each(['readTail', 'openAppend'] as const)(
    'rolls back the reader when %s fails during acquisition',
    async (failure) => {
      const dispose = vi.fn(async () => {});
      const host = pollerHost({ existingTail: '', writes: [], sleeps: deferredSleeps(), failure });
      await expect(
        startDoublespeedAppLogPoller({
          host,
          reader: reader({ [Symbol.asyncDispose]: dispose }),
          appBundleId: 'com.example.app',
          outputPath: '/sessions/one/app.log',
        }),
      ).rejects.toThrow(`${failure === 'readTail' ? 'tail' : 'open'} failed`);
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  test('uses linear overlap matching for a near-limit tail without overlap', async () => {
    const sleeps = deferredSleeps();
    const writes: string[] = [];
    const handle = await startDoublespeedAppLogPoller({
      host: pollerHost({ existingTail: `${'a'.repeat(240_000)}\n`, writes, sleeps }),
      reader: reader({ readLogs: async () => `${'b'.repeat(240_000)}\n` }),
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
    });
    await vi.waitFor(() => expect(writes[0]?.length).toBe(240_001));
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await finishing;
  });

  test('still disposes the output when reader cleanup rejects', async () => {
    const sleeps = deferredSleeps();
    let outputDisposed = false;
    const handle = await startDoublespeedAppLogPoller({
      host: pollerHost({
        existingTail: '',
        writes: [],
        sleeps,
        onOutputDispose: () => {
          outputDisposed = true;
        },
      }),
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
    await expect(finishing).resolves.toMatchObject({ status: 'cleanup-pending' });
    expect(outputDisposed).toBe(true);
  });

  test('allows one bounded read only and settles it before disposal', async () => {
    const sleeps = deferredSleeps();
    let readerDisposed = false;
    const readLogs = vi.fn(async () => await new Promise<string>(() => {}));
    const handle = await startDoublespeedAppLogPoller({
      host: pollerHost({ existingTail: '', writes: [], sleeps }),
      reader: reader({
        readLogs,
        [Symbol.asyncDispose]: async () => {
          readerDisposed = true;
        },
      }),
      appBundleId: 'com.example.app',
      outputPath: '/sessions/one/app.log',
    });
    const finishing = handle.finish();
    expect(readerDisposed).toBe(false);
    sleeps.resolveNext(5_000);
    await finishing;
    expect(readLogs).toHaveBeenCalledTimes(1);
    expect(readerDisposed).toBe(true);
  });
});

function pollerHost(options: {
  existingTail: string;
  writes: string[];
  sleeps: ReturnType<typeof deferredSleeps>;
  onOutputDispose?: () => void;
  failure?: 'readTail' | 'openAppend';
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
      readTail: async () => {
        if (options.failure === 'readTail') throw new Error('tail failed');
        return options.existingTail;
      },
      openAppend: async () => {
        if (options.failure === 'openAppend') throw new Error('open failed');
        return {
          write: async (chunk) => {
            options.writes.push(String(chunk));
          },
          [Symbol.asyncDispose]: async () => options.onOutputDispose?.(),
        };
      },
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
