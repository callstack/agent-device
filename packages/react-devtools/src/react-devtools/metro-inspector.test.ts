import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import {
  debuggerUrlOn,
  InspectorSession,
  listMetroInspectorTargets,
  selectReactNativeTarget,
  type MetroInspectorTarget,
} from './metro-inspector.ts';

function target(id: string, extra: Partial<MetroInspectorTarget> = {}): MetroInspectorTarget {
  return {
    id,
    title: 'React Native',
    webSocketDebuggerUrl: `ws://127.0.0.1:8081/inspector/debug?page=${id}`,
    reactNative: { logicalDeviceId: id.slice(0, id.lastIndexOf('-')) },
    ...extra,
  };
}

test('the main runtime wins over worklet runtimes and later pages on the same device', () => {
  const selected = selectReactNativeTarget([
    target('pixel-2', { appId: 'com.app', description: 'React Native Bridge' }),
    target('pixel-1', { appId: 'com.app', description: 'React Native Bridge' }),
    target('pixel-3', { appId: 'com.app', description: 'Reanimated UI runtime [C++ connection]' }),
  ]);
  assert.equal(selected.id, 'pixel-1');
});

test('auxiliary pages without React Native metadata are never profiled', () => {
  assert.throws(
    () =>
      selectReactNativeTarget([
        { id: 'legacy-1', title: 'Hermes', webSocketDebuggerUrl: 'ws://x' },
      ]),
    /No React Native runtime is connected/,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('one app on several devices fails closed until --metro-device names one', () => {
  const targets = [
    target('ipad-1', { appId: 'com.app', deviceName: 'iPad Air' }),
    target('pixel-1', { appId: 'com.app', deviceName: 'Pixel 9' }),
    target('pixel-2', { appId: 'com.app', deviceName: 'Pixel 9' }),
  ];
  assert.throws(
    () => selectReactNativeTarget(targets),
    (error: { code: string; details: { hint: string } }) => {
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.details.hint, 'Pass --metro-device with one of: iPad Air, Pixel 9.');
      return true;
    },
  );
  assert.equal(selectReactNativeTarget(targets, { device: 'Pixel 9' }).id, 'pixel-1');
  assert.equal(selectReactNativeTarget(targets, { device: 'ipad' }).id, 'ipad-1');
});

test('devices that share a name are listed by a key --metro-device can select', () => {
  const targets = [
    target('sim-a-1', { appId: 'com.app', deviceName: 'iPhone 17' }),
    target('sim-b-1', { appId: 'com.app', deviceName: 'iPhone 17' }),
    target('pixel-1', { appId: 'com.app', deviceName: 'Pixel 9' }),
  ];
  const hint = (filter?: { device: string }) => {
    try {
      selectReactNativeTarget(targets, filter);
    } catch (error) {
      return (error as { details: { hint: string } }).details.hint;
    }
    return undefined;
  };
  assert.equal(hint(), 'Pass --metro-device with one of: sim-a, sim-b, Pixel 9.');
  assert.equal(hint({ device: 'iPhone 17' }), 'Pass --metro-device with one of: sim-a, sim-b.');
  assert.equal(selectReactNativeTarget(targets, { device: 'sim-b' }).id, 'sim-b-1');
});

test('devices without a logical id are told apart by their target ids, not their names', () => {
  const targets = [
    target('sim-a-1', { appId: 'com.app', deviceName: 'iPhone 17', reactNative: {} }),
    target('sim-b-1', { appId: 'com.app', deviceName: 'iPhone 17', reactNative: {} }),
  ];

  assert.throws(
    () => selectReactNativeTarget(targets),
    (error: { details: { hint: string } }) =>
      error.details.hint === 'Pass --metro-device with one of: sim-a, sim-b.',
  );
  assert.equal(selectReactNativeTarget(targets, { device: 'sim-a' }).id, 'sim-a-1');
});

test('distinct apps need --app; older dev servers report the app id as the description', () => {
  const targets = [
    target('a-1', { appId: 'com.one' }),
    target('b-1', { description: 'com.two', title: 'React Native Bridgeless [C++ connection]' }),
  ];
  assert.throws(
    () => selectReactNativeTarget(targets),
    (error: { code: string; details: { hint: string } }) => {
      assert.equal(error.code, 'INVALID_ARGS');
      assert.equal(error.details.hint, 'Pass --app with one of: com.one, com.two.');
      return true;
    },
  );
  assert.equal(selectReactNativeTarget(targets, { appId: 'com.two' }).id, 'b-1');
  assert.throws(
    () => selectReactNativeTarget(targets, { appId: 'com.three' }),
    /No matching React Native runtime/,
  );
});

test('an unreachable dev server names the address it tried', async () => {
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(
    listMetroInspectorTargets(new URL('http://localhost:8081')),
    /Could not reach the React Native dev server at http:\/\/localhost:8081/,
  );
});

test('a server that is not a dev server is named instead of yielding no targets', async () => {
  vi.stubGlobal('fetch', async () => new Response('<html></html>', { status: 200 }));
  await assert.rejects(
    listMetroInspectorTargets(new URL('http://localhost:8081')),
    /is not a React Native dev server/,
  );
});

type Frame = { opcode: number; payload: Buffer };

function readFrame(buffer: Buffer): { frame: Frame; rest: Buffer } | null {
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
    frame: { opcode: buffer[0]! & 0x0f, payload },
    rest: buffer.subarray(offset + 4 + length),
  };
}

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

/** Loopback inspector endpoint answering `Runtime.evaluate` through `respond`. */
async function inspectorServer(
  respond: (message: { id: number; params: { expression: string } }) => unknown,
) {
  const sockets = new Set<Duplex>();
  const origins: Array<string | undefined> = [];
  const server = createServer((_req, res) => res.end());
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    origins.push(req.headers.origin);
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let read = readFrame(pending); read; read = readFrame(pending)) {
        pending = read.rest;
        if (read.frame.opcode === 0x8) {
          socket.end();
          return;
        }
        const message = JSON.parse(read.frame.payload.toString('utf8'));
        const reply = respond(message);
        if (reply !== undefined)
          socket.write(textFrame(JSON.stringify({ id: message.id, ...(reply as object) })));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `ws://127.0.0.1:${address.port}/inspector/debug?page=1`,
    port: address.port,
    origins,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

test('the session sends a loopback Origin and returns evaluated values', async () => {
  const server = await inspectorServer((message) => ({
    result: { result: { value: `echo:${message.params.expression}` } },
  }));
  try {
    const session = await InspectorSession.connect(server.url);
    assert.equal(await session.evaluate('1 + 1'), 'echo:1 + 1');
    session.close();
    assert.deepEqual(server.origins, [`http://127.0.0.1:${server.port}`]);
  } finally {
    await server.close();
  }
});

test('an exception inside the app becomes a command failure with the thrown description', async () => {
  const server = await inspectorServer(() => ({
    result: {
      result: {},
      exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } },
    },
  }));
  try {
    const session = await InspectorSession.connect(server.url);
    await assert.rejects(
      session.evaluate('boom()'),
      (error: { message: string; cause: unknown }) => {
        assert.equal(error.message, 'The profiler runtime threw inside the app.');
        assert.equal(error.cause, 'TypeError: boom');
        return true;
      },
    );
    session.close();
  } finally {
    await server.close();
  }
});

test('a dropped connection rejects the pending evaluation', async () => {
  let drop: (() => void) | undefined;
  const server = await inspectorServer(() => {
    drop?.();
    return undefined;
  });
  try {
    const session = await InspectorSession.connect(server.url);
    drop = () => void server.close();
    await assert.rejects(session.evaluate('wait()'), /closed the debugger connection/);
  } finally {
    await server.close().catch(() => {});
  }
});

test('the debugger socket is opened on the server that listed the target', () => {
  const target = {
    id: 'device-1',
    title: 'app',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=d1&page=1',
  };
  assert.equal(
    debuggerUrlOn(new URL('http://10.0.2.2:8081'), target),
    'ws://10.0.2.2:8081/inspector/debug?device=d1&page=1',
  );
  assert.equal(
    debuggerUrlOn(new URL('https://bridge.example.test/api/metro/runtimes/r1/'), target),
    'wss://bridge.example.test/api/metro/runtimes/r1/inspector/debug?device=d1&page=1',
  );
});
