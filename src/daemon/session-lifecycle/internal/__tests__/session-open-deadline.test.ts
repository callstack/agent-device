import { afterEach, expect, test, vi } from 'vitest';
import {
  clearRequestAbortRegistration,
  registerRequestAbort,
} from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';
import { withOpenStartupDeadline } from '../session-open-deadline.ts';
import type { DaemonRequest } from '../../../types.ts';
import { MAX_STARTUP_TIMEOUT_MS } from '../../../../core/command-descriptor/timeout-policy.ts';

const req: DaemonRequest = {
  token: 'test',
  session: 'cold-start',
  command: 'open',
  positionals: ['Settings'],
  flags: { timeoutMs: 600_000 },
  meta: { requestId: 'cold-start-test' },
};

afterEach(() => vi.useRealTimers());

test.each([0, -1, 1.5, Number.NaN, MAX_STARTUP_TIMEOUT_MS + 1])(
  'rejects an invalid startup timer before executing device work: %s',
  async (timeoutMs) => {
    const open = vi.fn();
    await expect(
      withOpenStartupDeadline({ ...req, flags: { timeoutMs } }, open),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(open).not.toHaveBeenCalled();
  },
);

test('startup cancels only its request and waits for cleanup before reporting timeout', async () => {
  vi.useFakeTimers();
  const registration = registerRequestAbort(req.meta?.requestId);
  const other = registerRequestAbort('other-request');
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  let settled = false;
  try {
    const pending = withOpenStartupDeadline(req, async (timed) => {
      expect(timed.internal?.startupDeadlineAtMs).toBe(Date.now() + 600_000);
      await new Promise<void>((_, reject) =>
        registration?.controller.signal.addEventListener(
          'abort',
          () => reject(registration.controller.signal.reason),
          { once: true },
        ),
      ).catch(async (error) => {
        await cleanup;
        throw error;
      });
      return { ok: true, data: {} };
    }).then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(registration?.controller.signal.aborted).toBe(true);
    expect(other?.controller.signal.aborted).toBe(false);
    expect(settled).toBe(false);
    finishCleanup();
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_FAILED', details: { reason: 'startup_timeout', timeoutMs: 600_000 } },
    });
  } finally {
    clearRequestAbortRegistration(registration);
    clearRequestAbortRegistration(other);
  }
});

test('completed startup clears its timer and preserves the session response', async () => {
  vi.useFakeTimers();
  const registration = registerRequestAbort(req.meta?.requestId);
  try {
    expect(
      await withOpenStartupDeadline(req, async () => ({
        ok: true,
        data: { session: 'cold-start' },
      })),
    ).toEqual({ ok: true, data: { session: 'cold-start' } });
    await vi.advanceTimersByTimeAsync(600_001);
    expect(registration?.controller.signal.aborted).toBe(false);
  } finally {
    clearRequestAbortRegistration(registration);
  }
});

test('startup preserves cleanup failures instead of claiming timeout cleanup succeeded', async () => {
  vi.useFakeTimers();
  const failure = new AppError('COMMAND_FAILED', 'cleanup failed', {
    reason: 'ios_boot_cleanup_failed',
  });
  const pending = withOpenStartupDeadline(req, async () => {
    await new Promise((resolve) => setTimeout(resolve, 600_001));
    throw failure;
  });
  const rejection = expect(pending).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(600_001);
  await rejection;
});
