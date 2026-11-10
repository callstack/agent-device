import fs from 'node:fs';
import vm from 'node:vm';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { runCmdSync } from '@agent-device/host-kit/command';
import { stripUndefined } from '@agent-device/kernel/record';
import {
  MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES,
  RUN_SCRIPT_HTTP_TIMEOUT_MS,
  type RunScriptChildError,
  type RunScriptHttpChildOutput,
  type RunScriptHttpRequest,
  type RunScriptHttpResponse,
} from './run-script-http.ts';
import { RUN_SCRIPT_TIMEOUT_MS, resolveRunScriptChildArgs } from './run-script-execution.ts';

const RUN_SCRIPT_DIAGNOSTIC_PREVIEW_CHARS = 1_000;
// JSON escapes a body byte into at most six characters (`\u0000`); headers fit in the remainder.
const HTTP_CHILD_MAX_STDOUT_BYTES = MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES * 6 + 1024 * 1024;

export type RunScriptRequest = {
  scriptPath: string;
  env: Record<string, string>;
  publicNetworkOnly: boolean;
};

/** What the script child writes to stdout: the `output.*` replay variables, or the typed error. */
export type RunScriptChildOutput =
  | { outputEnv: Record<string, string> }
  | { error: RunScriptChildError };

/**
 * Runs a trusted flow-local script with the compatibility helpers Maestro exposes. `node:vm`
 * isolates globals for the run but is not a security sandbox. The script and its `http.post`
 * calls are synchronous, so only the script child process calls this.
 */
export function runScriptInProcess(request: RunScriptRequest): Record<string, string> {
  const { scriptPath, env, publicNetworkOnly } = request;
  const script = fs.readFileSync(scriptPath, 'utf8');
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  try {
    // The synchronous script budget is independent from the child-process
    // budget used by http.post below.
    vm.runInNewContext(script, buildScriptGlobals(env, output, publicNetworkOnly), {
      filename: scriptPath,
      timeout: RUN_SCRIPT_TIMEOUT_MS,
    });
  } catch (error) {
    const normalized = normalizeError(error);
    throw new AppError(
      normalized.code,
      `Maestro runScript failed: ${normalized.message}`,
      stripUndefined({
        ...(normalized.details ?? {}),
        hint: normalized.hint,
        diagnosticId: normalized.diagnosticId,
        logPath: normalized.logPath,
        retriable: normalized.retriable,
        supportedOn: normalized.supportedOn,
        scriptPath,
      }),
      error instanceof Error ? error : undefined,
    );
  }

  validateOutputKeys(output, scriptPath);
  return Object.fromEntries(
    Object.entries(output).map(([key, rawValue]) => [
      `output.${key}`,
      stringifyOutputValue(rawValue),
    ]),
  );
}

function buildScriptGlobals(
  env: Record<string, string>,
  output: Record<string, unknown>,
  publicNetworkOnly: boolean,
): vm.Context {
  return {
    ...env,
    output,
    json: parseRunScriptJson,
    http: {
      post: (url: string, options?: { headers?: Record<string, string>; body?: string }) =>
        runHttpRequestSync('POST', url, publicNetworkOnly, options),
    },
  };
}

function parseRunScriptJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro runScript json() expected a string body, received ${typeof value}.`,
    );
  }
  if (value.trim().length === 0) {
    throw new AppError('COMMAND_FAILED', 'Maestro runScript json() received an empty body.', {
      hint: 'Check the preceding HTTP response status and setup server output.',
    });
  }
  try {
    return JSON.parse(value, safeRunScriptJsonReviver) as unknown;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro runScript json() could not parse response body: ${error instanceof Error ? error.message : String(error)}`,
      { bodyPreview: value.slice(0, RUN_SCRIPT_DIAGNOSTIC_PREVIEW_CHARS) },
      error instanceof Error ? error : undefined,
    );
  }
}

function safeRunScriptJsonReviver(key: string, value: unknown): unknown {
  return key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value;
}

function runHttpRequestSync(
  method: RunScriptHttpRequest['method'],
  url: string,
  publicNetworkOnly: boolean,
  options?: { headers?: Record<string, string>; body?: string },
): RunScriptHttpResponse {
  const result = runCmdSync(process.execPath, resolveHttpChildArgs(), {
    stdin: JSON.stringify(buildHttpChildInput(method, url, options, publicNetworkOnly)),
    // The child aborts its own request at this budget; this bound only reaps a stuck child.
    timeoutMs: RUN_SCRIPT_HTTP_TIMEOUT_MS + 5_000,
    allowFailure: true,
    maxBuffer: HTTP_CHILD_MAX_STDOUT_BYTES,
  });
  const output = readHttpChildOutput(result.stdout);
  if (output && 'response' in output) return output.response;
  if (output) {
    throw new AppError(output.error.code, output.error.message, { ...output.error.details, url });
  }
  if (result.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro runScript http.${method.toLowerCase()} failed for ${url}: ${trimHttpErrorOutput(result.stderr)}`,
      {
        exitCode: result.exitCode,
        stderr: result.stderr,
      },
    );
  }
  throw new AppError(
    'COMMAND_FAILED',
    `Maestro runScript http.${method.toLowerCase()} returned invalid JSON for ${url}`,
    {
      stdout: result.stdout.slice(0, RUN_SCRIPT_DIAGNOSTIC_PREVIEW_CHARS),
      stderr: result.stderr.slice(0, RUN_SCRIPT_DIAGNOSTIC_PREVIEW_CHARS),
    },
  );
}

function readHttpChildOutput(stdout: string): RunScriptHttpChildOutput | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed && typeof parsed === 'object' && ('response' in parsed || 'error' in parsed)
      ? (parsed as RunScriptHttpChildOutput)
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveHttpChildArgs(): string[] {
  return resolveRunScriptChildArgs('run-script-http-child');
}

function buildHttpChildInput(
  method: RunScriptHttpRequest['method'],
  url: string,
  options: { headers?: Record<string, string>; body?: string } | undefined,
  publicNetworkOnly: boolean,
): RunScriptHttpRequest {
  return {
    method,
    url,
    headers: options?.headers ?? {},
    body: options?.body ?? '',
    publicNetworkOnly,
  };
}

function validateOutputKeys(output: Record<string, unknown>, scriptPath: string): void {
  for (const key of Object.keys(output)) {
    if (!key.includes('.')) continue;
    throw new AppError('INVALID_ARGS', `Maestro runScript output key cannot contain ".": ${key}`, {
      scriptPath,
      key,
    });
  }
}

function stringifyOutputValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function trimHttpErrorOutput(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > 0
    ? trimmed.slice(0, RUN_SCRIPT_DIAGNOSTIC_PREVIEW_CHARS)
    : 'request process exited without stderr';
}
