import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmd: vi.fn(),
}));

import { runCmd } from '@agent-device/host-kit/command';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { bindTestCommandHost } from '@agent-device/test-kit';
import { deferred, route } from './platform-runtime-device-ready-http.fixtures.ts';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

bindTestCommandHost();
const mockRunCmd = vi.mocked(runCmd);
const BOOTED = { stdout: '1\n', stderr: '', exitCode: 0 };

beforeAll(async () => {
  await loadAndroidMechanics();
});
beforeEach(() => {
  mockRunCmd.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

for (const command of ['snapshot', 'clipboard'] as const) {
  test.each([false, true])(
    `${command}: caller abort (disconnect=%s) stops Android getprop through real HTTP admission`,
    async (disconnect) => {
      const { server, send, runtime, readClipboard } = await route();
      const polling = deferred<void>();
      const release = deferred<typeof BOOTED>();
      let abortedIo = false;
      mockRunCmd.mockImplementation(async (_command, args, options) => {
        expect(args).toContain('sys.boot_completed');
        polling.resolve();
        return await new Promise((resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              abortedIo = true;
              reject(createRequestCanceledError());
            },
            { once: true },
          );
          void release.promise.then(resolve);
        });
      });
      const call = send(command);
      try {
        await Promise.race([
          polling.promise,
          call.answer.then((response) => {
            expect.fail(`request ended before Android readiness: ${JSON.stringify(response)}`);
          }),
        ]);
        const signal = await call.cancel(disconnect);
        expect(signal.reason).toMatchObject({ details: { reason: 'request_canceled' } });
        expect(abortedIo, 'caller abort must stop the in-flight getprop I/O').toBe(true);
        if (!disconnect)
          expect(await call.answer).toMatchObject({
            ok: false,
            error: { details: { reason: 'request_canceled' } },
          });
      } finally {
        release.resolve(BOOTED);
        await server.close();
      }
      expect(runtime.captureSnapshot).not.toHaveBeenCalled();
      expect(readClipboard).not.toHaveBeenCalled();
      expect(mockRunCmd).toHaveBeenCalledTimes(1);
    },
  );

  test(`${command}: the descriptor deadline aborts readiness before dispatch or cache publication`, async () => {
    const { server, send, runtime, readClipboard } = await route();
    const polling = deferred<void>();
    const release = deferred<typeof BOOTED>();
    let abortedIo = false;
    mockRunCmd
      .mockImplementationOnce(async (_command, _args, options) => {
        polling.resolve();
        return await new Promise((resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              abortedIo = true;
              reject(createRequestCanceledError());
            },
            { once: true },
          );
          void release.promise.then(resolve);
        });
      })
      .mockResolvedValue(BOOTED);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const call = send(command, true);
    try {
      await Promise.race([
        polling.promise,
        call.answer.then((response) => {
          expect.fail(`request ended before Android readiness: ${JSON.stringify(response)}`);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(abortedIo, 'the batch descriptor deadline must stop in-flight getprop I/O').toBe(true);
      release.resolve(BOOTED);
      expect(await call.answer).toMatchObject({
        ok: false,
        error: {
          details: {
            reason: 'daemon_request_timeout',
            causeReason: 'request_canceled',
            timeoutMs: 60_000,
            dispatched: 'no',
          },
        },
      });
      expect(runtime.captureSnapshot).not.toHaveBeenCalled();
      expect(readClipboard).not.toHaveBeenCalled();
      expect(await send(command).answer).toMatchObject({ ok: true });
      expect(mockRunCmd).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve(BOOTED);
      await call.answer;
      vi.useRealTimers();
      await server.close();
    }
  });

  test(`${command}: readiness just before the descriptor deadline dispatches and caches`, async () => {
    const { server, send, runtime, readClipboard } = await route();
    const polling = deferred<void>();
    const release = deferred<typeof BOOTED>();
    mockRunCmd
      .mockImplementationOnce(async () => {
        polling.resolve();
        return await release.promise;
      })
      .mockResolvedValue(BOOTED);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const call = send(command, true);
    try {
      await Promise.race([
        polling.promise,
        call.answer.then((response) => {
          expect.fail(`request ended before Android readiness: ${JSON.stringify(response)}`);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(59_999);
      release.resolve(BOOTED);
      expect(await call.answer).toMatchObject({ ok: true });
      expect(await send(command).answer).toMatchObject({ ok: true });
      expect(mockRunCmd).toHaveBeenCalledTimes(1);
      expect(
        command === 'snapshot' ? runtime.captureSnapshot : readClipboard,
      ).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve(BOOTED);
      await call.answer;
      vi.useRealTimers();
      await server.close();
    }
  });

  test(`${command}: a booted result delivered after expiry cannot dispatch or populate readiness`, async () => {
    const { server, send, runtime, readClipboard } = await route();
    const polling = deferred<void>();
    const release = deferred<typeof BOOTED>();
    mockRunCmd
      .mockImplementationOnce(async () => {
        polling.resolve();
        return await release.promise;
      })
      .mockResolvedValue(BOOTED);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const call = send(command, true);
    try {
      await Promise.race([
        polling.promise,
        call.answer.then((response) => {
          expect.fail(`request ended before Android readiness: ${JSON.stringify(response)}`);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(60_000);
      release.resolve(BOOTED);
      expect(await call.answer).toMatchObject({
        ok: false,
        error: {
          details: {
            reason: 'daemon_request_timeout',
            causeReason: 'request_canceled',
            dispatched: 'no',
          },
        },
      });
      expect(runtime.captureSnapshot).not.toHaveBeenCalled();
      expect(readClipboard).not.toHaveBeenCalled();
      expect(await send(command).answer).toMatchObject({ ok: true });
      expect(mockRunCmd).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve(BOOTED);
      await call.answer;
      vi.useRealTimers();
      await server.close();
    }
  });
}
