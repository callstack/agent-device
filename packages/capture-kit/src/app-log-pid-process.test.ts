import { describe, expect, test, vi } from 'vitest';
import type {
  AppLogBackgroundProcess,
  AppLogOutputSink,
  AppLogRuntimeHost,
} from '@agent-device/contracts/app-log-runtime';
import { deferred, processFixture } from './app-log-pid-process.fixtures.ts';
import { createPidScopedAppLogProcess } from './app-log-pid-process.ts';

describe('PID-scoped app-log process lifecycle', () => {
  test('retries output disposal after an unconfirmed finish', async () => {
    const output = outputFixture();
    output.dispose.mockRejectedValueOnce(new Error('Close unavailable'));
    const started =
      processFixture(deferred<{ stdout: string; stderr: string; exitCode: number }>());
    const handle = await createPidScopedAppLogProcess({
      host: hostFixture(output.sink),
      backend: 'android',
      outputPath: '/tmp/app.log',
      pidPath: '/tmp/pid',
      processStart: async () => started.process,
      setupSignal: new AbortController().signal,
      resolvePid: async () => '123',
      command: () => ({ kind: 'host', request: { executable: 'adb', args: ['logcat'] } }),
      cleanupFailureMessage: 'cleanup failed',
    });
    await expect(handle.finish()).resolves.toMatchObject({ status: 'cleanup-pending' });
    await handle[Symbol.asyncDispose]();
    await handle[Symbol.asyncDispose]();
    expect(output.dispose).toHaveBeenCalledTimes(2);
  });
  test('cleans a later process that resolves after finish begins', async () => {
    const initialExit = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    const laterExit = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    const laterStart = deferred<AppLogBackgroundProcess>();
    const initial = processFixture(initialExit);
    const later = processFixture(laterExit);
    const output = outputFixture();
    const starts = vi
      .fn()
      .mockResolvedValueOnce(initial.process)
      .mockImplementationOnce(async () => await laterStart.promise);
    const host = hostFixture(output.sink);
    const handle = await createPidScopedAppLogProcess({
      host,
      backend: 'android',
      outputPath: '/tmp/app.log',
      pidPath: '/tmp/app-log.pid',
      processStart: starts,
      setupSignal: new AbortController().signal,
      resolvePid: async () => (starts.mock.calls.length === 0 ? '123' : '456'),
      command: (pid) => ({
        kind: 'host',
        request: { executable: 'adb', args: ['logcat', '--pid', pid] },
      }),
      cleanupFailureMessage: 'cleanup failed',
    });

    initialExit.resolve({ stdout: '', stderr: '', exitCode: 0 });
    await vi.waitFor(() => expect(starts).toHaveBeenCalledTimes(2));
    const finishing = handle.finish();
    laterStart.resolve(later.process);

    await expect(finishing).resolves.toMatchObject({ status: 'completed' });
    expect(later.terminate).toHaveBeenCalledOnce();
    expect(later.dispose).toHaveBeenCalledOnce();
    expect(output.dispose).toHaveBeenCalledOnce();
  });

  test('disposes output and rejects when an empty-PID setup is cancelled during open', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled during output open');
    const output = outputFixture();
    const host = hostFixture(output.sink, () => controller.abort(reason));
    const start = vi.fn();
    const resolvePid = vi.fn(async () => '');

    await expect(
      createPidScopedAppLogProcess({
        host,
        backend: 'android',
        outputPath: '/tmp/app.log',
        pidPath: '/tmp/app-log.pid',
        processStart: start,
        setupSignal: controller.signal,
        resolvePid,
        command: () => ({
          kind: 'host',
          request: { executable: 'adb', args: ['logcat'] },
        }),
        cleanupFailureMessage: 'cleanup failed',
      }),
    ).rejects.toBe(reason);
    expect(output.dispose).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(resolvePid).toHaveBeenCalledOnce();
    expect(host.clock.sleep).not.toHaveBeenCalled();
  });

  test('re-probes the app PID after an empty recovering observation', async () => {
    const exit = deferred<{ stdout: string; stderr: string; exitCode: number }>();
    const started = processFixture(exit);
    const output = outputFixture();
    const resolvePid = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('456');
    const start = vi.fn(async () => started.process);
    const handle = await createPidScopedAppLogProcess({
      host: hostFixture(output.sink),
      backend: 'android',
      outputPath: '/tmp/app.log',
      pidPath: '/tmp/app-log.pid',
      processStart: start,
      setupSignal: new AbortController().signal,
      resolvePid,
      command: (pid) => ({
        kind: 'host',
        request: { executable: 'adb', args: ['logcat', '--pid', pid] },
      }),
      cleanupFailureMessage: 'cleanup failed',
    });

    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(resolvePid.mock.calls.length).toBeGreaterThanOrEqual(2);
    await handle.finish();
    expect(started.terminate).toHaveBeenCalledOnce();
  });

  test('settles an initially started process before disposing output after cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled after process start');
    const order: string[] = [];
    const process: AppLogBackgroundProcess = {
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }).then((result) => {
        order.push('wait');
        return result;
      }),
      terminate: async () => {
        order.push('terminate');
      },
      [Symbol.asyncDispose]: async () => {
        order.push('process-dispose');
      },
    };
    const output: AppLogOutputSink = {
      write: async () => {},
      [Symbol.asyncDispose]: async () => {
        order.push('output-dispose');
      },
    };
    const host = hostFixture(output);

    await expect(
      createPidScopedAppLogProcess({
        host,
        backend: 'android',
        outputPath: '/tmp/app.log',
        pidPath: '/tmp/app-log.pid',
        processStart: async (_request, signal) => {
          expect(signal?.aborted).toBe(false);
          controller.abort(reason);
          expect(signal?.reason).toBe(reason);
          return process;
        },
        setupSignal: controller.signal,
        resolvePid: async () => '123',
        command: () => ({
          kind: 'host',
          request: { executable: 'adb', args: ['logcat'] },
        }),
        cleanupFailureMessage: 'cleanup failed',
      }),
    ).rejects.toBe(reason);
    expect(order).toEqual(['wait', 'terminate', 'process-dispose', 'output-dispose']);
  });
});

function outputFixture() {
  const dispose = vi.fn(async () => {});
  return {
    dispose,
    sink: {
      write: async () => {},
      [Symbol.asyncDispose]: dispose,
    } satisfies AppLogOutputSink,
  };
}

function hostFixture(output: AppLogOutputSink, onOpen?: () => void): AppLogRuntimeHost {
  const start = vi.fn();
  return {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => {
        throw new Error('unused');
      },
    },
    toolchains: { prepare: async () => undefined },
    artifacts: { resolveSession: () => ({ outputPath: '/tmp/app.log', pidPath: '/tmp/pid' }) },
    commands: {
      which: async () => undefined,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    outputs: {
      openAppend: async () => {
        onOpen?.();
        return output;
      },
      readTail: async () => '',
    },
    processTransports: { resolve: async () => ({ mode: 'local', start }) },
    processes: {
      start,
      readMarker: async () => ({ status: 'missing' }),
      clearMarker: async () => {},
      inspect: async () => 'missing',
      terminate: async () => 'already-missing',
    },
    clock: { now: () => 0, sleep: vi.fn(testSleep) },
  };
}

async function testSleep(_milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, 1);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

describe('PID-scoped app-log capture after a failed PID poll', () => {
  function startCapture(
    resolvePid: () => Promise<string>,
    start: () => Promise<AppLogBackgroundProcess>,
  ) {
    return createPidScopedAppLogProcess({
      host: hostFixture(outputFixture().sink),
      backend: 'android',
      outputPath: '/tmp/app.log',
      pidPath: '/tmp/app-log.pid',
      processStart: start,
      setupSignal: new AbortController().signal,
      resolvePid,
      command: (pid) => ({
        kind: 'host',
        request: { executable: 'adb', args: ['logcat', '--pid', pid] },
      }),
      cleanupFailureMessage: 'cleanup failed',
    });
  }

  test('keeps the active stream and keeps polling after one rejected poll', async () => {
    const started =
      processFixture(deferred<{ stdout: string; stderr: string; exitCode: number }>());
    const resolvePid = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('123')
      .mockRejectedValueOnce(new Error('adb shell pidof timed out'))
      .mockResolvedValue('123');
    const handle = await startCapture(resolvePid, async () => started.process);

    await vi.waitFor(() => expect(resolvePid.mock.calls.length).toBeGreaterThanOrEqual(4));
    expect(started.dispose).not.toHaveBeenCalled();
    expect(started.terminate).not.toHaveBeenCalled();
    await expect(handle.finish()).resolves.toMatchObject({ status: 'completed' });
    expect(started.terminate).toHaveBeenCalledOnce();
  });

  test('starts the stream once a rejected waiting poll is followed by a PID', async () => {
    const started =
      processFixture(deferred<{ stdout: string; stderr: string; exitCode: number }>());
    const resolvePid = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(new Error('adb shell pidof timed out'))
      .mockResolvedValue('456');
    const start = vi.fn(async () => started.process);
    const handle = await startCapture(resolvePid, start);

    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    await handle.finish();
    expect(started.terminate).toHaveBeenCalledOnce();
  });
});
