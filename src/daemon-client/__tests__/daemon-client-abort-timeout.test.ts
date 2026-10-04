/**
 * #3178: an abort is never a timeout. `handleRequestTimeout` is the one seam that sweeps runner
 * processes and resets the local daemon, so an abort that settles a request must also disarm that
 * request's timeout timer. The seam is mocked here — the subject is the transport's timer
 * discipline, not the sweep — and each case outlives the armed budget, so the assertion proves the
 * timer was cleared rather than merely beaten to the settle.
 *
 * The abort case aborts right after `sendRequest` arms its timer, so the clear is what is tested.
 * The paired no-signal case lets the same budget expire and must reach the mocked seam, which
 * makes the abort case's empty-calls assertion evidence instead of an absent hook: delete the
 * abort path's `clearTimeout` and only the abort case fails.
 */
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { getRequestSignal } from '@agent-device/host-kit/request';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../daemon/daemon-request.ts';
import { createSocketServer, listenNetServer } from '../../daemon/server/transport.ts';
import { sendRequest } from '../daemon-client-transport.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import {
  closeLoopbackServer,
  skipWhenLoopbackUnavailable,
  trackLoopbackSockets,
  type SkippableTestContext,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const { handleRequestTimeoutCalls } = vi.hoisted(() => ({
  handleRequestTimeoutCalls: [] as unknown[],
}));

vi.mock('../daemon-client-timeout.ts', () => ({
  handleRequestTimeout: (params: unknown) => {
    handleRequestTimeoutCalls.push(params);
    return new AppError('COMMAND_FAILED', 'Daemon request timed out', {
      reason: 'daemon_transport_timeout',
    });
  },
}));

const STATE_PATHS = resolveDaemonPaths(mkdtempForTestSync('agent-device-abort-timeout-'));
const TIMEOUT_MS = 15;
// Past the armed budget, so a timer the abort forgot to clear fires inside the case.
const OUTLIVE_MS = 80;

// A request the daemon never answers: the only things that can end it are the client's abort and
// the transport's own budget, which is what makes the timer's fate observable.
function hangingHandler(): DaemonInvokeFn {
  return async (req: DaemonRequest): Promise<DaemonResponse> => {
    const signal = getRequestSignal(req.meta?.requestId);
    return await new Promise<DaemonResponse>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
}

async function runTimerDiscipline(
  t: SkippableTestContext,
  outcome: 'aborted' | 'timed-out',
): Promise<void> {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const aborted = outcome === 'aborted';
  handleRequestTimeoutCalls.length = 0;
  const server = createSocketServer(hangingHandler());
  // The hanging handler never answers, so whichever way the request ends, a failed assertion
  // before that would leave the connection open and `net.Server.close()` would hang the lane.
  const destroySockets = trackLoopbackSockets(server);
  try {
    const port = await listenNetServer(server);
    const controller = new AbortController();
    const request = sendRequest(
      { port, token: 't', pid: 1 },
      {
        token: 't',
        command: 'wait',
        session: 'default',
        positionals: [],
        flags: {},
        meta: { requestId: `req-${outcome}-timeout-timer` },
      },
      'socket',
      STATE_PATHS,
      TIMEOUT_MS,
      aborted ? { signal: controller.signal } : {},
    );
    if (aborted) {
      // `sendRequest` armed the timeout timer synchronously by returning; this abort must disarm it.
      controller.abort();
      await assert.rejects(request, (error: unknown) => isRequestCanceledError(error));
    } else {
      await assert.rejects(
        request,
        (error: unknown) =>
          error instanceof AppError && error.details?.reason === 'daemon_transport_timeout',
      );
      assert.equal(handleRequestTimeoutCalls.length, 1);
    }
    await new Promise((resolve) => setTimeout(resolve, OUTLIVE_MS));
    if (aborted) assert.deepEqual(handleRequestTimeoutCalls, []);
  } finally {
    destroySockets();
    await closeLoopbackServer(server);
  }
}

test('an abort with a timeout armed clears the timer instead of running the timeout path', async (t) => {
  await runTimerDiscipline(t, 'aborted');
});

test('the same budget without a signal reaches the timeout seam', async (t) => {
  await runTimerDiscipline(t, 'timed-out');
});
