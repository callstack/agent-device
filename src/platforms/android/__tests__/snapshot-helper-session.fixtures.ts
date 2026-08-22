// Fakes for the persistent Android automation-helper session: a spawned instrumentation process
// plus a local TCP server standing in for the helper's session socket. Every test that observes
// session lifetime (snapshot capture, fill verification samples, gesture/viewport transport) reads
// the same fake, so "one warm session" means the same thing in all of them.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import type { AndroidAdbProcess, AndroidAdbProvider } from '../adb-executor.ts';
import type { AndroidAdbExecutor } from '../snapshot-helper-types.ts';

export const ANDROID_HELPER_INSTALLED_VERSION_PROBE = {
  exitCode: 0,
  stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
  stderr: '',
};

export class FakeAndroidProcess extends EventEmitter implements AndroidAdbProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  onKill: (() => void) | undefined;

  kill(): boolean {
    if (this.killed) return true;
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

export type PersistentSnapshotHelperProviderOptions = {
  calls: string[][];
  spawnArgs: string[][];
  processes: FakeAndroidProcess[];
  sessionResponseMode?: 'ok' | 'malformed';
  sessionXml?: (sessionIndex: number, snapshotCount: number) => string;
  stalledSessionCleanup?: boolean;
  oneShotAttempts?: string[][];
  oneShotXml?: string;
};

export function createPersistentSnapshotHelperProvider(
  options: PersistentSnapshotHelperProviderOptions,
): AndroidAdbProvider {
  return {
    exec: createPersistentSnapshotExec(options),
    spawn: (args) => {
      options.spawnArgs.push(args);
      const sessionIndex = options.spawnArgs.length;
      const process = new FakeAndroidProcess();
      options.processes.push(process);
      const port = readSessionPort(args);
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
          if (options.sessionResponseMode === 'malformed') {
            socket.end('malformed session response');
            return;
          }
          if (command.startsWith('viewport')) {
            socket.end(
              sessionResponse({
                requestId,
                body: '',
                metadata: { x: '0', y: '0', width: '400', height: '800' },
              }),
            );
            return;
          }
          snapshotCount += 1;
          const body = options.sessionXml
            ? options.sessionXml(sessionIndex, snapshotCount)
            : `<hierarchy><node text="persistent helper snapshot ${snapshotCount}" bounds="[0,0][10,10]" /></hierarchy>`;
          socket.end(
            sessionResponse({
              requestId,
              body,
              metadata: {
                waitForIdleTimeoutMs: '500',
                waitForIdleQuietMs: '100',
                timeoutMs: '5000',
                maxDepth: '128',
                maxNodes: '5000',
                rootPresent: 'true',
                captureMode: 'interactive-windows',
                windowCount: '1',
                nodeCount: '1',
                truncated: 'false',
                elapsedMs: '8',
              },
            }),
          );
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

export function isAndroidHelperRuntimeForceStop(args: readonly string[]): boolean {
  return args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop';
}

export function isAndroidHelperForwardRemoval(args: readonly string[]): boolean {
  return args[0] === 'forward' && args[1] === '--remove';
}

export function androidHelperInstrumentationOutput(
  xml: string,
  options: { truncated?: boolean; nodeCount?: number; windowCount?: number } = {},
): string {
  const truncated = options.truncated ?? false;
  const nodeCount = options.nodeCount ?? 1;
  const windowCount = options.windowCount ?? 1;
  return [
    'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_STATUS: helperApiVersion=1',
    'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_STATUS: chunkIndex=0',
    'INSTRUMENTATION_STATUS: chunkCount=1',
    `INSTRUMENTATION_STATUS: payloadBase64=${Buffer.from(xml, 'utf8').toString('base64')}`,
    'INSTRUMENTATION_STATUS_CODE: 1',
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_RESULT: helperApiVersion=1',
    'INSTRUMENTATION_RESULT: ok=true',
    'INSTRUMENTATION_RESULT: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_RESULT: waitForIdleTimeoutMs=0',
    'INSTRUMENTATION_RESULT: timeoutMs=8000',
    'INSTRUMENTATION_RESULT: maxDepth=128',
    'INSTRUMENTATION_RESULT: maxNodes=5000',
    'INSTRUMENTATION_RESULT: rootPresent=true',
    'INSTRUMENTATION_RESULT: captureMode=interactive-windows',
    `INSTRUMENTATION_RESULT: windowCount=${windowCount}`,
    `INSTRUMENTATION_RESULT: nodeCount=${nodeCount}`,
    `INSTRUMENTATION_RESULT: truncated=${truncated}`,
    'INSTRUMENTATION_RESULT: elapsedMs=12',
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');
}

function createPersistentSnapshotExec(
  options: PersistentSnapshotHelperProviderOptions,
): AndroidAdbExecutor {
  return async (args, execOptions) => {
    options.calls.push(args);
    const stalledCleanup = stalledPersistentCleanup(options, args, execOptions?.signal);
    if (stalledCleanup) return await stalledCleanup;
    return persistentSnapshotExecResult(options, args);
  };
}

function stalledPersistentCleanup(
  options: PersistentSnapshotHelperProviderOptions,
  args: string[],
  signal: AbortSignal | undefined,
): ReturnType<AndroidAdbExecutor> | undefined {
  if (!options.stalledSessionCleanup || !signal) return undefined;
  return isAndroidHelperForwardRemoval(args) || isAndroidHelperRuntimeForceStop(args)
    ? rejectWhenAborted(signal)
    : undefined;
}

function persistentSnapshotExecResult(
  options: PersistentSnapshotHelperProviderOptions,
  args: string[],
): ReturnType<AndroidAdbExecutor> {
  if (args.includes('--show-versioncode')) {
    return Promise.resolve(ANDROID_HELPER_INSTALLED_VERSION_PROBE);
  }
  if (args[0] === 'forward' || isAndroidHelperRuntimeForceStop(args)) {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }
  if (args.includes('instrument')) {
    options.oneShotAttempts?.push(args);
    if (options.oneShotXml) {
      return Promise.resolve({
        exitCode: 0,
        stdout: androidHelperInstrumentationOutput(options.oneShotXml),
        stderr: '',
      });
    }
  }
  return Promise.reject(new Error(`unexpected persistent helper adb args: ${args.join(' ')}`));
}

function rejectWhenAborted(signal: AbortSignal): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function sessionResponse(params: {
  requestId: string;
  body: string;
  metadata?: Record<string, string>;
}): string {
  const headers = {
    agentDeviceProtocol: 'android-snapshot-helper-v1',
    helperApiVersion: '1',
    outputFormat: 'uiautomator-xml',
    requestId: params.requestId,
    ok: 'true',
    byteLength: String(Buffer.byteLength(params.body, 'utf8')),
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
