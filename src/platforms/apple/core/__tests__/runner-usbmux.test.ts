import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net, { type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { createUsbmuxRunnerTransport } from '../runner/runner-usbmux.ts';

const DEVICE_UDID = '00008020-001C2D2234567890';
const USBMUX_DEVICE_ID = 42;
const RUNNER_PORT = 51_234;
const openServers: Server[] = [];
const socketDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    socketDirectories
      .splice(0)
      .map(async (directory) => await fs.rm(directory, { force: true, recursive: true })),
  );
});

test('xctest runner commands use usbmux device lookup and port transport', async () => {
  const socketPath = await createSocketPath();
  const { done: serverDone } = await createFakeUsbmuxd(
    socketPath,
    async (socket, connectionIndex) => {
      if (connectionIndex === 0) {
        const request = await readPacket(socket);
        assert.match(request, /<string>ListDevices<\/string>/);
        socket.end(
          buildPacket(
            `<plist><dict><key>DeviceList</key><array><dict>
            <key>DeviceID</key><integer>${USBMUX_DEVICE_ID}</integer>
            <key>Properties</key><dict>
              <key>SerialNumber</key><string>${DEVICE_UDID}</string>
            </dict>
          </dict></array></dict></plist>`,
          ),
        );
        return;
      }

      const connectRequest = await readPacket(socket);
      assert.match(connectRequest, /<string>Connect<\/string>/);
      assert.match(
        connectRequest,
        new RegExp(`<key>DeviceID</key><integer>${USBMUX_DEVICE_ID}</integer>`),
      );
      assert.match(
        connectRequest,
        new RegExp(`<key>PortNumber</key><integer>${hostToNetworkPort(RUNNER_PORT)}</integer>`),
      );
      socket.write(
        buildPacket(
          '<plist><dict><key>MessageType</key><string>Result</string><key>Number</key><integer>0</integer></dict></plist>',
        ),
      );

      const requestBody = await readHttpRequestBody(socket);
      assert.deepEqual(JSON.parse(requestBody), {
        command: 'uptime',
        commandId: 'runner-usbmux-test',
      });
      const body = JSON.stringify({ ok: true, data: { uptimeMs: 123 } });
      socket.end(
        [
          'HTTP/1.1 200 OK',
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      );
    },
  );

  const response = await createUsbmuxRunnerTransport(socketPath).postCommand(
    DEVICE_UDID,
    RUNNER_PORT,
    { command: 'uptime', commandId: 'runner-usbmux-test' },
    2_000,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, data: { uptimeMs: 123 } });
  await serverDone;
});

async function createSocketPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-usbmux-test-'));
  const socketPath = path.join(directory, 'usbmuxd.sock');
  socketDirectories.push(directory);
  return socketPath;
}

async function createFakeUsbmuxd(
  socketPath: string,
  handleConnection: (socket: Socket, connectionIndex: number) => Promise<void>,
): Promise<{ done: Promise<void> }> {
  let connectionIndex = 0;
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const server = net.createServer((socket) => {
    const currentIndex = connectionIndex++;
    handleConnection(socket, currentIndex).then(() => {
      if (currentIndex === 1) resolveDone();
    }, rejectDone);
  });
  server.on('error', rejectDone);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  openServers.push(server);
  return { done };
}

async function readPacket(socket: Socket): Promise<string> {
  const packet = await readUntil(socket, (buffer) => {
    if (buffer.length < 16) return undefined;
    const length = buffer.readUInt32LE(0);
    return buffer.length >= length ? buffer.subarray(16, length) : undefined;
  });
  return packet.toString('utf8');
}

function buildPacket(xml: string): Buffer {
  const payload = Buffer.from(xml, 'utf8');
  const packet = Buffer.alloc(16 + payload.length);
  packet.writeUInt32LE(packet.length, 0);
  packet.writeUInt32LE(1, 4);
  packet.writeUInt32LE(8, 8);
  packet.writeUInt32LE(1, 12);
  payload.copy(packet, 16);
  return packet;
}

async function readHttpRequestBody(socket: Socket): Promise<string> {
  const body = await readUntil(socket, (buffer) => {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return undefined;
    const headers = buffer.subarray(0, headerEnd).toString('utf8');
    const contentLength = Number(/^content-length:\s*(\d+)$/im.exec(headers)?.[1]);
    const bodyStart = headerEnd + 4;
    return buffer.length >= bodyStart + contentLength
      ? buffer.subarray(bodyStart, bodyStart + contentLength)
      : undefined;
  });
  return body.toString('utf8');
}

async function readUntil(
  socket: Socket,
  select: (buffer: Buffer) => Buffer | undefined,
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const selected = select(buffer);
      if (!selected) return;
      cleanup();
      resolve(selected);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

function hostToNetworkPort(port: number): number {
  return ((port & 0xff) << 8) | ((port >>> 8) & 0xff);
}
