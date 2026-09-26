import type { AppLogLiveHandle, AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';
import { describe, expect, test, vi } from 'vitest';
import {
  startAppLogPoller,
  type AppLogPollerInput,
  type AppLogPollerReader,
} from './app-log-polling.ts';
import { createDeferredSleeps, createPollerHost } from './app-log-polling.fixtures.ts';

const CLEANUP_MESSAGE = 'capture cleanup did not settle every owned resource';

function reader(overrides: Partial<AppLogPollerReader> = {}): AppLogPollerReader {
  return {
    readLogs: async () => '',
    [Symbol.asyncDispose]: async () => {},
    ...overrides,
  };
}

async function start(options: {
  host: AppLogRuntimeHost;
  reader: AppLogPollerReader;
}): Promise<AppLogLiveHandle> {
  return await startAppLogPoller(pollerInput({ host: options.host, reader: options.reader }));
}

describe('app-log poller', () => {
  test('deduplicates the persisted tail, echoes backend identity, and stops before disposing', async () => {
    const sleeps = createDeferredSleeps();
    const writes: string[] = [];
    const disposals: string[] = [];
    const readLogs = vi.fn(
      async (_appBundleId: string, _lineLimit: number) => 'old line\nshared\nnew line\n',
    );
    const logReader = reader({
      readLogs,
      [Symbol.asyncDispose]: async () => {
        disposals.push('reader');
      },
    });
    const handle = await start({
      host: createPollerHost({
        existingTail: 'old line\nshared\n[agent-device][mark][time] checkpoint\n',
        writes,
        sleeps,
        onOutputDispose: () => {
          disposals.push('output');
        },
      }),
      reader: logReader,
    });
    await vi.waitFor(() => expect(writes).toEqual(['new line\n']));
    expect(handle.inspect().backend).toBe('ios-simulator');
    expect(handle.inspect().state).toBe('active');

    const finishing = handle.finish();
    expect(disposals).toEqual([]);
    sleeps.resolveNext(1_000);
    await finishing;
    expect(readLogs).toHaveBeenCalledTimes(1);
    expect(disposals).toEqual(['reader', 'output']);
    expect(handle.inspect().state).toBe('ended');
  });

  test('streams only the appended delta across reads and normalizes the trailing newline', async () => {
    const sleeps = createDeferredSleeps();
    const writes: string[] = [];
    const tail = ['partial', 'partial done\n', 'partial done\n'];
    let read = 0;
    const handle = await start({
      host: createPollerHost({ existingTail: '', writes, sleeps }),
      reader: reader({ readLogs: async () => tail[read++] ?? '' }),
    });
    await vi.waitFor(() => expect(writes).toEqual(['partial\n']));
    sleeps.resolveNext(1_000);
    await vi.waitFor(() => expect(writes).toEqual(['partial\n', ' done\n']));
    sleeps.resolveNext(1_000);
    await vi.waitFor(() => expect(sleeps.hasPending(1_000)).toBe(true));
    expect(writes).toEqual(['partial\n', ' done\n']);
    expect(handle.inspect().state).toBe('active');
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await finishing;
    expect(handle.inspect().state).toBe('ended');
  });

  test.each(['readTail', 'openAppend'] as const)(
    'rolls back the reader when %s fails during acquisition',
    async (failure) => {
      const dispose = vi.fn(async () => {});
      await expect(
        startAppLogPoller(
          pollerInput({
            host: createPollerHost({
              existingTail: '',
              writes: [],
              sleeps: createDeferredSleeps(),
              failure,
            }),
            reader: reader({ [Symbol.asyncDispose]: dispose }),
          }),
        ),
      ).rejects.toThrow(`${failure === 'readTail' ? 'tail' : 'open'} failed`);
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  test('uses linear overlap matching for a near-limit tail without overlap', async () => {
    const sleeps = createDeferredSleeps();
    const writes: string[] = [];
    const handle = await start({
      host: createPollerHost({ existingTail: `${'a'.repeat(240_000)}\n`, writes, sleeps }),
      reader: reader({ readLogs: async () => `${'b'.repeat(240_000)}\n` }),
    });
    await vi.waitFor(() => expect(writes[0]?.length).toBe(240_001));
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await finishing;
  });

  test('reports the input cleanup message when reader disposal rejects, still disposing the output', async () => {
    const sleeps = createDeferredSleeps();
    let outputDisposed = false;
    const handle = await start({
      host: createPollerHost({
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
    });
    await vi.waitFor(() => expect(sleeps.hasPending(1_000)).toBe(true));
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await expect(finishing).resolves.toMatchObject({
      status: 'cleanup-pending',
      message: CLEANUP_MESSAGE,
    });
    expect(outputDisposed).toBe(true);
  });

  test('reports the cleanup message when output disposal rejects', async () => {
    const sleeps = createDeferredSleeps();
    let readerDisposed = false;
    const handle = await start({
      host: createPollerHost({
        existingTail: '',
        writes: [],
        sleeps,
        outputDisposeError: true,
      }),
      reader: reader({
        [Symbol.asyncDispose]: async () => {
          readerDisposed = true;
        },
      }),
    });
    await vi.waitFor(() => expect(sleeps.hasPending(1_000)).toBe(true));
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await expect(finishing).resolves.toMatchObject({
      status: 'cleanup-pending',
      message: CLEANUP_MESSAGE,
    });
    expect(readerDisposed).toBe(true);
  });

  test('fails a bounded read that never settles, then disposes', async () => {
    const sleeps = createDeferredSleeps();
    let readerDisposed = false;
    const readLogs = vi.fn(async (_appId: string, _limit: number) => {
      return await new Promise<string>(() => {});
    });
    const handle = await start({
      host: createPollerHost({ existingTail: '', writes: [], sleeps }),
      reader: reader({
        readLogs,
        [Symbol.asyncDispose]: async () => {
          readerDisposed = true;
        },
      }),
    });
    await vi.waitFor(() => expect(sleeps.hasPending(5_000)).toBe(true));
    sleeps.resolveNext(5_000);
    await vi.waitFor(() => expect(handle.inspect().state).toBe('failed'));
    expect(readLogs).toHaveBeenCalledTimes(1);
    expect(readerDisposed).toBe(false);
    await expect(handle.finish()).resolves.toMatchObject({ status: 'completed' });
    expect(readerDisposed).toBe(true);
  });

  test('recovers after a read rejection and resumes writing on the next read', async () => {
    const sleeps = createDeferredSleeps();
    const writes: string[] = [];
    let call = 0;
    const handle = await start({
      host: createPollerHost({ existingTail: '', writes, sleeps }),
      reader: reader({
        readLogs: async () => {
          call += 1;
          if (call === 1) throw new Error('transient read failure');
          return 'recovered line\n';
        },
      }),
    });
    await vi.waitFor(() => expect(sleeps.hasPending(1_000)).toBe(true));
    expect(handle.inspect().state).toBe('recovering');
    expect(writes).toEqual([]);
    sleeps.resolveNext(1_000);
    await vi.waitFor(() => expect(writes).toEqual(['recovered line\n']));
    expect(handle.inspect().state).toBe('active');
    const finishing = handle.finish();
    sleeps.resolveNext(1_000);
    await finishing;
  });

  test('stops before writing when finish begins during an in-flight read', async () => {
    const sleeps = createDeferredSleeps();
    const writes: string[] = [];
    let readerDisposed = false;
    let settleRead!: (text: string) => void;
    const readLogs = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          settleRead = resolve;
        }),
    );
    const handle = await start({
      host: createPollerHost({ existingTail: '', writes, sleeps }),
      reader: reader({
        readLogs,
        [Symbol.asyncDispose]: async () => {
          readerDisposed = true;
        },
      }),
    });
    await vi.waitFor(() => expect(readLogs).toHaveBeenCalledTimes(1));
    const finishing = handle.finish();
    settleRead('late line\n');
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
      sleeps.resolveAny();
    }
    await finishing;
    expect(writes).toEqual([]);
    expect(readerDisposed).toBe(true);
  });

  test('finishes idempotently and disposes each owned resource once', async () => {
    const sleeps = createDeferredSleeps();
    const writes: string[] = [];
    let readerDisposes = 0;
    let outputDisposes = 0;
    const handle = await start({
      host: createPollerHost({
        existingTail: '',
        writes,
        sleeps,
        onOutputDispose: () => {
          outputDisposes += 1;
        },
      }),
      reader: reader({
        readLogs: async () => 'one line\n',
        [Symbol.asyncDispose]: async () => {
          readerDisposes += 1;
        },
      }),
    });
    await vi.waitFor(() => expect(writes).toEqual(['one line\n']));
    const first = handle.finish();
    const second = handle.finish();
    sleeps.resolveNext(1_000);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'completed' }),
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(readerDisposes).toBe(1);
    expect(outputDisposes).toBe(1);
  });
});

function pollerInput(
  input: Readonly<{ host: AppLogRuntimeHost; reader: AppLogPollerReader }>,
): AppLogPollerInput {
  return {
    host: input.host,
    reader: input.reader,
    backend: 'ios-simulator',
    appBundleId: 'com.example.app',
    outputPath: '/sessions/one/app.log',
    cleanupFailureMessage: CLEANUP_MESSAGE,
  };
}
