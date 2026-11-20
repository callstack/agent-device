import { execFile } from 'node:child_process';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { VPHONE_ERROR_REASONS } from './reasons.ts';

const DEFAULT_VPHONE_CLI = 'vphone-launchpad-cli';
const DEFAULT_VPHONE_TIMEOUT_MS = 45_000;
const DEFAULT_VPHONE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_VPHONE_TIMEOUT_MS = 600_000;

export type VphoneProcessResult = Readonly<{
  stdout: string;
  stderr: string;
  error?: unknown;
}>;

export type VphoneExecFile = (
  file: string,
  args: readonly string[],
  options: Readonly<{
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
  }>,
) => Promise<VphoneProcessResult>;

export type VphoneTransportOptions = Readonly<{
  cli?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  execFile?: VphoneExecFile;
  env?: Readonly<Record<string, string | undefined>>;
}>;

export type VphoneCallOptions = Readonly<{
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type VphoneTransport = Readonly<{
  json(args: readonly string[], options?: VphoneCallOptions): Promise<unknown>;
  rpc(
    machine: string,
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: VphoneCallOptions,
  ): Promise<unknown>;
}>;

export function createVphoneTransport(options: VphoneTransportOptions = {}): VphoneTransport {
  const cli = options.cli ?? DEFAULT_VPHONE_CLI;
  const timeoutMs = boundedOption(
    options.timeoutMs ?? DEFAULT_VPHONE_TIMEOUT_MS,
    'timeoutMs',
    MAX_VPHONE_TIMEOUT_MS,
  );
  const maxOutputBytes = boundedOption(
    options.maxOutputBytes ?? DEFAULT_VPHONE_MAX_OUTPUT_BYTES,
    'maxOutputBytes',
    16 * 1024 * 1024,
  );
  const execute =
    options.execFile ??
    ((file: string, args: readonly string[], execOptions: Parameters<VphoneExecFile>[2]) =>
      execVphoneFile(file, args, { ...execOptions, env: options.env ?? {} }));
  const run = async (args: readonly string[], call?: VphoneCallOptions) => {
    if (call?.signal?.aborted) throw createRequestCanceledError();
    let completed: VphoneProcessResult;
    const callTimeoutMs = boundedOption(
      call?.timeoutMs ?? timeoutMs,
      'timeoutMs',
      MAX_VPHONE_TIMEOUT_MS,
    );
    try {
      completed = await execute(cli, args, {
        timeoutMs: callTimeoutMs,
        maxOutputBytes,
        ...(call?.signal ? { signal: call.signal } : {}),
      });
    } catch (error) {
      throw processFailure(call?.signal, error);
    }
    if (call?.signal?.aborted) throw createRequestCanceledError();
    return completed;
  };
  return Object.freeze({
    json: async (args, call) => {
      const completed = await run(args, call);
      if (completed.error !== undefined)
        throw processFailure(call?.signal, completed.error, 'vphone command', completed.stderr);
      return parseJson(completed.stdout, 'vphone command');
    },
    rpc: async (machine, method, params = {}, call) => {
      const completed = await run(['guest', 'rpc', machine, method, JSON.stringify(params)], call);
      if (completed.error !== undefined && !completed.stdout.trim()) {
        throw processFailure(call?.signal, completed.error, `vphone ${method}`, completed.stderr);
      }
      const result = parseRpcEnvelope(completed.stdout, method);
      if (completed.error !== undefined) {
        throw processFailure(call?.signal, completed.error, `vphone ${method}`, completed.stderr);
      }
      return result;
    },
  });
}

async function execVphoneFile(
  file: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    env: Readonly<Record<string, string | undefined>>;
  },
): Promise<VphoneProcessResult> {
  return await new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        env: { ...options.env, NO_COLOR: '1' },
        killSignal: 'SIGKILL',
        maxBuffer: options.maxOutputBytes,
        shell: false,
        timeout: options.timeoutMs,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, ...(error ? { error } : {}) });
      },
    );
  });
}

function parseJson(stdout: string, operation: string): unknown {
  const text = stdout.trim();
  if (!text) throw invalidResponse(`${operation} produced empty output`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(`${operation} produced malformed JSON`);
  }
}

function parseRpcEnvelope(stdout: string, method: string): unknown {
  const envelope = parseJson(stdout, `vphone ${method}`);
  if (!isRecord(envelope) || typeof envelope.ok !== 'boolean') {
    throw invalidResponse(`vphone ${method} returned an invalid RPC envelope`);
  }
  if (envelope.ok) {
    if (!Object.hasOwn(envelope, 'result')) {
      throw invalidResponse(`vphone ${method} omitted its RPC result`);
    }
    return envelope.result;
  }
  const guest = isRecord(envelope.guest_error)
    ? envelope.guest_error
    : isRecord(envelope.error)
      ? envelope.error
      : undefined;
  const code = diagnosticCode(guest?.code ?? envelope.code);
  const message = diagnosticText(
    guest?.message ??
      (typeof envelope.error === 'string' ? envelope.error : undefined) ??
      envelope.message ??
      'request refused',
  );
  throw new AppError('COMMAND_FAILED', `vphone ${method} failed [${code}]: ${message}`, {
    reason: VPHONE_ERROR_REASONS.rpcRefused,
    vphoneCode: code,
  });
}

function boundedOption(value: number, name: string, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new AppError('INVALID_ARGS', `vphone ${name} must be an integer from 1 to ${maximum}.`, {
      reason: VPHONE_ERROR_REASONS.transportOptionInvalid,
      option: name,
      maximum,
    });
  }
  return value;
}

function processFailure(
  signal: AbortSignal | undefined,
  error: unknown,
  operation = 'vphone command',
  stderr?: string,
) {
  if (signal?.aborted || (isRecord(error) && error.code === 'ABORT_ERR')) {
    return createRequestCanceledError();
  }
  if (
    isRecord(error) &&
    (error.code === 'ETIMEDOUT' || (error.killed === true && error.code === null))
  ) {
    return new AppError('COMMAND_FAILED', `${operation} timed out`, {
      reason: VPHONE_ERROR_REASONS.commandTimeout,
    });
  }
  const detail =
    stderr ?? (isRecord(error) && typeof error.stderr === 'string' ? error.stderr : undefined);
  const suffix = detail?.trim() ? `: ${diagnosticText(detail)}` : '';
  return new AppError('COMMAND_FAILED', `${operation} failed${suffix}`, {
    reason: VPHONE_ERROR_REASONS.processFailed,
  });
}

function invalidResponse(message: string): AppError {
  return new AppError('COMMAND_FAILED', message, { reason: VPHONE_ERROR_REASONS.invalidResponse });
}

function diagnosticCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : 'rpc_refused';
}

function diagnosticText(value: unknown): string {
  const text = typeof value === 'string' ? value : 'request refused';
  return text
    .replaceAll(
      /("(?:password|accessToken|refreshToken|token|code)"\s*:\s*")[^"]*(")/gi,
      '$1[REDACTED]$2',
    )
    .replaceAll(
      /\b(password|access_token|refresh_token|token|code)\s*=\s*(?:"[^"]*"|'[^']*'|[^&\s]+)/gi,
      '$1=[REDACTED]',
    )
    .replaceAll(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
