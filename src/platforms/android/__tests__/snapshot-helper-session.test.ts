import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test } from 'vitest';
import {
  captureAndroidSnapshotWithHelperSession,
  resetAndroidSnapshotHelperSessions,
  resolveAndroidSnapshotHelperSessionRequestTimeoutMs,
} from '../snapshot-helper.ts';
import type { AndroidAdbExecutor, AndroidAdbProcess, AndroidAdbProvider } from '../adb-executor.ts';

beforeEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

test('returns undefined when persistent sessions are disabled', async () => {
  process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION = '0';
  const calls: string[][] = [];
  const provider = createSessionProvider({ calls });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
  });

  assert.equal(output, undefined);
  assert.deepEqual(calls, []);
});

test('returns undefined when the adb provider cannot spawn a helper process', async () => {
  const calls: string[][] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const output = await captureAndroidSnapshotWithHelperSession({ adb });

  assert.equal(output, undefined);
  assert.deepEqual(calls, []);
});

test('disables repeated persistent session attempts after startup failure', async () => {
  const calls: string[][] = [];
  const spawnArgs: string[][] = [];
  const provider: AndroidAdbProvider = {
    exec: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    spawn: (args) => {
      spawnArgs.push(args);
      const process = new FakeAndroidProcess();
      queueMicrotask(() => process.emitExit(0, null));
      return process;
    },
  };

  const first = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  const second = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(spawnArgs.length, 1);
  assert.equal(calls.filter((args) => args[0] === 'forward').length, 2);
});

test('starts and reuses a persistent Android snapshot helper session', async () => {
  const calls: string[][] = [];
  const spawnArgs: string[][] = [];
  const provider = createSessionProvider({ calls, spawnArgs });

  const first = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    helperVersion: '0.16.2',
    helperVersionCode: 16002,
  });
  const second = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    helperVersion: '0.16.2',
    helperVersionCode: 16002,
  });

  assert.match(first?.xml ?? '', /snapshot 1/);
  assert.equal(first?.metadata.transport, 'persistent-session');
  assert.equal(first?.metadata.sessionReused, false);
  assert.equal(first?.metadata.elapsedMs, 7);
  assert.match(second?.xml ?? '', /snapshot 2/);
  assert.equal(second?.metadata.transport, 'persistent-session');
  assert.equal(second?.metadata.sessionReused, true);
  assert.equal(spawnArgs.length, 1);
  assert.equal(
    calls.filter((args) => args[0] === 'forward' && args[1]?.startsWith('tcp:')).length,
    1,
  );
});

test('allows a persistent session snapshot to use the helper command budget', async () => {
  const calls: string[][] = [];
  const provider = createSessionProvider({ calls, responseDelayMs: 25 });

  assert.equal(
    resolveAndroidSnapshotHelperSessionRequestTimeoutMs({
      timeoutMs: 10,
      commandTimeoutMs: 4_000,
    }),
    4_000,
  );

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    timeoutMs: 10,
    commandTimeoutMs: 4_000,
  });

  assert.match(output?.xml ?? '', /snapshot 1/);
  assert.equal(output?.metadata.transport, 'persistent-session');
  assert.equal(output?.metadata.sessionReused, false);
});

test('caps a persistent session snapshot at the helper command budget', async () => {
  const calls: string[][] = [];
  const provider = createSessionProvider({ calls, responseDelayMs: 50 });

  await assert.rejects(
    () =>
      captureAndroidSnapshotWithHelperSession({
        adb: provider.exec,
        adbProvider: provider,
        deviceKey: 'android:emulator-5554',
        timeoutMs: 10,
        commandTimeoutMs: 20,
      }),
    (error) => {
      assert.equal((error as Error).message, 'Android snapshot helper session request timed out');
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.timeoutMs, 20);
      assert.match(String(details?.command), /^snapshot snapshot-/);
      assert.equal(typeof details?.port, 'number');
      return true;
    },
  );
});

test('restarts the helper session when capture options change', async () => {
  const calls: string[][] = [];
  const spawnArgs: string[][] = [];
  const provider = createSessionProvider({ calls, spawnArgs });

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    waitForIdleTimeoutMs: 25,
  });
  const restarted = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    waitForIdleTimeoutMs: 50,
  });

  assert.equal(restarted?.metadata.sessionReused, false);
  assert.equal(spawnArgs.length, 2);
  assert.equal(
    calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

test('invalidates the helper session after a malformed response', async () => {
  const calls: string[][] = [];
  const provider = createSessionProvider({ calls, responseMode: 'malformed' });

  await assert.rejects(
    () =>
      captureAndroidSnapshotWithHelperSession({
        adb: provider.exec,
        adbProvider: provider,
        deviceKey: 'android:emulator-5554',
      }),
    {
      message: 'Android snapshot helper session returned malformed output',
    },
  );

  assert.equal(
    calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

function createSessionProvider(options: {
  calls: string[][];
  spawnArgs?: string[][];
  responseMode?: 'ok' | 'malformed';
  responseDelayMs?: number;
}): AndroidAdbProvider {
  return {
    exec: async (args) => {
      options.calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    spawn: (args) => {
      options.spawnArgs?.push(args);
      const port = readSessionPort(args);
      const process = new FakeAndroidProcess();
      let snapshotCount = 0;
      const server = net.createServer((socket) => {
        socket.once('data', (chunk) => {
          const command = chunk.toString('utf8').trim();
          const [, requestId = ''] = command.split(/\s+/, 2);
          if (command.startsWith('quit')) {
            socket.end(sessionResponse({ requestId, body: '' }));
            server.close(() => process.emitExit(0, null));
            return;
          }
          if (options.responseMode === 'malformed') {
            socket.end('not a session response');
            return;
          }
          snapshotCount += 1;
          const body = `<hierarchy><node text="snapshot ${snapshotCount}" /></hierarchy>`;
          setTimeout(() => {
            socket.end(
              sessionResponse({
                requestId,
                body,
                metadata: {
                  waitForIdleTimeoutMs: '25',
                  waitForIdleQuietMs: '25',
                  timeoutMs: '5000',
                  maxDepth: '128',
                  maxNodes: '5000',
                  rootPresent: 'true',
                  captureMode: 'interactive-windows',
                  windowCount: '1',
                  nodeCount: '1',
                  truncated: 'false',
                  elapsedMs: '7',
                },
              }),
            );
          }, options.responseDelayMs ?? 0);
        });
      });
      server.listen(port, '127.0.0.1', () => {
        process.stdout.write(
          [
            'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
            'INSTRUMENTATION_STATUS: sessionReady=true',
            'INSTRUMENTATION_STATUS_CODE: 2',
            '',
          ].join('\n'),
        );
      });
      process.onKill = () => {
        server.close(() => process.emitExit(0, null));
      };
      return process;
    },
  };
}

function sessionResponse(params: {
  requestId: string;
  body: string;
  metadata?: Record<string, string>;
}): string {
  const bodyLength = Buffer.byteLength(params.body, 'utf8');
  const headers = {
    agentDeviceProtocol: 'android-snapshot-helper-v1',
    helperApiVersion: '1',
    outputFormat: 'uiautomator-xml',
    requestId: params.requestId,
    ok: 'true',
    byteLength: String(bodyLength),
    ...params.metadata,
  };
  return `${Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n\n${params.body}`;
}

function readSessionPort(args: string[]): number {
  const index = args.indexOf('sessionPort');
  assert.notEqual(index, -1);
  return Number(args[index + 1]);
}

class FakeAndroidProcess extends EventEmitter implements AndroidAdbProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  onKill: (() => void) | undefined;

  kill(): boolean {
    this.killed = true;
    this.onKill?.();
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}
