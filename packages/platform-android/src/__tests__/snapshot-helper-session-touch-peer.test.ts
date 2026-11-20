import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import net from 'node:net';
import { test, vi } from 'vitest';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import {
  getLiveAndroidSnapshotHelperSession,
  retireFailedAndroidSnapshotHelperSession,
  stopAndroidSnapshotHelperSession,
} from '../snapshot-helper-session-lifecycle.ts';
import { isAndroidSnapshotHelperSessionPeerUnverified } from '../snapshot-helper-session-protocol.ts';
import { runAndroidSnapshotHelperSessionTouchCommand } from '../snapshot-helper-session.ts';
import { FIXTURE_SESSION_SECRET, onSessionCommand } from './snapshot-helper-session.fixtures.ts';

vi.mock('../snapshot-helper-session-lifecycle.ts', () => ({
  getLiveAndroidSnapshotHelperSession: vi.fn(),
  retireFailedAndroidSnapshotHelperSession: vi.fn(),
  stopAndroidSnapshotHelperSession: vi.fn(),
}));

const HELPER = { packageName: 'snapshot-helper', runner: 'runner' };

test('an input sent to a listener that cannot prove the secret falls back before any command byte', async () => {
  // Another process bound the session's socket name after the helper exited: it answers, but not
  // with a proof of the secret the session holds.
  const received: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('data', (chunk) => received.push(chunk.toString('utf8')));
    socket.once('data', () => socket.end(`${'00'.repeat(32)} ${'11'.repeat(32)}\n`));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  vi.mocked(getLiveAndroidSnapshotHelperSession).mockResolvedValue({
    helper: HELPER,
    port: address.port,
    secret: Buffer.alloc(32, 5),
  } as NonNullable<Awaited<ReturnType<typeof getLiveAndroidSnapshotHelperSession>>>);
  const typed = Buffer.from(JSON.stringify({ kind: 'fill', text: 'typed secret' })).toString(
    'base64',
  );
  try {
    const headers = await runAndroidSnapshotHelperSessionTouchCommand({
      deviceKey: 'android:emulator-touch-peer',
      action: 'input',
      helper: HELPER,
      payloadBase64: typed,
      timeoutMs: 2_000,
    });
    // `undefined` sends this call down the one-shot path; the session is retired with a backoff.
    assert.equal(headers, undefined);
    assert.equal(vi.mocked(retireFailedAndroidSnapshotHelperSession).mock.calls.length, 1);
    assert.match(received.join(''), /^[0-9a-f]{64}\n$/);
    assert.equal(received.join('').includes(typed), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function listenOnce(onSocket: (socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return { port: address.port, close };
}

test.each([
  { label: 'a refused connection', closedBeforeConnect: true },
  { label: 'a socket that closes before the hello', closedBeforeConnect: false },
])('$label is a transport failure, not an unverified peer', async ({ closedBeforeConnect }) => {
  vi.clearAllMocks();
  const listener = await listenOnce((socket) => socket.destroy());
  if (closedBeforeConnect) await listener.close();
  vi.mocked(getLiveAndroidSnapshotHelperSession).mockResolvedValue({
    helper: HELPER,
    port: listener.port,
    secret: Buffer.alloc(32, 5),
  } as NonNullable<Awaited<ReturnType<typeof getLiveAndroidSnapshotHelperSession>>>);
  try {
    const outcome = await runAndroidSnapshotHelperSessionTouchCommand({
      deviceKey: 'android:emulator-touch-transport',
      action: 'viewport',
      helper: HELPER,
      timeoutMs: 2_000,
    }).catch((error: unknown) => error);
    // The transport failure reaches the caller as before; it earns no unverified-peer backoff.
    assert.ok(outcome instanceof Error, `expected a transport failure, got ${String(outcome)}`);
    if (closedBeforeConnect) assert.match(JSON.stringify(normalizeError(outcome)), /ECONNREFUSED/);
    assert.equal(isAndroidSnapshotHelperSessionPeerUnverified(outcome), false);
    assert.equal(vi.mocked(retireFailedAndroidSnapshotHelperSession).mock.calls.length, 0);
    assert.equal(vi.mocked(stopAndroidSnapshotHelperSession).mock.calls.length, 1);
  } finally {
    if (!closedBeforeConnect) await listener.close();
  }
});

const SECRET = Buffer.alloc(32, 5);

function serverProof(clientNonce: string, serverNonce: string): string {
  return createHmac('sha256', SECRET)
    .update(`agent-device-session-server|${clientNonce}${serverNonce}`)
    .digest('hex');
}

function liveSessionOn(port: number, secret = SECRET): void {
  vi.mocked(getLiveAndroidSnapshotHelperSession).mockResolvedValue({
    helper: HELPER,
    port,
    secret,
  } as NonNullable<Awaited<ReturnType<typeof getLiveAndroidSnapshotHelperSession>>>);
}

test.each([
  { label: 'a hello longer than one nonce and one proof', extra: ` ${'a'.repeat(200)}` },
  { label: 'a hello with a third field', extra: ' x' },
])('$label is refused even with a valid proof', async ({ extra }) => {
  vi.clearAllMocks();
  const received: string[] = [];
  const serverNonce = 'ef'.repeat(32);
  const listener = await listenOnce((socket) => {
    socket.on('data', (chunk) => received.push(chunk.toString('utf8')));
    socket.once('data', (chunk) => {
      const clientNonce = chunk.toString('utf8').trim();
      socket.write(`${serverNonce} ${serverProof(clientNonce, serverNonce)}${extra}\n`);
    });
  });
  liveSessionOn(listener.port);
  try {
    const headers = await runAndroidSnapshotHelperSessionTouchCommand({
      deviceKey: 'android:emulator-touch-hello',
      action: 'input',
      helper: HELPER,
      payloadBase64: Buffer.from('{"kind":"key","keyCode":4}').toString('base64'),
      timeoutMs: 2_000,
    });
    assert.equal(headers, undefined);
    assert.match(received.join(''), /^[0-9a-f]{64}\n$/);
  } finally {
    await listener.close();
  }
});

test.each([
  { label: 'before the hello', proveHello: false, dispatched: 'no' },
  { label: 'after a proven hello', proveHello: true, dispatched: 'unknown' },
])(
  'an input timeout $label discloses dispatched=$dispatched',
  async ({ proveHello, dispatched }) => {
    vi.clearAllMocks();
    const listener = await listenOnce((socket) => {
      // The fixture helper proves the secret and then never answers the command.
      if (proveHello) onSessionCommand(socket, () => {});
    });
    liveSessionOn(listener.port, Buffer.from(FIXTURE_SESSION_SECRET, 'hex'));
    try {
      const outcome = await runAndroidSnapshotHelperSessionTouchCommand({
        deviceKey: 'android:emulator-touch-timeout',
        action: 'input',
        helper: HELPER,
        payloadBase64: Buffer.from('{"kind":"key","keyCode":4}').toString('base64'),
        timeoutMs: 100,
      }).catch((error: unknown) => error);
      assert.ok(outcome instanceof AppError);
      assert.equal(outcome.details?.dispatched, dispatched);
    } finally {
      await listener.close();
    }
  },
);
