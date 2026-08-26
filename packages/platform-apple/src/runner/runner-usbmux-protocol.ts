import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import net, { type Socket } from 'node:net';
import { escapeXmlTextAndAttribute, parseXmlDocumentSync, type XmlNode } from '@agent-device/xml';
import { Deadline } from './host.ts';

const USBMUX_HEADER_BYTES = 16;
const USBMUX_PROTOCOL_VERSION = 1;
const USBMUX_MESSAGE_PLIST = 8;
const USBMUX_MAX_PACKET_BYTES = 4 * 1024 * 1024;
/**
 * usbmuxd `Connect` result codes, confirmed against the daemon on macOS 15:
 * connecting to a closed port on an attached device answers 3, and connecting
 * with a DeviceID usbmuxd does not know answers 2.
 */
const USBMUX_RESULT_OK = 0;
const USBMUX_RESULT_BAD_DEVICE = 2;
const USBMUX_RESULT_CONNECTION_REFUSED = 3;

const USBMUX_DEVICE_UNATTACHED_HINT =
  'Connect the device by cable, trust this Mac, keep it unlocked, and retry.';

export async function openUsbmuxRunnerSocket(
  socketPath: string,
  udid: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Socket> {
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const deviceId = await resolveUsbmuxDeviceId(socketPath, udid, deadline.remainingMs(), signal);
  return await openUsbmuxDeviceSocket(
    socketPath,
    udid,
    deviceId,
    port,
    deadline.remainingMs(),
    signal,
  );
}

async function resolveUsbmuxDeviceId(
  socketPath: string,
  udid: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number> {
  const socket = await connectUsbmuxd(socketPath, timeoutMs, signal);
  try {
    await writePlistPacket(socket, 1, buildPlistMessage('ListDevices'));
    const packet = await readUsbmuxPacket(socket, timeoutMs, signal);
    const deviceId = readDeviceIdFromList(packet.payload.toString('utf8'), udid);
    if (deviceId !== undefined) return deviceId;
    throw new AppError('DEVICE_NOT_FOUND', 'iOS device is not available through usbmux', {
      deviceId: udid,
      backend: 'xctest',
      // Discriminator for the usbmux-first route: usbmuxd answered and the
      // device is simply not attached by cable, so a CoreDevice-backed device
      // can fall back to its network tunnel instead of retrying this transport.
      usbmuxDeviceAttached: false,
      hint: USBMUX_DEVICE_UNATTACHED_HINT,
    });
  } finally {
    socket.destroy();
  }
}

async function openUsbmuxDeviceSocket(
  socketPath: string,
  udid: string,
  deviceId: number,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Socket> {
  const socket = await connectUsbmuxd(socketPath, timeoutMs, signal);
  try {
    await writePlistPacket(
      socket,
      2,
      buildPlistMessage('Connect', {
        DeviceID: deviceId,
        PortNumber: hostToNetworkPort(port),
      }),
    );
    const packet = await readUsbmuxPacket(socket, timeoutMs, signal);
    const result = readPlistInteger(packet.payload.toString('utf8'), 'Number');
    if (result !== USBMUX_RESULT_OK) {
      throw buildUsbmuxConnectError({ result, udid, deviceId, port });
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function connectUsbmuxd(
  socketPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Socket> {
  requireTimeRemaining(timeoutMs, 'connect to usbmuxd');
  if (signal?.aborted) throw createRequestCanceledError();
  return await new Promise<Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new AppError('COMMAND_FAILED', 'Timed out connecting to usbmuxd', {
          backend: 'xctest',
          socketPath,
          timeoutMs,
        }),
      );
    }, timeoutMs);
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(createRequestCanceledError());
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function writePlistPacket(socket: Socket, tag: number, payload: string): Promise<void> {
  const body = Buffer.from(payload, 'utf8');
  const packet = Buffer.alloc(USBMUX_HEADER_BYTES + body.length);
  packet.writeUInt32LE(packet.length, 0);
  packet.writeUInt32LE(USBMUX_PROTOCOL_VERSION, 4);
  packet.writeUInt32LE(USBMUX_MESSAGE_PLIST, 8);
  packet.writeUInt32LE(tag, 12);
  body.copy(packet, USBMUX_HEADER_BYTES);
  if (socket.write(packet)) return;
  await new Promise<void>((resolve, reject) => {
    socket.once('drain', resolve);
    socket.once('error', reject);
  });
}

async function readUsbmuxPacket(
  socket: Socket,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ payload: Buffer }> {
  requireTimeRemaining(timeoutMs, 'read usbmuxd response');
  if (signal?.aborted) throw createRequestCanceledError();
  return await new Promise<{ payload: Buffer }>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(
      () =>
        finish(
          new AppError('COMMAND_FAILED', 'Timed out reading usbmuxd response', {
            backend: 'xctest',
            timeoutMs,
          }),
        ),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < USBMUX_HEADER_BYTES) return;
      const packetBytes = buffer.readUInt32LE(0);
      if (packetBytes < USBMUX_HEADER_BYTES || packetBytes > USBMUX_MAX_PACKET_BYTES) {
        finish(new AppError('COMMAND_FAILED', 'Invalid usbmuxd response length'));
        return;
      }
      if (buffer.length < packetBytes) return;
      finish(undefined, { payload: buffer.subarray(USBMUX_HEADER_BYTES, packetBytes) });
    };
    const onError = (error: Error) => finish(error);
    const onClose = () =>
      finish(new AppError('COMMAND_FAILED', 'usbmuxd closed the connection unexpectedly'));
    const onAbort = () => finish(createRequestCanceledError());
    const finish = (error?: Error, packet?: { payload: Buffer }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      socket.pause();
      if (error) reject(error);
      else resolve(packet as { payload: Buffer });
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.resume();
  });
}

function buildPlistMessage(
  messageType: string,
  fields: Record<string, string | number> = {},
): string {
  const entries: Array<[string, string | number]> = [
    ['BundleID', 'com.callstack.agent-device'],
    ['ClientVersionString', 'agent-device'],
    ['MessageType', messageType],
    ['ProgName', 'agent-device'],
    ['kLibUSBMuxVersion', 3],
    ...Object.entries(fields),
  ];
  const body = entries
    .map(([key, value]) =>
      typeof value === 'number'
        ? `<key>${escapeXmlTextAndAttribute(key)}</key><integer>${value}</integer>`
        : `<key>${escapeXmlTextAndAttribute(key)}</key><string>${escapeXmlTextAndAttribute(value)}</string>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${body}</dict></plist>`;
}

function readDeviceIdFromList(xml: string, udid: string): number | undefined {
  for (const node of walkXmlNodes(parseXmlDocumentSync(xml))) {
    const device = readListedDevice(node);
    if (device?.udid === udid) return device.id;
  }
  return undefined;
}

function readListedDevice(node: XmlNode): { udid: string; id: number } | undefined {
  if (node.name !== 'dict') return undefined;
  const properties = readDictEntry(node, 'Properties');
  if (properties?.name !== 'dict') return undefined;
  const udid = readDictEntry(properties, 'SerialNumber')?.text;
  const id = Number(readDictEntry(node, 'DeviceID')?.text);
  if (!udid || !Number.isSafeInteger(id) || id <= 0) return undefined;
  return { udid, id };
}

function readPlistInteger(xml: string, key: string): number | undefined {
  for (const node of walkXmlNodes(parseXmlDocumentSync(xml))) {
    if (node.name !== 'dict') continue;
    const value = readDictEntry(node, key);
    if (value?.name !== 'integer') continue;
    const parsed = Number(value.text);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function readDictEntry(dict: XmlNode, key: string): XmlNode | undefined {
  for (let index = 0; index < dict.children.length - 1; index += 1) {
    const entry = dict.children[index];
    if (entry?.name === 'key' && entry.text === key) return dict.children[index + 1];
  }
  return undefined;
}

function* walkXmlNodes(nodes: readonly XmlNode[]): Generator<XmlNode> {
  for (const node of nodes) {
    yield node;
    yield* walkXmlNodes(node.children);
  }
}

/**
 * A device usbmuxd no longer knows is the same verdict as one missing from
 * `ListDevices` — it must reach the unattached path so a CoreDevice device can
 * fall back to its network tunnel, rather than failing with a cable hint while
 * Wi-Fi is available. A refused port means the opposite: the device is there
 * and only the runner is not listening yet.
 */
function buildUsbmuxConnectError(params: {
  result: number | undefined;
  udid: string;
  deviceId: number;
  port: number;
}): AppError {
  const { result, udid, deviceId, port } = params;
  if (result === USBMUX_RESULT_BAD_DEVICE) {
    return new AppError('DEVICE_NOT_FOUND', 'iOS device is no longer available through usbmux', {
      deviceId: udid,
      backend: 'xctest',
      usbmuxDeviceAttached: false,
      usbmuxResult: result,
      hint: USBMUX_DEVICE_UNATTACHED_HINT,
    });
  }
  if (result === USBMUX_RESULT_CONNECTION_REFUSED) {
    return new AppError('COMMAND_FAILED', 'XCTest runner is not listening on the device port', {
      backend: 'xctest',
      deviceId,
      port,
      usbmuxResult: result,
      hint: 'The device is reachable but nothing is bound to the runner port yet; this resolves once the runner finishes starting.',
    });
  }
  return new AppError('COMMAND_FAILED', 'Failed to connect to XCTest runner through usbmux', {
    backend: 'xctest',
    deviceId,
    port,
    usbmuxResult: result,
    hint: 'Keep the device connected by cable and unlocked, then retry.',
  });
}

function hostToNetworkPort(port: number): number {
  return ((port & 0xff) << 8) | ((port >>> 8) & 0xff);
}

function requireTimeRemaining(timeoutMs: number, action: string): void {
  if (timeoutMs > 0) return;
  throw new AppError('COMMAND_FAILED', `No time remaining to ${action}`, {
    backend: 'xctest',
    timeoutMs,
  });
}
