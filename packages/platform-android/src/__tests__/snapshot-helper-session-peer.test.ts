// The session secret binds every connection to the helper this session launched (#4519): a
// forwarded peer that does not hold it cannot dispatch, and a listener that cannot prove it gets no
// command. The fake helper here computes the handshake independently of the host.
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { normalizeError } from '@agent-device/kernel/errors';
import {
  captureAndroidSnapshotWithHelperSession,
  runAndroidSnapshotHelperSessionTouchCommand,
} from '../snapshot-helper-session.ts';
import {
  ensureAndroidSnapshotHelperSession,
  getLiveAndroidSnapshotHelperSession,
  resetAndroidSnapshotHelperSessions,
} from '../snapshot-helper-session-lifecycle.ts';
import {
  isAndroidSnapshotHelperSessionPeerUnverified,
  sendAndroidSnapshotHelperSessionCommand,
} from '../snapshot-helper-session-protocol.ts';
import {
  createSessionProvider,
  FIXTURE_SESSION_SECRET,
} from './snapshot-helper-session.fixtures.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

const DEVICE_KEY = 'android:emulator-peer';

beforeEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetAndroidSnapshotHelperSessions();
});

async function withDebugLog(run: () => Promise<void>): Promise<string> {
  const logPath = path.join(await mkdtempForTest('snapshot-helper-peer-'), 'diagnostics.jsonl');
  await withDiagnosticsScope({ debug: true, logPath }, run);
  return await fs.readFile(logPath, 'utf8').catch(() => '');
}

test('a listener that cannot prove the secret gets no command, and the capture runs one-shot', async () => {
  const received: string[] = [];
  const provider = createSessionProvider({ calls: [], unprovenListener: received });
  let output: Awaited<ReturnType<typeof captureAndroidSnapshotWithHelperSession>> = undefined;
  const log = await withDebugLog(async () => {
    output = await captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: provider,
      deviceKey: DEVICE_KEY,
    });
  });

  // `undefined` is the caller's cue to answer with the one-shot transport.
  assert.equal(output, undefined);
  // The listener saw the client nonce and nothing else: no proof, no command.
  assert.equal(received.length, 1);
  assert.match(received[0]!, /^[0-9a-f]{64}\n$/);
  assert.equal(await getLiveAndroidSnapshotHelperSession(DEVICE_KEY), undefined);
  assert.match(log, /"phase":"android_snapshot_helper_session_peer_unverified"/);
});

test('the session secret appears in no diagnostic and no error', async () => {
  const provider = createSessionProvider({ calls: [] });
  const log = await withDebugLog(async () => {
    const output = await captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: provider,
      deviceKey: DEVICE_KEY,
    });
    // The verified exchange is what proves the host held the secret during this run.
    assert.equal(output?.metadata.transport, 'persistent-session');
  });
  assert.ok(log.length > 0, 'expected session diagnostics to compare against');
  assert.equal(log.includes(FIXTURE_SESSION_SECRET), false);

  // A refused listener's error carries no secret either.
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('data', () => socket.end('not a session hello\n'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    const refusal = await sendAndroidSnapshotHelperSessionCommand(
      { port: address.port, secret: Buffer.from(FIXTURE_SESSION_SECRET, 'hex') },
      'snapshot req-1',
      2_000,
    ).catch((error: unknown) => error);
    assert.ok(isAndroidSnapshotHelperSessionPeerUnverified(refusal));
    assert.equal(JSON.stringify(normalizeError(refusal)).includes(FIXTURE_SESSION_SECRET), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('after a refused peer, touch commands run one-shot until the start backoff ends', async () => {
  const received: string[] = [];
  const spawnArgs: (readonly string[])[] = [];
  const provider = createSessionProvider({ calls: [], spawnArgs, unprovenListener: received });
  const options = { adb: provider.exec, adbProvider: provider, deviceKey: DEVICE_KEY };
  // A gesture warms the session the way the viewport read does, then sends its command.
  const touch = async () => {
    await ensureAndroidSnapshotHelperSession(options);
    return await runAndroidSnapshotHelperSessionTouchCommand({
      deviceKey: DEVICE_KEY,
      action: 'viewport',
      helper: {
        packageName: 'com.callstack.agentdevice.snapshothelper',
        runner: 'com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation',
      },
      timeoutMs: 2_000,
    });
  };

  assert.equal(await touch(), undefined);
  assert.equal(spawnArgs.length, 1);
  assert.equal(received.length, 1, 'the refused listener saw one nonce');

  // Inside the backoff: no new session, no new connection, straight to one-shot.
  assert.equal(await touch(), undefined);
  assert.equal(spawnArgs.length, 1);
  assert.equal(received.length, 1);

  // Once the backoff ends, the session is tried again.
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10 * 60_000);
  assert.equal(await touch(), undefined);
  assert.equal(spawnArgs.length, 2);
});
