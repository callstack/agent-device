import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { emitRequestProgress } from '../../../src/daemon/request-progress.ts';
import { getRequestSignal } from '../../../src/daemon/request-cancel.ts';
import { createDaemonHttpServer } from '../../../src/daemon/server/http-server.ts';
import type { DaemonResponse } from '../../../src/daemon/types.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';

const { abortAllIosRunnerSessions } = vi.hoisted(() => ({
  abortAllIosRunnerSessions: vi.fn(async () => {}),
}));

vi.mock('../../../src/platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/platforms/apple/core/runner/runner-client.ts')
    >();
  return { ...actual, abortAllIosRunnerSessions };
});

afterEach(() => {
  vi.clearAllMocks();
});

test('macOS HTTP snapshot disconnect aborts in-flight Apple runner sessions', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP disconnect coverage')) return;

  const requestId = 'req-http-macos-snapshot-disconnect';
  let resolveHandlerDone: () => void = () => {};
  const handlerDone = new Promise<void>((resolve) => {
    resolveHandlerDone = resolve;
  });
  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (): Promise<DaemonResponse> => {
      emitRequestProgress({
        type: 'command',
        status: 'progress',
        message: 'Starting macOS XCTest runner',
      });
      const signal = getRequestSignal(requestId);
      assert.ok(signal, 'request abort signal should be registered during snapshot');
      await waitForAbort(signal);
      resolveHandlerDone();
      return { ok: true, data: { canceled: true } };
    },
  });

  try {
    const port = await listenOnLoopback(server);
    await Promise.all([
      abortStreamingRpcAfterFirstChunk(port, {
        jsonrpc: '2.0',
        id: 'rpc-macos-snapshot-disconnect',
        method: 'agent_device.command',
        params: {
          command: 'snapshot',
          flags: { platform: 'macos' },
          meta: { requestId, requestProgress: 'command' },
        },
      }),
      handlerDone,
    ]);
    await vi.waitFor(() => {
      expect(abortAllIosRunnerSessions).toHaveBeenCalled();
    });
  } finally {
    await closeLoopbackServer(server);
  }
});

function abortStreamingRpcAfterFirstChunk(
  port: number,
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let sawChunk = false;
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          authorization: 'Bearer provider-scenario-token',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.once('data', () => {
          sawChunk = true;
          res.destroy();
          req.destroy();
        });
        res.on('close', () => (sawChunk ? resolve() : reject(new Error('response closed early'))));
        res.on('error', (error) => (sawChunk ? resolve() : reject(error)));
      },
    );
    req.on('error', (error) => (sawChunk ? resolve() : reject(error)));
    req.end(body);
  });
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
