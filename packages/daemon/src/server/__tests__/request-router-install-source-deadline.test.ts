import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { afterEach, test, vi, type Mock } from 'vitest';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import type {
  AppDeploymentResult,
  MaterializedAppSource,
} from '@agent-device/contracts/app-deployment-runtime';
import {
  type DeviceBinding,
  type DeviceBindingRequest,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  localRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  createUnavailableRuntimeFactsForTest,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import {
  clearRequestAbortRegistration,
  emitRequestProgress,
  getRequestSignal,
  markRequestCanceled,
  registerRequestAbort,
} from '@agent-device/host-kit/request';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { startRpcServer } from './http-server-rpc.fixtures.ts';

// #4441 (decisions 6827686874/6856998913): the real-route proof for the descriptor candidate —
// a source-install request admitted over loopback HTTP/RPC ingress, routed by the real request
// router, executed through the normal provider-backed source-install path (only the provider
// gateway seam is faked), under a controlled clock. The daemon must enforce the 570 s
// source-install deadline from admission: typed `daemon_request_timeout` error, no late success
// on the wire, cleanup after the answer (including after already-received response headers on
// the streaming route), and refusal of task entry when an earlier registered cutoff has passed.

const TOKEN = 'install-source-deadline-token';
const START_MS = 1_800_000_000_000;
/** The descriptor candidate's source-install daemon deadline: 600 s envelope less the 30 s margin. */
const SOURCE_DEADLINE_MS = 570_000;

const ANDROID_DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel 8',
  kind: 'emulator',
  booted: true,
};

// Captured before any test fakes the clock: loopback socket I/O must never depend on fake timers.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function withRealGuard<T>(pending: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof realSetTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error('loopback I/O did not complete in time')), ms);
  });
  return Promise.race([pending, guard]).finally(() => {
    if (timer !== undefined) realClearTimeout(timer);
  });
}

async function flushIO(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => realSetTimeout(r, 0));
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2_000; i += 1) {
    if (cond()) return;
    await new Promise((r) => realSetTimeout(r, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function answeredYet(pending: Promise<unknown>): Promise<boolean> {
  let answered = false;
  void pending.then(
    () => {
      answered = true;
    },
    () => {
      answered = true;
    },
  );
  await flushIO();
  return answered;
}

type RpcAnswer = { status: number; body: Record<string, any> };

async function postRpc(port: number, rawBody: string): Promise<RpcAnswer> {
  return await withRealGuard(
    new Promise<RpcAnswer>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/rpc',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(rawBody);
    }),
  );
}

/** A streaming POST whose response headers are observable before the body finishes. */
function postRpcStream(
  port: number,
  rawBody: string,
): {
  headersReceived: Promise<{ status: number; contentType: string | undefined }>;
  bodyDone: Promise<{ bodyText: string }>;
} {
  let resolveHeaders!: (headers: { status: number; contentType: string | undefined }) => void;
  const headersReceived = new Promise<{ status: number; contentType: string | undefined }>(
    (resolve) => {
      resolveHeaders = resolve;
    },
  );
  const bodyDone = withRealGuard(
    new Promise<{ bodyText: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/rpc',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          resolveHeaders({
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type'],
          });
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ bodyText: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(rawBody);
    }),
  );
  return { headersReceived, bodyDone };
}

function installSourceRpcBody(requestId: string, extraMeta: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: requestId,
    method: 'agent_device.command',
    params: {
      command: 'install_source',
      session: 'default',
      meta: {
        requestId,
        installSource: { kind: 'url', url: 'https://example.com/app.zip' },
        ...extraMeta,
      },
    },
  });
}

function installSourceRequest(requestId: string): DaemonRequest {
  return {
    token: TOKEN,
    session: 'default',
    command: 'install_source',
    positionals: [],
    flags: {},
    meta: { requestId, installSource: { kind: 'url', url: 'https://example.com/app.zip' } },
  };
}

type ProviderSpies = {
  inspectFacts: Mock<(device: DeviceInfo) => Promise<RuntimeFacts<PlatformRuntimeOperations>>>;
  bind: Mock<(request: DeviceBindingRequest) => Promise<DeviceBinding<PlatformRuntimeOperations>>>;
  ensureReady: Mock<PlatformRuntimeOperations['ensureReady']>;
  materializeAppSource: Mock<PlatformRuntimeOperations['materializeAppSource']>;
  deployMaterializedApp: Mock<PlatformRuntimeOperations['deployMaterializedApp']>;
  /** The request scope's signal, captured when the router binds the device. */
  scopeSignal: AbortSignal | undefined;
};

/**
 * The provider seam: a device runtime gateway whose binding admits readiness, materialization
 * and deployment. Everything else on the gateway is the unavailable-facts fixture, so the only
 * mocked seam is the provider/approval boundary the trust policy allows tests to fake.
 * The materialization factory receives a getter for the request scope's abort signal, which the
 * real bound operation gets through its binding scope.
 */
function makeProviderGateway(
  materializeFactory: (
    currentSignal: () => AbortSignal | undefined,
  ) => PlatformRuntimeOperations['materializeAppSource'],
): {
  gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  spies: ProviderSpies;
} {
  const spies: ProviderSpies = {
    inspectFacts: vi.fn(),
    bind: vi.fn(),
    ensureReady: vi.fn(async () => ({ ...ANDROID_DEVICE, booted: true })),
    materializeAppSource: vi.fn(materializeFactory(() => spies.scopeSignal)),
    deployMaterializedApp: vi.fn(async (): Promise<AppDeploymentResult> => ({
      packageName: 'com.example.app',
      appName: 'Example App',
      launchTarget: 'com.example.app',
    })),
    scopeSignal: undefined,
  };
  const admittedFacts = (device: DeviceInfo) => {
    const base = createUnavailableRuntimeFactsForTest(device, localRuntimeOwner(device.platform));
    const available = { available: true as const };
    return {
      ...base,
      operations: {
        ...base.operations,
        ensureReady: available,
        materializeAppSource: available,
        deployMaterializedApp: available,
      },
    };
  };
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: async (device) => {
      spies.inspectFacts(device);
      return admittedFacts(device);
    },
    bind: async (request) => {
      const { device, scope } = request;
      spies.bind(request);
      spies.scopeSignal = scope.signal;
      return {
        device,
        owner: localRuntimeOwner(device.platform),
        facts: admittedFacts(device),
        operations: {
          ensureReady: spies.ensureReady,
          materializeAppSource: spies.materializeAppSource,
          deployMaterializedApp: spies.deployMaterializedApp,
        },
        [Symbol.asyncDispose]: async () => {},
      };
    },
    shutdown: async () => {},
  };
  return { gateway, spies };
}

/** A real request router over a session bound to the fixture Android device. */
function makeRouterHarness(gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>) {
  const sessionStore = makeSessionStore('agent-device-install-source-deadline-');
  sessionStore.publish('default', {
    name: 'default',
    createdAt: START_MS,
    actions: [],
    device: ANDROID_DEVICE,
  });
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: TOKEN,
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
    deviceRuntimeGateway: gateway,
  });
  return { sessionStore, handler };
}

/** A provider materialization that observes the request signal, as a real bound operation does. */
function abortOnSignalMaterialize(
  currentSignal: () => AbortSignal | undefined,
): PlatformRuntimeOperations['materializeAppSource'] {
  const op: PlatformRuntimeOperations['materializeAppSource'] = (_input) =>
    new Promise<MaterializedAppSource>((_resolve, reject) => {
      const signal = currentSignal();
      assert.ok(signal, 'the bound materialization must receive the request signal');
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  return op;
}

afterEach(() => {
  vi.useRealTimers();
});

test('loopback RPC install_source enforces the 570s daemon deadline with a typed error and releases the request', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { gateway, spies } = makeProviderGateway((getSignal) =>
    abortOnSignalMaterialize(getSignal),
  );
  const harness = makeRouterHarness(gateway);

  const { port, server } = await startRpcServer(TOKEN, harness.handler);
  try {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const requestId = 'req-install-source-570-timeout';
    const answer = postRpc(port, installSourceRpcBody(requestId));
    await waitFor(
      () => spies.materializeAppSource.mock.calls.length > 0,
      'the provider materialization to start',
    );

    // One millisecond before the deadline there is still no answer.
    await vi.advanceTimersByTimeAsync(SOURCE_DEADLINE_MS - 1);
    assert.equal(await answeredYet(answer), false, 'answered before the 570s deadline');

    // At exactly 570s from admission the router's deadline owner expires the request.
    await vi.advanceTimersByTimeAsync(1);
    const { status, body } = await withRealGuard(answer);
    assert.equal(status, 500);
    assert.equal(body.error.data.code, 'COMMAND_FAILED');
    assert.equal(body.error.data.details.reason, 'daemon_request_timeout');
    assert.equal(body.error.data.details.timeoutMs, SOURCE_DEADLINE_MS);
    assert.equal(body.error.data.details.requestId, requestId);
    assert.equal(body.result, undefined, 'no success result on the wire');
    assert.equal(
      spies.deployMaterializedApp.mock.calls.length,
      0,
      'deployment must not run after the timeout',
    );
    assert.equal(
      getRequestSignal(requestId),
      undefined,
      'the request registration must be released once the answer is on the wire',
    );
  } finally {
    await closeLoopbackServer(server);
    vi.useRealTimers();
  }
});

test('an install_source whose work crosses the 570s cutoff mid-task gets the typed error, no success, and artifact cleanup', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const cleanupSpy = vi.fn(async () => {});
  let releaseMaterialization!: (value: MaterializedAppSource) => void;
  const materialization = new Promise<MaterializedAppSource>((resolve) => {
    releaseMaterialization = resolve;
  });
  // Materialization succeeds just before the cutoff; the provider's deployment observes the
  // request signal, so the work that crosses the cutoff is aborted, not delivered.
  let signalGetter: () => AbortSignal | undefined = () => undefined;
  const { gateway, spies } = makeProviderGateway((getSignal) => {
    signalGetter = getSignal;
    return () => materialization;
  });
  // The binding reads the spy at bind time, so replacing it before the request installs the
  // signal-observing deployment on the provider seam.
  spies.deployMaterializedApp = vi.fn(
    () =>
      new Promise<AppDeploymentResult>((_resolve, reject) => {
        const signal = signalGetter();
        assert.ok(signal, 'the bound deployment must receive the request signal');
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const { handler } = makeRouterHarness(gateway);

  const { port, server } = await startRpcServer(TOKEN, handler);
  try {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const requestId = 'req-install-source-crosses-cutoff';
    const answer = postRpc(port, installSourceRpcBody(requestId));
    await waitFor(
      () => spies.materializeAppSource.mock.calls.length > 0,
      'the provider materialization to start',
    );

    // Materialize completes 10s before the deadline; deployment then blocks on the signal.
    await vi.advanceTimersByTimeAsync(SOURCE_DEADLINE_MS - 10_000);
    releaseMaterialization({ installablePath: '/tmp/materialized/app.apk', cleanup: cleanupSpy });
    await flushIO();
    await waitFor(() => spies.deployMaterializedApp.mock.calls.length > 0, 'deployment to start');
    assert.equal(await answeredYet(answer), false, 'no answer before the 570s deadline');

    await vi.advanceTimersByTimeAsync(10_000);
    const { status, body } = await withRealGuard(answer);
    assert.equal(status, 500);
    assert.equal(body.error?.data?.details?.reason, 'daemon_request_timeout');
    assert.equal(body.error?.data?.details?.timeoutMs, SOURCE_DEADLINE_MS);
    assert.equal(body.result, undefined, 'no late success on the wire');
    assert.equal(
      cleanupSpy.mock.calls.length,
      1,
      'the materialized artifact is cleaned up after the cutoff',
    );
    assert.equal(getRequestSignal(requestId), undefined, 'registration released after the answer');
  } finally {
    await closeLoopbackServer(server);
    vi.useRealTimers();
  }
});

test('streaming install_source sends response headers first and still answers the 570s expiry in-stream with cleanup', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { gateway, spies } = makeProviderGateway((getSignal) => {
    const op = abortOnSignalMaterialize(getSignal);
    // A real source download reports progress while it runs; the first progress write is what
    // flushes the stream's response headers to the client before the handler's work finishes.
    const wrapped: PlatformRuntimeOperations['materializeAppSource'] = (input) => {
      emitRequestProgress({ type: 'command', status: 'progress', message: 'downloading app.zip' });
      return op(input);
    };
    return wrapped;
  });
  const { handler } = makeRouterHarness(gateway);

  const { port, server } = await startRpcServer(TOKEN, handler);
  try {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const requestId = 'req-install-source-stream-timeout';
    const stream = postRpcStream(
      port,
      installSourceRpcBody(requestId, { requestProgress: 'command' }),
    );
    await waitFor(
      () => spies.materializeAppSource.mock.calls.length > 0,
      'the provider materialization to start',
    );

    // The streaming route writes its response headers before the handler's work finishes.
    const headers = await withRealGuard(stream.headersReceived);
    assert.equal(headers.status, 200);
    assert.match(String(headers.contentType), /application\/x-ndjson/);

    await vi.advanceTimersByTimeAsync(SOURCE_DEADLINE_MS);
    const { bodyText } = await withRealGuard(stream.bodyDone);
    const envelopes = bodyText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>);
    const final = envelopes.at(-1);
    assert.equal(final?.type, 'response');
    assert.equal(final.response.error.data.details.reason, 'daemon_request_timeout');
    assert.equal(final.response.error.data.details.timeoutMs, SOURCE_DEADLINE_MS);
    assert.equal(final.response.result, undefined);
    assert.equal(
      getRequestSignal(requestId),
      undefined,
      'the lifetime is released after the streamed answer, even with headers already sent',
    );
  } finally {
    await closeLoopbackServer(server);
    vi.useRealTimers();
  }
});

test('an install_source whose earlier registered result deadline already passed is refused before task entry', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
  const { gateway, spies } = makeProviderGateway(() => async () => ({
    installablePath: '/tmp/materialized/app.apk',
    cleanup: async () => {},
  }));
  const { handler } = makeRouterHarness(gateway);
  const requestId = 'req-install-source-expired-at-admission';
  // The admitting transport's own registration (beginRpcRequestLifetime.admit), standing for a
  // request admitted 570s in the past whose result deadline (admittedAt + 570s) has passed.
  const registration = registerRequestAbort(requestId, undefined, {
    resultDeadlineMs: START_MS - 1,
  });
  try {
    await vi.advanceTimersByTimeAsync(1);
    const response = await handler(installSourceRequest(requestId));
    assert.equal(response.ok, false);
    if (response.ok) return;
    assert.equal(response.error.code, 'COMMAND_FAILED');
    assert.equal(response.error.details?.reason, 'daemon_request_timeout');
    assert.equal(response.error.details?.timeoutMs, SOURCE_DEADLINE_MS);
    assert.equal(
      spies.inspectFacts.mock.calls.length,
      0,
      'fact inspection must not run when entry is refused',
    );
    assert.equal(
      spies.materializeAppSource.mock.calls.length,
      0,
      'the provider task must not start when entry is refused',
    );
    assert.equal(getRequestSignal(requestId)?.aborted, true);
  } finally {
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});

test('an earlier result deadline aborts a running source install before deployment', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
  const resultBudgetMs = 60_000;
  const { gateway, spies } = makeProviderGateway((getSignal) =>
    abortOnSignalMaterialize(getSignal),
  );
  const { handler } = makeRouterHarness(gateway);
  const requestId = 'req-install-source-earlier-caller';
  const registration = registerRequestAbort(requestId, undefined, {
    resultDeadlineMs: START_MS + resultBudgetMs,
  });
  const answer = handler(installSourceRequest(requestId));
  try {
    await waitFor(
      () => spies.materializeAppSource.mock.calls.length === 1,
      'the provider materialization to start',
    );
    await vi.advanceTimersByTimeAsync(resultBudgetMs - 1);
    assert.equal(spies.scopeSignal?.aborted, false, 'work is still admitted before the cutoff');

    await vi.advanceTimersByTimeAsync(2);
    assert.equal(
      spies.scopeSignal?.aborted,
      true,
      'the earlier result deadline aborts active work',
    );
    const response = await withRealGuard(answer);
    assert.equal(response.ok, false);
    if (response.ok) return;
    assert.equal(response.error.details?.reason, 'daemon_request_timeout');
    assert.equal(spies.deployMaterializedApp.mock.calls.length, 0);
  } finally {
    markRequestCanceled(requestId);
    await withRealGuard(answer).catch(() => {});
    clearRequestAbortRegistration(registration);
    vi.useRealTimers();
  }
});

test('ordinary install_source over loopback RPC succeeds end to end (benign control)', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const cleanupSpy = vi.fn(async () => {});
  const { gateway, spies } = makeProviderGateway(() => async () => ({
    installablePath: '/tmp/materialized/app.apk',
    cleanup: cleanupSpy,
  }));
  const { handler } = makeRouterHarness(gateway);
  const { port, server } = await startRpcServer(TOKEN, handler);
  try {
    const requestId = 'req-install-source-ok';
    const { status, body } = await postRpc(port, installSourceRpcBody(requestId));
    assert.equal(status, 200);
    assert.equal(body.error, undefined);
    assert.equal(body.result.ok, true);
    assert.equal(body.result.data.packageName, 'com.example.app');
    assert.equal(body.result.data.launchTarget, 'com.example.app');
    assert.equal(spies.materializeAppSource.mock.calls.length, 1);
    assert.equal(spies.deployMaterializedApp.mock.calls.length, 1);
    assert.equal(cleanupSpy.mock.calls.length, 1);
    assert.equal(getRequestSignal(requestId), undefined);
  } finally {
    await closeLoopbackServer(server);
  }
});
