import { describe, expect, test, vi } from 'vitest';
import {
  startProviderAppLogPoller,
  type ProviderAppLogPollerOptions,
  type ProviderAppLogReader,
} from './provider-app-log-poller.ts';

describe('provider app-log poller', () => {
  test('deduplicates the persisted tail and stops before disposing its resources', async () => {
    const sleeps = deferredSleeps();
    const writes: string[] = [];
    let outputDisposed = false;
    let readerDisposed = false;
    const reader = providerReader({
      readLogs: vi.fn(async () => 'old line\nshared\nnew line\n'),
      [Symbol.asyncDispose]: async () => {
        readerDisposed = true;
      },
    });
    const handle = await startProviderAppLogPoller(
      pollerOptions(reader, {
        existingTail: 'old line\nshared\n[agent-device][mark][time] checkpoint\n',
        writes,
        sleeps,
        onOutputDispose: () => {
          outputDisposed = true;
        },
      }),
    );
    await vi.waitFor(() => expect(writes).toEqual(['new line\n']));

    const finishing = handle.finish();
    expect(readerDisposed).toBe(false);
    expect(outputDisposed).toBe(false);
    sleeps.resolveNext(1_000);
    await expect(finishing).resolves.toEqual({
      status: 'completed',
      result: { backend: 'ios-simulator', outputPath: '/sessions/one/app.log', completedAt: 100 },
    });
    expect(reader.readLogs).toHaveBeenCalledTimes(1);
    expect(readerDisposed).toBe(true);
    expect(outputDisposed).toBe(true);
  });

  test.each(['readTail', 'openAppend'] as const)(
    'rolls back the reader when %s fails during acquisition',
    async (failure) => {
      const dispose = vi.fn(async () => {});
      const reader = providerReader({ [Symbol.asyncDispose]: dispose });
      await expect(
        startProviderAppLogPoller(
          pollerOptions(reader, { writes: [], sleeps: deferredSleeps(), failure }),
        ),
      ).rejects.toThrow(`${failure === 'readTail' ? 'tail' : 'open'} failed`);
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  test('uses linear overlap matching for a near-limit tail without overlap', async () => {
    const sleeps = deferredSleeps();
    const writes: string[] = [];
    const reader = providerReader({ readLogs: async () => `${'b'.repeat(240_000)}\n` });
    const handle = await startProviderAppLogPoller(
      pollerOptions(reader, { existingTail: `${'a'.repeat(240_000)}\n`, writes, sleeps }),
    );
    await vi.waitFor(() => expect(writes[0]?.length).toBe(240_001));
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await finishing;
  });

  test('keeps a delta whose write failed and writes it on the next poll', async () => {
    const sleeps = deferredSleeps();
    const writes: string[] = [];
    let failNextWrite = true;
    const reader = providerReader({ readLogs: async () => 'first\n' });
    const handle = await startProviderAppLogPoller(
      pollerOptions(reader, {
        writes,
        sleeps,
        write: (chunk) => {
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error('disk full');
          }
          writes.push(chunk);
        },
      }),
    );
    await vi.waitFor(() => expect(sleeps.hasPending(1_000)).toBe(true));
    expect(handle.inspect().state).toBe('recovering');
    expect(writes).toEqual([]);

    sleeps.resolveNext(1_000);
    await vi.waitFor(() => expect(writes).toEqual(['first\n']));
    expect(handle.inspect().state).toBe('active');
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await finishing;
  });

  test('recovers after a rejected read and resumes appending', async () => {
    const sleeps = deferredSleeps();
    const writes: string[] = [];
    const readLogs = vi
      .fn<ProviderAppLogReader['readLogs']>()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValue('line\n');
    const handle = await startProviderAppLogPoller(
      pollerOptions(providerReader({ readLogs }), { writes, sleeps }),
    );
    await vi.waitFor(() => expect(handle.inspect().state).toBe('recovering'));

    sleeps.resolveNext(1_000);
    await vi.waitFor(() => expect(writes).toEqual(['line\n']));
    expect(handle.inspect().state).toBe('active');
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await finishing;
  });

  test('still disposes the output when reader cleanup rejects', async () => {
    const sleeps = deferredSleeps();
    let outputDisposed = false;
    const reader = providerReader({
      [Symbol.asyncDispose]: async () => {
        throw new Error('reader cleanup failed');
      },
    });
    const handle = await startProviderAppLogPoller(
      pollerOptions(reader, {
        writes: [],
        sleeps,
        onOutputDispose: () => {
          outputDisposed = true;
        },
      }),
    );
    await vi.waitFor(() => expect(sleeps.hasPending(1_000)).toBe(true));
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await expect(finishing).resolves.toEqual({
      status: 'cleanup-pending',
      reason: 'transport-failed',
      message: 'Example app-log cleanup did not settle every owned resource',
    });
    expect(outputDisposed).toBe(true);
    expect(handle.inspect().state).toBe('failed');
  });

  test('abandons a read that ignores its signal once the budget elapses', async () => {
    const sleeps = deferredSleeps();
    let readerDisposed = false;
    let readSignal: AbortSignal | undefined;
    const reader = providerReader({
      readLogs: vi.fn(async (_appBundleId, _lineLimit, signal) => {
        readSignal = signal;
        return await new Promise<string>(() => {});
      }),
      [Symbol.asyncDispose]: async () => {
        readerDisposed = true;
      },
    });
    const handle = await startProviderAppLogPoller(
      pollerOptions(reader, { writes: [], sleeps, backend: 'android' }),
    );
    const finishing = handle.finish();
    expect(readerDisposed).toBe(false);
    sleeps.resolveNext(5_000);
    await finishing;
    expect(reader.readLogs).toHaveBeenCalledTimes(1);
    expect(reader.readLogs).toHaveBeenCalledWith('com.example.app', 1_000, expect.any(AbortSignal));
    expect(readSignal?.aborted).toBe(true);
    expect(readerDisposed).toBe(true);
  });

  test('keeps the rejection of an abandoned read handled', async () => {
    const sleeps = deferredSleeps();
    let rejectRead!: (error: Error) => void;
    const reader = providerReader({
      readLogs: async () =>
        await new Promise<string>((_resolve, reject) => {
          rejectRead = reject;
        }),
    });
    const handle = await startProviderAppLogPoller(pollerOptions(reader, { writes: [], sleeps }));
    await vi.waitFor(() => expect(sleeps.hasPending(5_000)).toBe(true));
    sleeps.resolveNext(5_000);
    await vi.waitFor(() => expect(handle.inspect().state).toBe('failed'));
    rejectRead(new Error('late provider failure'));
    await expect(handle.finish()).resolves.toMatchObject({ status: 'completed' });
  });

  test('memoizes finish so resources are disposed once', async () => {
    const sleeps = deferredSleeps();
    const dispose = vi.fn(async () => {});
    const handle = await startProviderAppLogPoller(
      pollerOptions(providerReader({ [Symbol.asyncDispose]: dispose }), { writes: [], sleeps }),
    );
    await vi.waitFor(() => expect(sleeps.hasPending(1_000)).toBe(true));
    const first = handle.finish();
    const second = handle.finish();
    sleeps.resolveNext(1_000);
    expect(await second).toEqual(await first);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

function providerReader(overrides: Partial<ProviderAppLogReader> = {}): ProviderAppLogReader {
  return {
    readLogs: async () => '',
    [Symbol.asyncDispose]: async () => {},
    ...overrides,
  };
}

function pollerOptions(
  reader: ProviderAppLogReader,
  options: {
    existingTail?: string;
    writes: string[];
    sleeps: ReturnType<typeof deferredSleeps>;
    write?: (chunk: string) => void;
    onOutputDispose?: () => void;
    failure?: 'readTail' | 'openAppend';
    backend?: ProviderAppLogPollerOptions['backend'];
  },
): ProviderAppLogPollerOptions {
  return {
    host: {
      outputs: {
        readTail: async () => {
          if (options.failure === 'readTail') throw new Error('tail failed');
          return options.existingTail ?? '';
        },
        openAppend: async () => {
          if (options.failure === 'openAppend') throw new Error('open failed');
          return {
            write: async (chunk) => {
              if (options.write) options.write(String(chunk));
              else options.writes.push(String(chunk));
            },
            [Symbol.asyncDispose]: async () => options.onOutputDispose?.(),
          };
        },
      },
      clock: {
        now: () => 100,
        sleep: async (milliseconds) => await options.sleeps.wait(milliseconds),
      },
    },
    provider: 'Example',
    backend: options.backend ?? 'ios-simulator',
    reader,
    appBundleId: 'com.example.app',
    outputPath: '/sessions/one/app.log',
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
