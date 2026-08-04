import fs from 'node:fs';
import { runCli } from '../cli.ts';
import type {
  DaemonRequest,
  DaemonResponse,
  sendToDaemon,
} from '../daemon/client/daemon-client.ts';
import { installIsolatedCliTestEnv } from './cli-test-env.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

class ExitSignal extends Error {
  public readonly code: number;

  constructor(code: number) {
    super(`EXIT_${code}`);
    this.code = code;
  }
}

export type CapturedDaemonRequest = Omit<DaemonRequest, 'token'>;
type DaemonTransportOptions = Parameters<typeof sendToDaemon>[1];

export type CapturedCliRun = {
  code: number | null;
  stdout: string;
  stderr: string;
  calls: CapturedDaemonRequest[];
  transportOptions: DaemonTransportOptions[];
};

export type CliCaptureOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stateDirPrefix?: string;
  passthroughBufferWrites?: boolean;
  useRealDaemonClient?: boolean;
  sendToDaemon?: (
    req: CapturedDaemonRequest,
    options?: DaemonTransportOptions,
  ) => Promise<DaemonResponse>;
  defaultResponse?: DaemonResponse;
};

type CliCaptureResponder = (
  req: CapturedDaemonRequest,
  options?: DaemonTransportOptions,
) => Promise<DaemonResponse>;

export async function runCliCapture(
  argv: string[],
  responderOrOptions: CliCaptureResponder | CliCaptureOptions = {},
  extraOptions: CliCaptureOptions = {},
): Promise<CapturedCliRun> {
  const options =
    typeof responderOrOptions === 'function'
      ? { ...extraOptions, sendToDaemon: responderOrOptions }
      : { ...extraOptions, ...(responderOrOptions ?? {}) };
  let stdout = '';
  let stderr = '';
  let code: number | null = null;
  const calls: CapturedDaemonRequest[] = [];
  const transportOptions: DaemonTransportOptions[] = [];
  const stateDir = options.stateDirPrefix ? mkdtempForTestSync(options.stateDirPrefix) : undefined;

  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalCwd = process.cwd();
  const restoreEnv = installIsolatedCliTestEnv({
    ...(options.env ?? {}),
    ...(stateDir ? { AGENT_DEVICE_STATE_DIR: stateDir } : {}),
  });

  if (options.cwd) {
    process.chdir(options.cwd);
  }

  (process as any).exit = ((nextCode?: number) => {
    throw new ExitSignal(nextCode ?? 0);
  }) as typeof process.exit;
  (process.stdout as any).write = ((chunk: unknown, ...args: unknown[]) => {
    if (options.passthroughBufferWrites && Buffer.isBuffer(chunk)) {
      return originalStdoutWrite(chunk, ...(args as [any]));
    }
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  (process.stderr as any).write = ((chunk: unknown, ...args: unknown[]) => {
    if (options.passthroughBufferWrites && Buffer.isBuffer(chunk)) {
      return originalStderrWrite(chunk, ...(args as [any]));
    }
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  const sendToDaemon = async (
    req: CapturedDaemonRequest,
    daemonOptions?: DaemonTransportOptions,
  ): Promise<DaemonResponse> => {
    calls.push(req);
    transportOptions.push(daemonOptions);
    if (options.sendToDaemon) {
      return await options.sendToDaemon(req, daemonOptions);
    }
    return options.defaultResponse ?? { ok: true, data: {} };
  };

  try {
    await runCli(argv, options.useRealDaemonClient ? undefined : { sendToDaemon });
  } catch (error) {
    if (error instanceof ExitSignal) code = error.code;
    else throw error;
  } finally {
    restoreEnv();
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    process.exit = originalExit;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.chdir(originalCwd);
  }

  return { code, stdout, stderr, calls, transportOptions };
}
