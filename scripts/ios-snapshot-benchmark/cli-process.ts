import { execFile, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { asRecord, readString } from './result-values.ts';

const MAX_BUFFER = 64 * 1024 * 1024;

export type CliResult = {
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  wallClockMs: number;
  stdout: string;
  stderr: string;
  payload: unknown;
  ok: boolean;
  spawnErrorCode?: string;
};

export type CliContext = {
  repoRoot: string;
  stateDir: string;
  session: string;
  udid: string;
  derivedPath: string;
  extraFlags?: string[];
};

export function runCli(context: CliContext, args: string[], timeoutMs = 300_000): CliResult {
  const argv = buildArgv(context, args);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = spawnSync(process.execPath, argv, {
    cwd: context.repoRoot,
    env: { ...process.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
  });
  return buildResult({
    startedAt,
    started,
    exitCode: typeof result.status === 'number' ? result.status : -1,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  });
}

export async function runCliAsync(
  context: CliContext,
  args: string[],
  timeoutMs = 300_000,
): Promise<CliResult> {
  const argv = buildArgv(context, args);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      argv,
      {
        cwd: context.repoRoot,
        env: { ...process.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' },
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        resolve(
          buildResult({
            startedAt,
            started,
            exitCode: typeof error?.code === 'number' ? error.code : error ? -1 : 0,
            stdout,
            stderr,
            error,
          }),
        );
      },
    );
  });
}

function buildArgv(context: CliContext, args: string[]): string[] {
  return ['bin/agent-device.mjs', ...args, ...baseFlags(context), '--json'];
}

function buildResult(options: {
  startedAt: string;
  started: number;
  exitCode: number;
  stdout: string | Buffer | null;
  stderr: string | Buffer | null;
  error?: Error | null;
}): CliResult {
  const stdout = readOutput(options.stdout);
  const stderr = readOutput(options.stderr);
  const spawnErrorCode = readAsyncErrorCode(options.error);
  const spawnError = options.error ? `${options.error.name}: ${options.error.message}` : '';
  const payload = parseJson(stdout);
  return {
    exitCode: options.exitCode,
    startedAt: options.startedAt,
    finishedAt: new Date().toISOString(),
    wallClockMs: performance.now() - options.started,
    stdout,
    stderr: [stderr, spawnError].filter(Boolean).join('\n'),
    payload,
    ok: options.exitCode === 0 && !isExplicitFailure(payload) && !isBatchStepFailure(payload),
    ...(spawnErrorCode ? { spawnErrorCode } : {}),
  };
}

function readAsyncErrorCode(error: Error | null | undefined): string | undefined {
  const processError = error as
    | (NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null })
    | null
    | undefined;
  if (processError?.killed && processError.signal === 'SIGTERM') return 'ETIMEDOUT';
  return readString(processError?.code);
}

function baseFlags(context: CliContext): string[] {
  return [
    '--state-dir',
    context.stateDir,
    '--session',
    context.session,
    '--platform',
    'ios',
    '--udid',
    context.udid,
    '--ios-xctest-derived-data-path',
    context.derivedPath,
    ...(context.extraFlags ?? []),
  ];
}

function readOutput(value: string | Buffer | null): string {
  return typeof value === 'string' ? value : (value?.toString('utf8') ?? '');
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function isExplicitFailure(value: unknown): boolean {
  const record = asRecord(value);
  return record?.ok === false || Boolean(asRecord(record?.data)?.initialSnapshotError);
}

function isBatchStepFailure(value: unknown): boolean {
  const results = asRecord(asRecord(value)?.data)?.results;
  const first = Array.isArray(results) ? asRecord(results[0]) : undefined;
  return first?.ok === false;
}
