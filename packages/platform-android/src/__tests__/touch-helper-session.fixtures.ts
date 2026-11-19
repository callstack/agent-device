import { EventEmitter } from 'node:events';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import type { AndroidAdbProcess, AndroidAdbProvider } from '../adb-executor.ts';
import {
  androidHelperRuntimeProbeResult,
  isAndroidHelperRuntimeProbe,
  readAndroidSessionLaunch,
  sessionReadyRecord,
  type FakeAndroidHelperRuntimeRelease,
} from './snapshot-helper-session.fixtures.ts';

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

export type TouchSessionCommandHandler = (command: string, requestId: string) => string | undefined;

export function sessionHeaderResponse(headers: Record<string, string>): string {
  return `${Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n\n`;
}

export function snapshotSessionResponse(requestId: string): string {
  const body = '<hierarchy><node text="touch-helper-session" /></hierarchy>';
  const headers = {
    agentDeviceProtocol: 'android-snapshot-helper-v1',
    helperApiVersion: '1',
    outputFormat: 'uiautomator-xml',
    requestId,
    ok: 'true',
    byteLength: String(Buffer.byteLength(body, 'utf8')),
  };
  return `${Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n\n${body}`;
}

function isTouchCleanupCommand(args: readonly string[]): boolean {
  return (
    (args[0] === 'forward' && args[1] === '--remove') ||
    (args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop')
  );
}

function neverResolvingAfterAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function createFakeTouchHelperSessionProvider(
  handleCommand: TouchSessionCommandHandler,
  options: { stallCleanup?: boolean; runtimeRelease?: FakeAndroidHelperRuntimeRelease } = {},
): AndroidAdbProvider {
  return {
    exec: async (args, execOptions) => {
      const signal = execOptions?.signal;
      if (options.stallCleanup && signal && isTouchCleanupCommand(args)) {
        return await neverResolvingAfterAbort(signal);
      }
      if (isAndroidHelperRuntimeProbe(args)) {
        return androidHelperRuntimeProbeResult(options.runtimeRelease);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    spawn: (args) => {
      const launch = readAndroidSessionLaunch(args);
      const port = launch.port;
      const process = new FakeAndroidProcess();
      const server = net.createServer((socket) => {
        socket.once('data', (chunk) => {
          const command = chunk.toString('utf8').trim();
          const [, requestId = ''] = command.split(/\s+/, 2);
          if (command.startsWith('quit')) {
            socket.end(
              sessionHeaderResponse({
                agentDeviceProtocol: 'android-snapshot-helper-v1',
                requestId,
                ok: 'true',
              }),
            );
            server.close(() => process.emitExit(0, null));
            return;
          }
          const response = handleCommand(command, requestId);
          if (response !== undefined) socket.end(response);
        });
      });
      server.listen(port, '127.0.0.1', () => {
        process.stdout.write(
          sessionReadyRecord(launch, 'input,screenshot,focus,snapshot-immediate'),
        );
      });
      process.onKill = () => {
        server.close(() => process.emitExit(0, null));
      };
      return process;
    },
  };
}
