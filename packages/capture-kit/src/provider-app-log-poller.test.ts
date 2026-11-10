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
    await finishing;
  });

  test('still disposes the output when reader cleanup rejects', async () => {
    const sleeps = deferredSleeps();
    let outputDisposed = false;
    const onOutputDispose = vi.fn(() => {
      outputDisposed = true;
    });
    const dispose = vi.fn(async () => {}).mockRejectedValueOnce(new Error('reader cleanup failed'));
    const reader = providerReader({
      [Symbol.asyncDispose]: dispose,
    });
    const handle = await startProviderAppLogPoller(
      pollerOptions(reader, {
        writes: [],
        sleeps,
        onOutputDispose,
      }),
    );
    await vi.waitFor(() => expect(sleeps.hasPending(1_000)).toBe(true));
    const finishing = handle.finish();
    await expect(finishing).resolves.toEqual({
      status: 'cleanup-pending',
      reason: 'transport-failed',
      message: 'Example app-log cleanup did not settle every owned resource',
    });
    expect(outputDisposed).toBe(true);
    expect(handle.inspect().state).toBe('failed');
    await handle[Symbol.asyncDispose]();
    await handle[Symbol.asyncDispose]();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(onOutputDispose).toHaveBeenCalledOnce();
  });

  test('finish keeps a reader whose read ignores its signal until that read settles', async () => {
    const sleeps = deferredSleeps();
    let readerDisposed = false;
    let readSignal: AbortSignal | undefined;
    let settleRead!: (text: string) => void;
    const reader = providerReader({
      readLogs: vi.fn(async (_appBundleId, _lineLimit, signal) => {
        readSignal = signal;
        return await new Promise<string>((resolve) => {
          settleRead = resolve;
        });
      }),
      [Symbol.asyncDispose]: async () => {
        readerDisposed = true;
      },
    });
    const handle = await startProviderAppLogPoller(
      pollerOptions(reader, { writes: [], sleeps, backend: 'android' }),
    );
    await vi.waitFor(() => expect(sleeps.hasPending(5_000)).toBe(true));
    const finishing = handle.finish();
    // finish aborts the read and waits one read budget for the provider call to end.
    await vi.waitFor(() => expect(readSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(sleeps.hasPending(5_000)).toBe(true));
    sleeps.resolveNext(5_000);
    await expect(finishing).resolves.toMatchObject({ status: 'cleanup-pending' });
    expect(readerDisposed).toBe(false);

    settleRead('late\n');
    // The retryable cleanup reruns the finish transaction once the read has settled.
    await handle[Symbol.asyncDispose]();
    expect(reader.readLogs).toHaveBeenCalledTimes(1);
    expect(reader.readLogs).toHaveBeenCalledWith('com.example.app', 1_000, expect.any(AbortSignal));
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
    await vi.waitFor(() => expect(handle.inspect().state).toBe('recovering'));
    rejectRead(new Error('late provider failure'));
    await expect(handle.finish()).resolves.toMatchObject({ status: 'completed' });
  });

  test('a read that outlives its budget blocks the next read until it settles', async () => {
    const sleeps = deferredSleeps();
    const writes: string[] = [];
    let settleSlowRead!: (text: string) => void;
    const readLogs = vi
      .fn<ProviderAppLogReader['readLogs']>()
      .mockImplementationOnce(
        async () =>
          await new Promise<string>((resolve) => {
            settleSlowRead = resolve;
          }),
      )
      .mockResolvedValue('line\n');
    const handle = await startProviderAppLogPoller(
      pollerOptions(providerReader({ readLogs }), { writes, sleeps }),
    );
    await vi.waitFor(() => expect(sleeps.hasPending(5_000)).toBe(true));
    sleeps.resolveNext(5_000);
    await vi.waitFor(() => expect(handle.inspect().state).toBe('recovering'));

    // The abandoned call is still running, so the next tick starts no second read.
    await vi.waitFor(() => expect(sleeps.hasPending(1_000)).toBe(true));
    sleeps.resolveNext(1_000);
    await vi.waitFor(() => expect(sleeps.hasPending(1_000)).toBe(true));
    expect(readLogs).toHaveBeenCalledTimes(1);

    settleSlowRead('ignored\n');
    // The read's settlement and the released tick race through microtasks. A tick that runs first
    // only reports recovering and sleeps again, so release ticks until the second read lands.
    await vi.waitFor(() => {
      if (sleeps.hasPending(1_000)) sleeps.resolveNext(1_000);
      expect(writes).toEqual(['line\n']);
    });
    expect(readLogs).toHaveBeenCalledTimes(2);
    expect(handle.inspect().state).toBe('active');
    await handle.finish();
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
        sleep: async (milliseconds, signal) => await options.sleeps.wait(milliseconds, signal),
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
    wait: async (milliseconds: number, signal?: AbortSignal) =>
      await new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();
        const entry = { milliseconds, resolve };
        pending.push(entry);
        signal?.addEventListener(
          'abort',
          () => {
            pending.splice(pending.indexOf(entry), 1);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    resolveNext: (milliseconds: number) => {
      const index = pending.findIndex((entry) => entry.milliseconds === milliseconds);
      if (index < 0) throw new Error(`No ${milliseconds}ms sleep is pending`);
      pending.splice(index, 1)[0]?.resolve();
    },
    hasPending: (milliseconds: number) =>
      pending.some((entry) => entry.milliseconds === milliseconds),
  };
}
