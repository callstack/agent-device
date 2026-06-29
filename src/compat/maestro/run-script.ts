import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import type { SessionAction } from '../../daemon/types.ts';
import { AppError } from '../../kernel/errors.ts';
import { runCmdSync } from '../../utils/exec.ts';
import { MAESTRO_RUNTIME_COMMAND } from './runtime-commands.ts';
import {
  action,
  assertOnlyKeys,
  isPlainRecord,
  readEnvMap,
  requireStringValue,
  resolveMaestroString,
} from './support.ts';
import type { MaestroParseContext } from './types.ts';

const RUN_SCRIPT_TIMEOUT_MS = 30_000;

type HttpResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

const HTTP_REQUEST_SCRIPT = `
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (typeof fetch !== 'function') {
  console.error('global fetch is required for Maestro runScript http helpers');
  process.exit(1);
}
fetch(input.url, {
  method: input.method,
  headers: input.headers,
  body: input.body,
}).then(async response => {
  process.stdout.write(JSON.stringify({
    status: response.status,
    body: await response.text(),
    headers: Object.fromEntries(response.headers.entries()),
  }));
}).catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;

export function convertRunScript(value: unknown, context: MaestroParseContext): SessionAction {
  const scriptConfig = readRunScriptConfig(value, context);
  const scriptPath = resolveRunScriptPath(scriptConfig.file, context);
  return action(MAESTRO_RUNTIME_COMMAND.runScript, [scriptPath], {
    ...(Object.keys(scriptConfig.env).length > 0
      ? { maestro: { runScriptEnv: scriptConfig.env } }
      : {}),
  });
}

export function executeRunScriptFile(params: {
  scriptPath: string;
  env: Record<string, string>;
}): Record<string, string> {
  const { scriptPath, env } = params;
  const script = fs.readFileSync(scriptPath, 'utf8');
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  try {
    // Compatibility note: node:vm is not a security sandbox. Maestro runScript
    // files are trusted flow-local setup code; the timeout only bounds
    // synchronous script execution. Async http.post work is bounded separately
    // by the child process timeout in runHttpRequestSync.
    vm.runInNewContext(script, buildScriptGlobals(env, output), {
      filename: scriptPath,
      timeout: RUN_SCRIPT_TIMEOUT_MS,
    });
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro runScript failed for ${scriptPath}: ${error instanceof Error ? error.message : String(error)}`,
      { scriptPath },
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

function readRunScriptConfig(
  value: unknown,
  context: MaestroParseContext,
): { file: string; env: Record<string, string> } {
  if (typeof value === 'string') {
    return { file: resolveMaestroString(value, context), env: {} };
  }
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'runScript expects a file path string or map.');
  }
  assertOnlyKeys(value, 'runScript', ['file', 'env']);
  const file = resolveMaestroString(requireStringValue('runScript.file', value.file), context);
  const rawEnv = readEnvMap(value.env, 'runScript.env');
  const env = Object.fromEntries(
    Object.entries(rawEnv).map(([key, envValue]) => [key, resolveMaestroString(envValue, context)]),
  );
  return { file, env };
}

function resolveRunScriptPath(filePath: string, context: MaestroParseContext): string {
  if (path.isAbsolute(filePath)) return filePath;
  if (!context.baseDir) {
    throw new AppError(
      'INVALID_ARGS',
      'runScript file paths require replay input to have a source path.',
    );
  }
  return path.resolve(context.baseDir, filePath);
}

function buildScriptGlobals(
  env: Record<string, string>,
  output: Record<string, unknown>,
): vm.Context {
  return {
    ...env,
    output,
    json: parseRunScriptJson,
    http: {
      post: (url: string, options?: { headers?: Record<string, string>; body?: string }) =>
        runHttpRequestSync('POST', url, options),
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
    throw new AppError(
      'COMMAND_FAILED',
      'Maestro runScript json() received an empty body. Check the preceding http response status and setup server output.',
    );
  }
  try {
    return JSON.parse(value, safeRunScriptJsonReviver) as unknown;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro runScript json() could not parse response body: ${error instanceof Error ? error.message : String(error)}`,
      { bodyPreview: value.slice(0, 1000) },
      error instanceof Error ? error : undefined,
    );
  }
}

function safeRunScriptJsonReviver(key: string, value: unknown): unknown {
  return key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value;
}

function runHttpRequestSync(
  method: string,
  url: string,
  options?: { headers?: Record<string, string>; body?: string },
): HttpResponse {
  // Keep http.post synchronous from the flow author's point of view while the
  // network request remains timeout-bounded independently from node:vm.
  const result = runCmdSync(process.execPath, ['-e', HTTP_REQUEST_SCRIPT], {
    stdin: JSON.stringify({
      method,
      url,
      headers: options?.headers ?? {},
      body: options?.body ?? '',
    }),
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
    return JSON.parse(result.stdout) as HttpResponse;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro runScript http.${method.toLowerCase()} returned invalid JSON for ${url}`,
      {
        stdout: result.stdout.slice(0, 1000),
        stderr: result.stderr.slice(0, 1000),
      },
      error instanceof Error ? error : undefined,
    );
  }
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
  return trimmed.length > 0 ? trimmed.slice(0, 1000) : 'request process exited without stderr';
}
