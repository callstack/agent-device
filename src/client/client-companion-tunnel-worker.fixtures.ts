import crypto from 'node:crypto';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { listenOnLoopback } from '@agent-device/test-kit/loopback';

/**
 * Wire-level doubles for the companion tunnel worker (`src/client/client-companion-tunnel-worker.ts`).
 *
 * The worker speaks raw WebSocket frames over an `http.Server` upgrade, so these helpers encode and
 * decode frames by hand instead of pulling in a WebSocket dependency, and a hand-written parser is
 * the only way a test can observe the close codes the worker sends.
 */

export type CloseFrame = {
  code?: number;
  reason?: string;
};

type ParsedWebSocketFrame = {
  opcode: number;
  payload: Buffer;
  nextOffset: number;
};

/** Companion env `runCompanionTunnelProcessFromEnv` reads, keyed by env name. */
export function companionEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    AGENT_DEVICE_COMPANION_TUNNEL_SERVER_BASE_URL: 'http://127.0.0.1:1',
    AGENT_DEVICE_COMPANION_TUNNEL_BEARER_TOKEN: 'test-token',
    AGENT_DEVICE_COMPANION_TUNNEL_LOCAL_BASE_URL: 'http://127.0.0.1:1',
    AGENT_DEVICE_COMPANION_TUNNEL_REGISTER_PATH: '/api/metro/companion/register',
    AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_TENANT_ID: 'tenant-1',
    AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_RUN_ID: 'run-1',
    AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_LEASE_ID: 'lease-1',
    ...overrides,
  };
}

export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  return Buffer.concat([
    Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]),
    payload,
  ]);
}

export function encodeCloseFrame(code = 1000, reason = ''): Buffer {
  const reasonBuffer = Buffer.from(reason, 'utf8');
  const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
  }
  return Buffer.concat([
    Buffer.from([0x88, 126, payload.length >> 8, payload.length & 0xff]),
    payload,
  ]);
}

function parseWebSocketFrame(pending: Buffer, startOffset: number): ParsedWebSocketFrame | null {
  if (startOffset + 2 > pending.length) return null;

  const first = pending[startOffset]!;
  const second = pending[startOffset + 1]!;
  const opcode = first & 0x0f;
  let offset = startOffset + 2;
  let length = second & 0x7f;

  if (length === 126) {
    if (offset + 2 > pending.length) return null;
    length = pending.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    throw new Error('Large WebSocket frames are not supported in this test.');
  }

  const masked = (second & 0x80) !== 0;
  const maskLength = masked ? 4 : 0;
  if (offset + maskLength + length > pending.length) return null;

  const mask = masked ? pending.subarray(offset, offset + 4) : null;
  offset += maskLength;
  const payload = decodeWebSocketPayload(pending.subarray(offset, offset + length), mask);

  return { opcode, payload, nextOffset: offset + length };
}

function decodeWebSocketPayload(payload: Buffer, mask: Buffer | null): Buffer {
  if (!mask) return payload;

  const decoded = Buffer.from(payload);
  for (let index = 0; index < decoded.length; index += 1) {
    decoded[index]! ^= mask[index % 4]!;
  }
  return decoded;
}

function parseCloseFrame(payload: Buffer): CloseFrame {
  if (payload.length < 2) return {};

  return {
    code: payload.readUInt16BE(0),
    reason: payload.subarray(2).toString('utf8'),
  };
}

function emitWebSocketFrame(
  frame: ParsedWebSocketFrame,
  onText: (text: string) => void,
  onClose?: (frame: CloseFrame) => void,
): void {
  if (frame.opcode === 0x1) {
    onText(frame.payload.toString('utf8'));
    return;
  }
  if (frame.opcode === 0x8 && onClose) {
    onClose(parseCloseFrame(frame.payload));
  }
}

export function attachWebSocketFrameParser(
  socket: NodeJS.WritableStream & NodeJS.EventEmitter,
  onText: (text: string) => void,
  onClose?: (frame: CloseFrame) => void,
): void {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    let offset = 0;
    for (;;) {
      const frame = parseWebSocketFrame(pending, offset);
      if (!frame) break;
      offset = frame.nextOffset;
      emitWebSocketFrame(frame, onText, onClose);
    }
    pending = pending.subarray(offset);
  });
}

export function acceptWebSocketUpgrade(req: http.IncomingMessage, socket: Duplex): boolean {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return false;
  }
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );
  return true;
}

export function writeNotFound(res: http.ServerResponse): void {
  res.writeHead(404);
  res.end('not found');
}

export function writeSuccessfulRegistration(res: http.ServerResponse, bridgePort: number): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ok: true,
      data: { ws_url: `ws://127.0.0.1:${bridgePort}/bridge` },
    }),
  );
}

/**
 * Bridge endpoint serving the companion register call and handing each `/bridge` WebSocket upgrade
 * to the caller. The caller owns the returned server, so teardown stays with the test that listened.
 */
export function createCompanionBridgeServer(
  onRegistration?: (body: Record<string, unknown>) => void,
) {
  let bridgePort = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/metro/companion/register') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        onRegistration?.(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        // The port is only known once listening, and no register call can arrive before that.
        writeSuccessfulRegistration(res, bridgePort);
      });
      return;
    }
    writeNotFound(res);
  });
  const serveBridgeUpgrade = (onBridgeUpgrade: (socket: Duplex) => void) => {
    server.on('upgrade', (req, socket) => {
      if (req.url !== '/bridge' || !acceptWebSocketUpgrade(req, socket)) {
        socket.destroy();
        return;
      }
      onBridgeUpgrade(socket);
    });
  };
  return {
    server,
    listen: async () => {
      bridgePort = await listenOnLoopback(server);
      return bridgePort;
    },
    serveBridgeUpgrade,
  };
}
