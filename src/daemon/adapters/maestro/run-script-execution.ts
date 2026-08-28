import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { runCmdSync } from '@agent-device/host-kit/command';
import { stripUndefined } from '@agent-device/kernel/record';
import type { RunScriptHttpRequest, RunScriptHttpResponse } from './run-script-http.ts';

const RUN_SCRIPT_TIMEOUT_MS = 30_000;
const RUN_SCRIPT_DIAGNOSTIC_PREVIEW_CHARS = 1_000;

/**
 * Executes a trusted flow-local script with the compatibility helpers Maestro
 * exposes. `node:vm` isolates globals for the run but is not a security
 * sandbox; the caller must establish the trust boundary before invoking this.
 */
export function executeRunScriptFile(params: {
  scriptPath: string;
  env: Record<string, string>;
  publicNetworkOnly: boolean;
}): Record<string, string> {
  const { scriptPath, env, publicNetworkOnly } = params;
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
    timeoutMs: RUN_SCRIPT_TIMEOUT_MS,
    allowFailure: true,
  });
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
  try {
    return JSON.parse(result.stdout) as RunScriptHttpResponse;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro runScript http.${method.toLowerCase()} returned invalid JSON for ${url}`,
      {
        stdout: result.stdout.slice(0, RUN_SCRIPT_DIAGNOSTIC_PREVIEW_CHARS),
        stderr: result.stderr.slice(0, RUN_SCRIPT_DIAGNOSTIC_PREVIEW_CHARS),
      },
      error instanceof Error ? error : undefined,
    );
  }
}

function resolveHttpChildArgs(): string[] {
  const modulePath = resolveHttpChildModulePath(import.meta.url);
  if (!modulePath) {
    throw new AppError(
      'COMMAND_FAILED',
      'Maestro runScript http helper entrypoint is unavailable; rebuild the package',
    );
  }
  return modulePath.endsWith('.ts') ? ['--experimental-strip-types', modulePath] : [modulePath];
}

function resolveHttpChildModulePath(importMetaUrl: string): string | null {
  try {
    const currentModulePath = fileURLToPath(importMetaUrl);
    const extension = path.extname(currentModulePath) || '.js';
    const candidates = [
      path.join(path.dirname(currentModulePath), 'run-script-http-child' + extension),
      path.join(path.dirname(currentModulePath), 'internal', 'run-script-http-child' + extension),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  } catch {
    return null;
  }
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
