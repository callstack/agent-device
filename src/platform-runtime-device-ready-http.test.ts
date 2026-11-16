import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmd: vi.fn(),
}));

import { runCmd } from '@agent-device/host-kit/command';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  ANDROID_EMULATOR,
  bindTestCommandHost,
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createDaemonHttpServer } from '../packages/daemon/src/server/http/http-server.ts';
import { createRequestHandler } from '../packages/daemon/src/__tests__/support/test-device-runtime-gateway.ts';
import { forwardingCreateCommandSurface } from '../packages/daemon/src/__tests__/support/command-surface-fake.ts';
import { screenshotRuntimeFixture } from '../packages/daemon/src/__tests__/support/screenshot-runtime-fixture.ts';
import { makeSessionStore } from '../packages/daemon/src/__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../packages/daemon/src/resources/lease-registry.ts';
import { createDaemonPlatformServices } from './platform-runtime-daemon-services.ts';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

bindTestCommandHost();
const mockRunCmd = vi.mocked(runCmd);
const BOOTED = { stdout: '1\n', stderr: '', exitCode: 0 };
let deviceIndex = 0;

beforeAll(async () => {
  await loadAndroidMechanics();
});
beforeEach(() => {
  mockRunCmd.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function route() {
  const device = { ...ANDROID_EMULATOR, id: `android-http-readiness-${++deviceIndex}` };
  const runtime = screenshotRuntimeFixture();
  const readClipboard = vi.fn(async () => 'ready clipboard');
  const gateway = {
    ...runtime.gateway,
    inspectFacts: async (target: typeof device) => {
      const facts = await runtime.gateway.inspectFacts(target);
      return {
        ...facts,
        operations: { ...facts.operations, readClipboard: { available: true as const } },
      };
    },
    bind: async (request: Parameters<typeof runtime.gateway.bind>[0]) => {
      const binding = await runtime.gateway.bind(request);
      return {
        ...binding,
        facts: await gateway.inspectFacts(request.device),
        operations: { ...binding.operations, readClipboard },
      };
    },
  };
  const host = createTestHostEnvironment();
  const handle = createRequestHandler({
    host,
    token: 'readiness-token',
    logPath: path.join(mkdtempForTestSync('android-http-readiness-'), 'daemon.log'),
    sessionStore: makeSessionStore('android-http-readiness-sessions-'),
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways({ local: async () => [device] }),
    deviceRuntimeGateway: gateway,
    platformServices: createDaemonPlatformServices(),
    createCommandSurface: forwardingCreateCommandSurface,
    trackDownloadableArtifact: () => 'unused',
  });
  const responses: DaemonResponse[] = [];
  const completed = deferred<DaemonResponse>();
  const server = await createDaemonHttpServer({
    token: 'readiness-token',
    env: host.env,
    cwd: host.cwd,
    handleRequest: async (request) => {
      const response = await handle(request);
      responses.push(response);
      completed.resolve(response);
      return response;
    },
  });
  const disconnected = deferred<void>();
  server.once('connection', (socket) => socket.once('close', () => disconnected.resolve()));
  const port = await listenOnLoopback(server);
  function send(command: 'snapshot' | 'clipboard', bounded = false) {
    const step = {
      command,
      positionals: command === 'clipboard' ? ['read'] : [],
      flags: { platform: 'android', serial: device.id },
    };
    const closed = deferred<void>();
    const answer = deferred<DaemonResponse>();
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: { authorization: 'Bearer readiness-token', 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            result?: DaemonResponse;
            error?: { data: Extract<DaemonResponse, { ok: false }>['error'] };
          };
          answer.resolve(body.result ?? { ok: false, error: body.error!.data });
        });
      },
    );
    request.on('error', () => closed.resolve());
    request.on('close', () => closed.resolve());
    request.setTimeout(1_000, () =>
      request.destroy(new Error('HTTP readiness request did not settle')),
    );
    request.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: `readiness-${deviceIndex}-${responses.length}`,
        method: 'agent_device.command',
        params: bounded ? { command: 'batch', flags: { batchSteps: [step] } } : step,
      }),
    );
    return { request, closed: closed.promise, answer: answer.promise };
  }
  return {
    server,
    send,
    completed: completed.promise,
    disconnected: disconnected.promise,
    runtime,
    readClipboard,
  };
}

for (const command of ['snapshot', 'clipboard'] as const) {
  test(`${command}: caller disconnect aborts Android getprop through real HTTP admission`, async () => {
    const { server, send, completed, disconnected, runtime, readClipboard } = await route();
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
      call.request.destroy();
      await call.closed;
      await disconnected;
      expect(abortedIo, 'caller abort must stop the in-flight getprop I/O').toBe(true);
    } finally {
      release.resolve(BOOTED);
      await completed;
      await closeLoopbackServer(server);
    }
    expect(await completed).toMatchObject({
      ok: false,
      error: { details: { reason: 'request_canceled' } },
    });
    expect(runtime.captureSnapshot).not.toHaveBeenCalled();
    expect(readClipboard).not.toHaveBeenCalled();
    expect(mockRunCmd).toHaveBeenCalledTimes(1);
  });

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
      await closeLoopbackServer(server);
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
      await closeLoopbackServer(server);
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
      await closeLoopbackServer(server);
    }
  });
}
