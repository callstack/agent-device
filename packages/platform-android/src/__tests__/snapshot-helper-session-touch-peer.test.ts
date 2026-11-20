import assert from 'node:assert/strict';
import net from 'node:net';
import { test, vi } from 'vitest';
import {
  getLiveAndroidSnapshotHelperSession,
  retireFailedAndroidSnapshotHelperSession,
} from '../snapshot-helper-session-lifecycle.ts';
import { runAndroidSnapshotHelperSessionTouchCommand } from '../snapshot-helper-session.ts';

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
