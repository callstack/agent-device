import type { HostEnvironment } from '@agent-device/kernel/source-value';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '@agent-device/kernel/errors';
import type { ReplayBackendHost } from '@agent-device/contracts/replay-backend';
import { assertMaestroScriptsTrusted } from '../internal/engine-flow.ts';
import type { RunScriptChildOutput, RunScriptRequest } from './run-script-vm.ts';

const RUN_SCRIPT_DIAGNOSTIC_PREVIEW_CHARS = 1_000;
/** The `vm` budget of one runScript run. */
export const RUN_SCRIPT_TIMEOUT_MS = 30_000;
// The `vm` watchdog cannot interrupt a synchronous `http.post`, which has its own 30 s budget, so
// the child gets the `vm` budget plus one in-flight request and a margin before it is reaped.
const RUN_SCRIPT_CHILD_TIMEOUT_MS = 2 * RUN_SCRIPT_TIMEOUT_MS + 5_000;

/**
 * Executes a trusted flow-local script in a child process, so its synchronous `vm` run and
 * `http.post` calls never block the daemon event loop. `signal` stops the child. The caller
 * must establish the trust boundary; this refuses a remote flow before it reads the script.
 */
export async function executeRunScriptFile(
  request: RunScriptRequest & { signal?: AbortSignal },
  host: HostEnvironment,
  runCommand: ReplayBackendHost['runCommand'],
): Promise<Record<string, string>> {
  const { signal, ...childRequest } = request;
  assertMaestroScriptsTrusted({ trustedScripts: !childRequest.publicNetworkOnly }, 'runScript');
  const result = await runCommand(
    {
      executable: process.execPath,
      args: resolveRunScriptChildArgs('run-script-child'),
      host,
      stdin: JSON.stringify(childRequest),
      timeoutMs: RUN_SCRIPT_CHILD_TIMEOUT_MS,
      // Its own process group, so a cancel or timeout also reaps an in-flight `http.post` child.
      detached: true,
      allowFailure: true,
    },
    signal,
  );
  const output = readScriptChildOutput(result.stdout);
  if (output && 'outputEnv' in output) return output.outputEnv;
  if (output) throw new AppError(output.error.code, output.error.message, output.error.details);
  throw new AppError('COMMAND_FAILED', 'Maestro runScript process exited without a result', {
    scriptPath: childRequest.scriptPath,
    exitCode: result.exitCode,
    stderr: result.stderr.slice(0, RUN_SCRIPT_DIAGNOSTIC_PREVIEW_CHARS),
  });
}

function readScriptChildOutput(stdout: string): RunScriptChildOutput | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed && typeof parsed === 'object' && ('outputEnv' in parsed || 'error' in parsed)
      ? (parsed as RunScriptChildOutput)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The node arguments that start a packaged runScript child entry beside this module. */
export function resolveRunScriptChildArgs(
  entry: 'run-script-child' | 'run-script-http-child',
): string[] {
  const modulePath = resolveChildModulePath(entry, import.meta.url);
  if (!modulePath) {
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro runScript helper entrypoint ${entry} is unavailable; rebuild the package`,
    );
  }
  return modulePath.endsWith('.ts') ? ['--experimental-strip-types', modulePath] : [modulePath];
}

function resolveChildModulePath(entry: string, importMetaUrl: string): string | null {
  try {
    const currentModulePath = fileURLToPath(importMetaUrl);
    const extension = path.extname(currentModulePath) || '.js';
    const candidates = [
      path.join(path.dirname(currentModulePath), entry + extension),
      path.join(path.dirname(currentModulePath), 'internal', entry + extension),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  } catch {
    return null;
  }
}
