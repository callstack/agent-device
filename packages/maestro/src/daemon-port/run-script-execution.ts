import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import { assertMaestroScriptsTrusted } from '../internal/engine-flow.ts';
import { resolveRunScriptChildArgs } from './run-script-vm.ts';
import type { RunScriptChildOutput, RunScriptRequest } from './run-script-vm.ts';

const RUN_SCRIPT_DIAGNOSTIC_PREVIEW_CHARS = 1_000;

/**
 * Executes a trusted flow-local script in a child process, so its synchronous `vm` run and
 * `http.post` calls never block the daemon event loop. `signal` stops the child. The caller
 * must establish the trust boundary; this refuses a remote flow before it reads the script.
 */
export async function executeRunScriptFile(
  request: RunScriptRequest & { signal?: AbortSignal },
): Promise<Record<string, string>> {
  const { signal, ...childRequest } = request;
  assertMaestroScriptsTrusted({ trustedScripts: !childRequest.publicNetworkOnly }, 'runScript');
  const result = await runCmd(process.execPath, resolveRunScriptChildArgs('run-script-child'), {
    stdin: JSON.stringify(childRequest),
    signal,
    allowFailure: true,
  });
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
