import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test } from 'vitest';
import {
  captureAndroidSnapshotWithHelperSession,
  resetAndroidSnapshotHelperSessions,
} from '../snapshot-helper-session.ts';
import { resolveAndroidSnapshotHelperSessionRequestTimeoutMs } from '../snapshot-helper-session-protocol.ts';
import { recoverAndroidSnapshotHelperRetirement } from '../snapshot-helper-retirement.ts';
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
  assert.equal(readSessionArgument(spawnArgs[0]!, 'timeoutMs'), '2000');
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
    3_010,
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

test('retires a persistent session that exceeds the helper command budget', async () => {
  const calls: string[][] = [];
  const provider = createSessionProvider({ calls, responseDelayMs: 50 });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    timeoutMs: 10,
    commandTimeoutMs: 20,
  });

  assert.equal(output, undefined);
  assert.equal(
    calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

test('cancels a stalled snapshot, retires its helper, and starts the next capture cleanly', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls, processes, stalledSnapshots: 1 });
  const controller = new AbortController();
  const capture = captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error('wait deadline exceeded')), 10);

  await assert.rejects(capture, /wait deadline exceeded/);
  assert.equal(processes[0]?.killed, true);
  assert.equal(
    calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );

  const next = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  assert.match(next?.xml ?? '', /snapshot 1/);
  assert.equal(next?.metadata.sessionReused, false);
  assert.equal(processes.length, 2);
});

test('canceled capture joins canceled external cleanup before returning', async () => {
  const calls: string[][] = [];
  const cleanupAborts: string[][] = [];
  const provider = createSessionProvider({
    calls,
    cleanupAborts,
    stalledSnapshots: 1,
    stalledCleanup: true,
  });
  const controller = new AbortController();
  const capture = captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error('wait deadline exceeded')), 10);

  const outcome = await Promise.race([
    capture.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 750)),
  ]);

  assert.equal(outcome, 'rejected');
  assert.equal(cleanupAborts.length, 2);
});

test('failed capture does not fall back when device runtime retirement is unconfirmed', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({
    calls,
    processes,
    recoveryFailure: true,
    responseMode: 'malformed',
    stalledCleanup: true,
  });

  await assert.rejects(
    captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: provider,
      deviceKey: 'android:emulator-5554',
    }),
    (error: unknown) =>
      (error as { details?: { reason?: string } }).details?.reason ===
      'android_snapshot_helper_retirement_unconfirmed',
  );

  await assert.rejects(
    captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: { exec: provider.exec },
      deviceKey: 'android:emulator-5554',
    }),
    (error: unknown) =>
      (error as { details?: { reason?: string } }).details?.reason ===
      'android_snapshot_helper_retirement_unconfirmed',
  );
  assert.equal(processes.length, 1);
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

test('allows an acknowledged helper quit to release UiAutomation before forcing termination', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls, processes, quitExitDelayMs: 25 });

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  await resetAndroidSnapshotHelperSessions();

  assert.equal(processes.length, 1);
  assert.equal(processes[0]?.killed, false);
  assert.equal(
    calls.some(
      (args) => args.join(' ') === 'shell am force-stop com.callstack.agentdevice.snapshothelper',
    ),
    true,
  );
});

test('force terminates the helper when quit is not acknowledged', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls, processes, quitResponseMode: 'malformed' });

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  await resetAndroidSnapshotHelperSessions();

  assert.equal(processes.length, 1);
  assert.equal(processes[0]?.killed, true);
});

test('failed whole-module reset preserves quarantine until recovery is confirmed', async () => {
  const options: SessionProviderOptions = {
    calls: [],
    quitResponseMode: 'malformed',
    recoveryFailure: true,
  };
  const provider = createSessionProvider(options);
  const deviceKey = 'android:emulator-5554';

  await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey,
  });
  await assert.rejects(
    resetAndroidSnapshotHelperSessions(),
    /Failed to retire every Android snapshot helper session/,
  );
  const forceStopsBeforeRecovery = options.calls.filter((args) =>
    args.join(' ').includes('am force-stop'),
  ).length;

  options.recoveryFailure = false;
  await recoverAndroidSnapshotHelperRetirement({
    deviceKey,
    adb: provider.exec,
  });

  assert.equal(
    options.calls.filter((args) => args.join(' ').includes('am force-stop')).length,
    forceStopsBeforeRecovery + 1,
  );
});

test('allows device retirement beyond host-process grace before falling back', async () => {
  const calls: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({
    calls,
    processes,
    responseMode: 'ui-automation-timeout',
    forceStopDelayMs: 300,
  });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(output, undefined);
  assert.equal(processes[0]?.killed, true);
});

test('invalidates and falls back from the helper session after a malformed response', async () => {
  const calls: string[][] = [];
  const provider = createSessionProvider({ calls, responseMode: 'malformed' });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(output, undefined);
  assert.equal(
    calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

type SessionProviderOptions = {
  calls: string[][];
  cleanupAborts?: string[][];
  processes?: FakeAndroidProcess[];
  quitExitDelayMs?: number;
  quitResponseMode?: 'ok' | 'malformed';
  spawnArgs?: string[][];
  responseMode?: 'ok' | 'malformed' | 'ui-automation-timeout';
  responseDelayMs?: number;
  forceStopDelayMs?: number;
  recoveryFailure?: boolean;
  stalledCleanup?: boolean;
  stalledSnapshots?: number;
};

function createSessionProvider(options: SessionProviderOptions): AndroidAdbProvider {
  let stalledSnapshots = options.stalledSnapshots ?? 0;
  return {
    exec: createSessionExec(options),
    spawn: (args) => {
      options.spawnArgs?.push(args);
      const port = readSessionPort(args);
      const process = new FakeAndroidProcess();
      options.processes?.push(process);
      let snapshotCount = 0;
      const sockets = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.once('data', (chunk) => {
          const command = chunk.toString('utf8').trim();
          const [, requestId = ''] = command.split(/\s+/, 2);
          if (command.startsWith('quit')) {
            if (options.quitResponseMode === 'malformed') {
              socket.end('not a session response');
              return;
            }
            socket.end(sessionResponse({ requestId, body: '' }));
            server.close(() => {
              setTimeout(() => process.emitExit(0, null), options.quitExitDelayMs ?? 0);
            });
            return;
          }
          if (options.responseMode === 'malformed') {
            socket.end('not a session response');
            return;
          }
          if (options.responseMode === 'ui-automation-timeout') {
            socket.end(
              sessionResponse({
                requestId,
                body: '',
                metadata: {
                  ok: 'false',
                  errorType: 'java.util.concurrent.TimeoutException',
                  message: 'Timed out waiting for Android UiAutomation to connect',
                },
              }),
            );
            return;
          }
          snapshotCount += 1;
          if (stalledSnapshots > 0) {
            stalledSnapshots -= 1;
            return;
          }
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
        for (const socket of sockets) socket.destroy();
        if (server.listening) {
          server.close(() => process.emitExit(0, null));
        } else {
          process.emitExit(0, null);
        }
      };
      return process;
    },
  };
}

function createSessionExec(options: SessionProviderOptions): AndroidAdbExecutor {
  return async (args, execOptions) => {
    options.calls.push(args);
    const forceStopsRuntime = args.join(' ').includes('am force-stop');
    await stallSessionCleanupIfConfigured(options, args, execOptions?.signal, forceStopsRuntime);
    if (options.recoveryFailure && forceStopsRuntime) {
      return { exitCode: 1, stdout: '', stderr: 'runtime still busy' };
    }
    await delayForceStopIfConfigured(options, execOptions?.signal, forceStopsRuntime);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

async function stallSessionCleanupIfConfigured(
  options: SessionProviderOptions,
  args: string[],
  signal: AbortSignal | undefined,
  forceStopsRuntime: boolean,
): Promise<void> {
  const removesForward = args[0] === 'forward' && args[1] === '--remove';
  if (!options.stalledCleanup || !signal || (!removesForward && !forceStopsRuntime)) return;
  await new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      options.cleanupAborts?.push(args);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function delayForceStopIfConfigured(
  options: SessionProviderOptions,
  signal: AbortSignal | undefined,
  forceStopsRuntime: boolean,
): Promise<void> {
  if (!forceStopsRuntime || !options.forceStopDelayMs) return;
  await waitForDelay(options.forceStopDelayMs, signal);
}

async function waitForDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
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

function readSessionArgument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

class FakeAndroidProcess extends EventEmitter implements AndroidAdbProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  onKill: (() => void) | undefined;

  kill(): boolean {
    this.killed = true;
    this.onKill?.();
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}
