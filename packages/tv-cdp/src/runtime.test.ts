import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';

import type { DeviceLease } from '@agent-device/contracts/device';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { bindProviderSnapshotInteractor } from '@agent-device/contracts/snapshot-runtime';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { afterEach, test, vi } from 'vitest';

import { NAVIGATION_KEYS } from './keys.ts';
import { createTvRuntime } from './runtime.ts';
import type { SnapshotCapture } from './snapshot.ts';
import type { TvConnection } from './tv.ts';

const APP_ID = 'com.example.app';
const VIEWPORT = { width: 1920, height: 1080 };
const FRAME = Buffer.from('png frame');

const CAPTURE: SnapshotCapture = {
  title: 'Example',
  truncated: false,
  // The DOM walk gives every node it keeps a rect.
  nodes: [
    { index: 0, depth: 0, type: 'main', label: 'Home' },
    { index: 1, depth: 1, parentIndex: 0, type: 'section', label: 'Settings' },
    { index: 2, depth: 2, parentIndex: 1, type: 'button', label: 'Sound', hittable: true },
    { index: 3, depth: 1, parentIndex: 0, type: 'section', label: 'Library' },
    { index: 4, depth: 2, parentIndex: 3, type: 'button', label: 'Movies', hittable: true },
    { index: 5, depth: 2, parentIndex: 3, type: 'p', label: 'New this week' },
  ].map((node) => ({ ...node, rect: { x: 0, y: 0, width: 200, height: 40 } })),
  covers: {
    4: { type: 'dialog', label: 'Sign in', rect: { x: 0, y: 0, width: 1920, height: 1080 } },
  },
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function lease(leaseId: string): DeviceLease {
  return {
    leaseId,
    tenantId: 'tenant',
    runId: 'run',
    backend: 'android-instance',
    leaseProvider: 'webos',
    createdAt: 0,
    heartbeatAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const length =
    payload.length < 126
      ? Buffer.from([payload.length])
      : payload.length < 65_536
        ? Buffer.from([126, payload.length >> 8, payload.length & 0xff])
        : Buffer.concat([Buffer.from([127]), bigEndian64(payload.length)]);
  return Buffer.concat([Buffer.from([0x81]), length, payload]);
}

function bigEndian64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function readMaskedFrame(buffer: Buffer): { text: string; opcode: number; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!;
  return {
    text: payload.toString('utf8'),
    opcode: buffer[0]! & 0x0f,
    rest: buffer.subarray(offset + 4 + length),
  };
}

// Lists the app page while it runs, records every CDP call, and answers each with an empty
// result, except the readiness, viewport, visibility and snapshot reads and the screenshot.
async function fakePage() {
  const sockets = new Set<Duplex>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let running = true;
  let loaded = true;
  let visibility = 'visible';
  let readinessChecks = 0;
  const evaluated = (expression: string) => {
    if (expression.includes('readyState')) {
      readinessChecks += 1;
      return loaded;
    }
    if (expression === '({ width: innerWidth, height: innerHeight })') return VIEWPORT;
    if (expression === 'document.visibilityState') return visibility;
    return CAPTURE;
  };
  const answer = (method: string, params: Record<string, unknown>) => {
    if (method === 'Page.captureScreenshot') return { data: FRAME.toString('base64') };
    if (method !== 'Runtime.evaluate') return {};
    return { result: { value: evaluated(String(params.expression ?? '')) } };
  };
  const server = createServer((_request, response) => {
    const target = { title: APP_ID, url: `http://tv/${APP_ID}/`, webSocketDebuggerUrl: page.url };
    response.end(JSON.stringify(running ? [target] : []));
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let read = readMaskedFrame(pending); read; read = readMaskedFrame(pending)) {
        pending = read.rest;
        if (read.opcode === 0x8) return void socket.end();
        const { id, method, params = {} } = JSON.parse(read.text);
        calls.push({ method, params });
        socket.write(frame(JSON.stringify({ id, result: answer(method, params) })));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const page = {
    url: `ws://127.0.0.1:${address.port}/devtools/page/1`,
    calls,
    drop: () => {
      for (const socket of sockets) socket.destroy();
    },
    exitApp: () => {
      running = false;
    },
    keepLoading: () => {
      loaded = false;
    },
    hide: () => {
      visibility = 'hidden';
    },
    readinessChecks: () => readinessChecks,
    close: async () => {
      page.drop();
      server.close();
      await once(server, 'close');
    },
  };
  cleanups.push(page.close);
  return page;
}

type FakeTvOptions = Readonly<{
  onConnect?: () => Promise<unknown>;
  onLaunch?: () => Promise<unknown>;
  removal?: () => Promise<void>;
  appClose?: () => Promise<void>;
}>;

// One physical TV that answers to any requested name, as an IP and IP:port reach the same Tizen TV.
async function tvRuntime(options: FakeTvOptions = {}) {
  const {
    onConnect = async () => undefined,
    onLaunch = async () => undefined,
    removal = async () => undefined,
    appClose = async () => undefined,
  } = options;
  const page = await fakePage();
  const tunnel = { closed: 0, onClose: [] as (() => void)[] };
  const signals = {
    close: [] as (AbortSignal | undefined)[],
    listApps: [] as (AbortSignal | undefined)[],
  };
  const tv = (requested: string | undefined): TvConnection => ({
    id: 'tv-1',
    name: requested ?? 'living-room',
    launch: async (appId) => {
      await onLaunch();
      return {
        target: { title: appId, url: `http://tv/${appId}/`, webSocketDebuggerUrl: page.url },
        onClose: (listener) => tunnel.onClose.push(listener),
        close: async () => {
          tunnel.closed++;
          await removal();
        },
      };
    },
    close: async (_appId, closeOptions) => {
      signals.close.push(closeOptions?.signal);
      await appClose();
    },
    listApps: async (listOptions) => {
      signals.listApps.push(listOptions?.signal);
      return [{ id: APP_ID, name: 'Example' }];
    },
  });
  const { runtime, platformModule } = createTvRuntime(
    {
      provider: 'webos',
      label: 'webOS',
      remoteKeys: NAVIGATION_KEYS,
      connectTv: async (requested) => {
        await onConnect();
        return tv(requested);
      },
    },
    { createError: (code, message, details) => new AppError(code, message, details) },
  );
  cleanups.push(runtime.shutdown);
  const allocated = await runtime.leaseLifecycle.allocate(lease('lease-a'));
  assert.ok(allocated);
  return { runtime, platformModule, device: allocated.device, page, tunnel, signals };
}

async function openedTv() {
  const opened = await tvRuntime();
  await opened.runtime.getInteractor(opened.device)!.open(APP_ID);
  return opened;
}

const noAttachedApp = (error: unknown) =>
  error instanceof AppError && /No webOS app is attached/.test(error.message);

test('a second lease on a held TV is refused with DEVICE_IN_USE', async () => {
  const { runtime } = await tvRuntime();

  await assert.rejects(
    runtime.leaseLifecycle.allocate(lease('lease-b')),
    (error: unknown) => error instanceof AppError && error.code === 'DEVICE_IN_USE',
  );
});

test('a lease that names the held TV by another alias is refused with DEVICE_IN_USE', async () => {
  const { runtime, device } = await tvRuntime();

  const second = runtime.leaseLifecycle.allocate(lease('lease-b'), {
    flags: { device: '192.0.2.10:26101' },
  });

  await assert.rejects(second, (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'DEVICE_IN_USE');
    return true;
  });
  assert.equal(device.id, 'webos:tv-1');
  assert.equal(device.name, 'living-room');
});

test('the leased device keeps the requested name and resolves to the TV session by its identity', async () => {
  const { runtime } = await tvRuntime();
  await runtime.leaseLifecycle.release(lease('lease-a'));

  const allocated = await runtime.leaseLifecycle.allocate(lease('lease-b'), {
    flags: { device: '192.0.2.10' },
  });

  assert.equal(allocated?.device.name, '192.0.2.10');
  assert.equal(allocated?.device.id, 'webos:tv-1');
  assert.ok(runtime.getInteractor(allocated.device));
});

test('a tunnel that cannot be removed fails close with the removal error', async () => {
  const { runtime, device } = await tvRuntime({
    removal: async () => {
      throw new AppError('COMMAND_FAILED', 'forward --remove failed');
    },
  });
  await runtime.getInteractor(device)!.open(APP_ID);

  await assert.rejects(runtime.getInteractor(device)!.close!(APP_ID), {
    message: 'forward --remove failed',
  });
});

test('a close that fails with its tunnel removal keeps its own error and names the removal', async () => {
  const { runtime, device } = await tvRuntime({
    removal: async () => {
      throw new AppError('COMMAND_FAILED', 'forward --remove failed');
    },
    appClose: async () => {
      throw new AppError('COMMAND_FAILED', 'was_kill failed');
    },
  });
  await runtime.getInteractor(device)!.open(APP_ID);

  await assert.rejects(runtime.getInteractor(device)!.close!(APP_ID), {
    message: 'was_kill failed',
    details: { tunnelRemoval: 'forward --remove failed' },
  });
});

test('a cancelled open stops waiting for the previous tunnel removal', async () => {
  const pending: (() => void)[] = [];
  const { runtime, device } = await tvRuntime({
    removal: () => new Promise((resolve) => pending.push(() => resolve())),
  });
  await runtime.getInteractor(device)!.open(APP_ID);
  const cancel = new AbortController();
  cancel.abort();

  const reopening = runtime.getInteractor(device, cancel.signal)!.open(APP_ID);

  await assert.rejects(reopening, isRequestCanceledError);
  assert.ok(pending.length > 0);
  for (const finish of pending) finish();
});

test('a runtime that is shutting down refuses new leases', async () => {
  const { runtime } = await tvRuntime();

  await runtime.shutdown();

  await assert.rejects(runtime.leaseLifecycle.allocate(lease('lease-b')), {
    code: 'COMMAND_FAILED',
    message: 'The webOS runtime is shutting down',
  });
});

test('a lease whose TV connects after shutdown starts is refused and never listed', async () => {
  let connecting = Promise.resolve();
  const { runtime } = await tvRuntime({ onConnect: () => connecting });
  let connected = () => {};
  connecting = new Promise((resolve) => {
    connected = resolve;
  });
  const allocating = runtime.leaseLifecycle.allocate(lease('lease-b'));

  await runtime.shutdown();
  connected();

  await assert.rejects(allocating, {
    code: 'COMMAND_FAILED',
    message: 'The webOS runtime is shutting down',
  });
  assert.equal(
    await runtime.deviceInventoryProvider({ leaseProvider: 'webos', leaseId: 'lease-b' }),
    null,
  );
});

test('a tunnel lost in the background that cannot be removed fails the lease release', async () => {
  const { runtime, device, tunnel } = await tvRuntime({
    removal: async () => {
      throw new AppError('COMMAND_FAILED', 'forward --remove failed');
    },
  });
  await runtime.getInteractor(device)!.open(APP_ID);
  for (const listener of tunnel.onClose) listener();

  await assert.rejects(runtime.leaseLifecycle.release(lease('lease-a')), {
    message: 'forward --remove failed',
  });
});

test('a cancelled open closes the tunnel it opened', async () => {
  const { runtime, device, tunnel } = await tvRuntime();
  const cancel = new AbortController();
  cancel.abort();

  await assert.rejects(
    runtime.getInteractor(device, cancel.signal)!.open(APP_ID),
    isRequestCanceledError,
  );

  assert.equal(tunnel.closed, 1);
});

test('releasing the lease closes the tunnel and forgets the TV session', async () => {
  const { runtime, device, tunnel } = await openedTv();

  await runtime.leaseLifecycle.release(lease('lease-a'));

  assert.equal(tunnel.closed, 1);
  assert.equal(runtime.getInteractor(device), undefined);
  assert.ok(await runtime.leaseLifecycle.allocate(lease('lease-b')));
});

test('a page whose socket closes is detached, so commands ask for open again', async () => {
  const { runtime, device, page, tunnel } = await openedTv();

  page.drop();
  await vi.waitFor(() => assert.equal(tunnel.closed, 1));

  await assert.rejects(runtime.getInteractor(device)!.snapshot(), noAttachedApp);
});

test('an app that exits behind an open tunnel is detached once its target is gone', async () => {
  const { runtime, device, page, tunnel } = await openedTv();

  page.exitApp();
  await vi.waitFor(() => assert.equal(tunnel.closed, 1), { timeout: 5000 });

  await assert.rejects(runtime.getInteractor(device)!.snapshot(), noAttachedApp);
});

test('a tunnel that goes down detaches the page', async () => {
  const { runtime, device, tunnel } = await openedTv();

  for (const listener of tunnel.onClose) listener();

  await assert.rejects(runtime.getInteractor(device)!.snapshot(), noAttachedApp);
});

test('a lease released while open is in flight leaves no tunnel behind', async () => {
  let releaseLease = async (): Promise<unknown> => undefined;
  const { runtime, device, tunnel } = await tvRuntime({ onLaunch: () => releaseLease() });
  releaseLease = () => runtime.leaseLifecycle.release(lease('lease-a'));

  await assert.rejects(runtime.getInteractor(device)!.open(APP_ID), /lease ended/);

  assert.equal(tunnel.closed, 1);
});

test('a lease released while the page loads ends open with the lease error and no tunnel', async () => {
  const { runtime, device, page, tunnel } = await tvRuntime();
  page.keepLoading();
  const opening = runtime.getInteractor(device)!.open(APP_ID);
  await vi.waitFor(() => assert.ok(page.readinessChecks() > 0));

  await runtime.leaseLifecycle.release(lease('lease-a'));

  await assert.rejects(opening, /lease ended/);
  assert.equal(tunnel.closed, 1);
});

test('filling an empty value selects the field contents and deletes them with Backspace', async () => {
  const { runtime, device, page } = await openedTv();
  page.calls.length = 0;

  await runtime.getInteractor(device)!.fill(100, 20, '');

  const steps = page.calls.flatMap(({ method, params }) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes('select()')) {
      return ['select'];
    }
    if (method === 'Input.dispatchKeyEvent') return [`${params.type} ${params.key}`];
    if (method === 'Input.insertText') return ['insertText'];
    return [];
  });
  assert.deepEqual(steps, ['select', 'keyDown Backspace', 'keyUp Backspace']);
});

async function capturedNodes(options: Readonly<{ scope?: string; interactiveOnly?: boolean }>) {
  const { runtime, device } = await openedTv();
  const operations = bindProviderSnapshotInteractor({
    device,
    signal: new AbortController().signal,
    resolveInteractor: () => runtime.getInteractor(device),
  });
  const result = await operations.captureSnapshot({ options });
  assert.ok('nodes' in result);
  return result.nodes ?? [];
}

async function capturedLabels(options: Readonly<{ scope?: string; interactiveOnly?: boolean }>) {
  return (await capturedNodes(options)).map((node) => node.label);
}

test('a scoped capture through the provider snapshot binding returns only that subtree', async () => {
  assert.deepEqual(await capturedLabels({ scope: 'Settings' }), ['Settings', 'Sound']);
});

test('an interactive-only capture drops text-only nodes and keeps the ancestors of controls', async () => {
  assert.deepEqual(await capturedLabels({ interactiveOnly: true }), [
    'Home',
    'Settings',
    'Sound',
    'Library',
    'Movies',
  ]);
});

const tempFile = (name: string) => path.join(mkdtempForTestSync('tv-cdp-'), name);

const mouseEvents = (page: { calls: { method: string; params: Record<string, unknown> }[] }) =>
  page.calls
    .filter((call) => call.method === 'Input.dispatchMouseEvent')
    .map((call) => call.params);

test('a scroll sends one mouse wheel at the viewport centre, by the requested share of its height', async () => {
  const { runtime, device, page } = await openedTv();
  page.calls.length = 0;

  await runtime.getInteractor(device)!.scroll('down', { amount: 0.5 });

  assert.deepEqual(mouseEvents(page), [
    { type: 'mouseWheel', x: 960, y: 540, deltaX: 0, deltaY: 540 },
  ]);
});

test('a scroll in a container wheels at its centre by the exact pixel distance', async () => {
  const { runtime, device, page } = await openedTv();
  page.calls.length = 0;

  await runtime.getInteractor(device)!.scroll('left', {
    pixels: 120,
    containerRect: { x: 100, y: 200, width: 400, height: 300 },
  });

  assert.deepEqual(mouseEvents(page), [
    { type: 'mouseWheel', x: 300, y: 350, deltaX: -120, deltaY: 0 },
  ]);
});

test('a screenshot writes the captured PNG frame to the requested path', async () => {
  const { runtime, device } = await openedTv();
  const outPath = tempFile('tv.png');

  await runtime.getInteractor(device)!.screenshot(outPath);

  assert.deepEqual(readFileSync(outPath), FRAME);
});

test('a screenshot of a hidden page fails at once and asks to open the app again', async () => {
  const { runtime, device, page } = await openedTv();
  page.hide();

  await assert.rejects(
    runtime.getInteractor(device)!.screenshot(tempFile('tv.png')),
    (error: unknown) =>
      error instanceof AppError &&
      /in the background/.test(error.message) &&
      error.details?.hint === `Bring it back with open ${APP_ID}.`,
  );
});

test('tap, long press and focus press and release the pointer at the point', async () => {
  const { runtime, device, page } = await openedTv();
  const interactor = runtime.getInteractor(device)!;
  page.calls.length = 0;

  await interactor.tap(10, 20);
  await interactor.longPress(30, 40, 50);
  await interactor.focus(50, 60);

  const presses = mouseEvents(page)
    .filter((event) => event.type !== 'mouseMoved')
    .map((event) => `${event.type} ${event.x},${event.y}`);
  assert.deepEqual(presses, [
    'mousePressed 10,20',
    'mouseReleased 10,20',
    'mousePressed 30,40',
    'mouseReleased 30,40',
    'mousePressed 50,60',
    'mouseReleased 50,60',
  ]);
});

test('hover moves the pointer to the point without pressing, and type inserts the text', async () => {
  const { runtime, device, page } = await openedTv();
  const interactor = runtime.getInteractor(device)!;
  page.calls.length = 0;

  await interactor.hover!(70, 80);
  await interactor.type('hello');

  const events = mouseEvents(page);
  assert.ok(events.every((event) => event.type === 'mouseMoved'));
  assert.deepEqual(events.at(-1), { type: 'mouseMoved', x: 70, y: 80 });
  assert.deepEqual(
    page.calls.filter((call) => call.method === 'Input.insertText').map((call) => call.params),
    [{ text: 'hello' }],
  );
});

test('a remote button sends its key, and one the TV lacks is refused with the supported list', async () => {
  const { runtime, device, page } = await openedTv();
  const interactor = runtime.getInteractor(device)!;
  page.calls.length = 0;

  await interactor.tvRemote!('down');

  assert.deepEqual(
    page.calls
      .filter((call) => call.method === 'Input.dispatchKeyEvent')
      .map((call) => `${call.params.type} ${call.params.key}`),
    ['keyDown ArrowDown', 'keyUp ArrowDown'],
  );
  await assert.rejects(
    interactor.back(),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      Array.isArray(error.details?.supported) &&
      error.details.supported.includes('select'),
  );
});

const scope: PlatformRequestScope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

// Test-only trust boundary: the TV binding reads no host facet until a log command runs, so every
// facet answers with an operation that fails.
function unusedRuntimeHost(): PlatformRuntimeHost {
  const fail = async (): Promise<never> => {
    throw new Error('unused');
  };
  const facet = new Proxy({}, { get: () => fail });
  return new Proxy({}, { get: () => facet }) as PlatformRuntimeHost;
}

async function boundTv() {
  const opened = await openedTv();
  const owner = await opened.platformModule.loadRuntime(unusedRuntimeHost());
  const binding = await owner.bind({ device: opened.device, intent: { kind: 'ordinary' }, scope });
  return { ...opened, binding };
}

test('the platform binding lists the TV apps and reports the attached app while it is visible', async () => {
  const { binding, device, page } = await boundTv();

  assert.deepEqual(await binding.operations.listApps?.({ device, filter: 'user-installed' }), [
    { id: APP_ID, name: 'Example' },
  ]);
  assert.deepEqual(await binding.operations.appState?.(), { package: APP_ID });
  page.hide();
  assert.deepEqual(await binding.operations.appState?.(), { package: undefined });
});

test('close and apps hand the request signal to the TV', async () => {
  const { binding, device, runtime, signals } = await boundTv();

  await binding.operations.listApps!({ device, filter: 'user-installed' });
  await runtime.getInteractor(device, scope.signal)!.close!(APP_ID);

  assert.deepEqual(signals.listApps, [scope.signal]);
  assert.deepEqual(signals.close, [scope.signal]);
});

test('the platform binding asks for connect once the lease that held the TV is gone', async () => {
  const { binding, device, runtime } = await boundTv();

  await runtime.leaseLifecycle.release(lease('lease-a'));

  await assert.rejects(
    binding.operations.listApps!({ device, filter: 'user-installed' }),
    (error: unknown) =>
      error instanceof AppError &&
      /has no active session/.test(error.message) &&
      error.details?.hint === 'Run connect webos, then open <appId>.',
  );
});

test('a control a tap would miss is marked covered by what the page hit, and stays interactive', async () => {
  const nodes = await capturedNodes({ interactiveOnly: true });

  const movies = nodes.find((node) => node.label === 'Movies');
  assert.equal(movies?.hittable, false);
  assert.equal(movies?.interactionBlocked, 'covered');
  assert.deepEqual(movies?.coveredBy, {
    kind: 'dialog',
    label: 'Sign in',
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
  });
  assert.equal(nodes.find((node) => node.label === 'Sound')?.interactionBlocked, undefined);
});
