import { promises as fs } from 'node:fs';
import net, { type Server, type Socket } from 'node:net';
import path from 'node:path';
import { mkdtempForTest } from './tmp-dir.ts';

export type FakeDevice = { deviceId: number; udid: string; connectionType?: string };

export async function createSocketPath(socketDirectories: string[]): Promise<string> {
  const directory = await mkdtempForTest('agent-device-usbmux-test-');
  const socketPath = path.join(directory, 'usbmuxd.sock');
  socketDirectories.push(directory);
  return socketPath;
}

export async function createFakeUsbmuxd(
  openServers: Server[],
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

export async function readPacket(socket: Socket): Promise<string> {
  const packet = await readUntil(socket, (buffer) => {
    if (buffer.length < 16) return undefined;
    const length = buffer.readUInt32LE(0);
    return buffer.length >= length ? buffer.subarray(16, length) : undefined;
  });
  return packet.toString('utf8');
}

export function buildPacket(xml: string): Buffer {
  const payload = Buffer.from(xml, 'utf8');
  const packet = Buffer.alloc(16 + payload.length);
  packet.writeUInt32LE(packet.length, 0);
  packet.writeUInt32LE(1, 4);
  packet.writeUInt32LE(8, 8);
  packet.writeUInt32LE(1, 12);
  payload.copy(packet, 16);
  return packet;
}

export async function readHttpRequestBody(socket: Socket): Promise<string> {
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

export function hostToNetworkPort(port: number): number {
  return ((port & 0xff) << 8) | ((port >>> 8) & 0xff);
}

export async function cleanupUsbmuxFixtures(
  openServers: Server[],
  socketDirectories: string[],
): Promise<void> {
  await Promise.all(
    openServers.splice(0).map(async (server) => {
      const closableServer = server as Server & { closeAllConnections?: () => void };
      closableServer.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  await Promise.all(
    socketDirectories
      .splice(0)
      .map(async (directory) => await fs.rm(directory, { force: true, recursive: true })),
  );
}
