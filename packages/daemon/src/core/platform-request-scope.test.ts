import { expect, test, vi } from 'vitest';
import {
  clearRequestAbortRegistration,
  getRequestSignal,
  registerRequestAbort,
  withRequestDeadline,
} from '@agent-device/host-kit/request';
import { createPlatformRequestScope } from './platform-request-scope.ts';

test('a copied platform scope reads an earlier nested execution cutoff installed after construction', async () => {
  vi.useFakeTimers();
  const requestId = 'live-platform-scope-cutoff';
  const registration = registerRequestAbort(requestId);
  const scope = createPlatformRequestScope({
    token: 'token',
    session: 'default',
    command: 'batch',
    positionals: [],
    meta: { requestId },
  });
  const copied = { ...scope };
  try {
    await expect(
      withRequestDeadline(
        requestId,
        1_000,
        async () =>
          await withRequestDeadline(requestId, 100, async () => {
            vi.setSystemTime(Date.now() + 99);
            copied.checkDeadline?.();
            expect(getRequestSignal(requestId)?.aborted).toBe(false);
            vi.setSystemTime(Date.now() + 1);
            expect(getRequestSignal(requestId)?.aborted).toBe(false);
            copied.checkDeadline?.();
            expect.fail('scope captured an absent or later cutoff');
          }),
      ),
    ).rejects.toMatchObject({
      details: {
        reason: 'daemon_request_timeout',
        causeReason: 'request_canceled',
        timeoutMs: 100,
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});
