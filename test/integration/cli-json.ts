import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmd, runCmdSync, type ExecResult } from '@agent-device/host-kit/command';

const CLI_TIMEOUT_MS = 120_000;

/** The repo's source CLI entry, absolute so a spawned process may run from any cwd. */
const SOURCE_CLI_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/bin.ts',
);

export type CliJsonResult = {
  status: number;
  json?: any;
  stdout: string;
  stderr: string;
};

export type CliJsonOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** The working directory the CLI process runs in; defaults to this process's cwd. */
  cwd?: string;
};

export function runSourceCliJsonSync(args: string[], options?: CliJsonOptions): CliJsonResult {
  const result = runCmdSync(
    process.execPath,
    ['--experimental-strip-types', SOURCE_CLI_ENTRY, ...args],
    {
      allowFailure: true,
      env: options?.env,
      cwd: options?.cwd,
      timeoutMs: options?.timeoutMs ?? CLI_TIMEOUT_MS,
    },
  );
  return cliJsonResult(result);
}

/**
 * Async variant for tests that keep a loopback server in THIS process: the synchronous spawn
 * would block the event loop and starve the server. Runs the same source CLI in a real
 * separate process, optionally from a different working directory.
 */
export async function runSourceCliJson(
  args: string[],
  options?: CliJsonOptions,
): Promise<CliJsonResult> {
  const result = await runCmd(
    process.execPath,
    ['--experimental-strip-types', SOURCE_CLI_ENTRY, ...args],
    {
      allowFailure: true,
      env: options?.env,
      cwd: options?.cwd,
      timeoutMs: options?.timeoutMs ?? CLI_TIMEOUT_MS,
    },
  );
  return cliJsonResult(result);
}

export async function runBuiltCliJson(
  args: string[],
  env: NodeJS.ProcessEnv,
  options?: { timeoutMs?: number },
): Promise<CliJsonResult> {
  const result = await runCmd(process.execPath, ['bin/agent-device.mjs', ...args], {
    allowFailure: true,
    env,
    timeoutMs: options?.timeoutMs ?? CLI_TIMEOUT_MS,
  });
  return cliJsonResult(result);
}

export function formatResultDebug(step: string, args: string[], result: CliJsonResult): string {
  const jsonText =
    result.json === undefined ? '(unparseable)' : JSON.stringify(result.json, null, 2);
  return [
    `step: ${step}`,
    `command: agent-device ${args.join(' ')}`,
    `status: ${result.status}`,
    `stderr:`,
    result.stderr || '(empty)',
    `stdout:`,
    result.stdout || '(empty)',
    `json:`,
    jsonText,
  ].join('\n');
}

function cliJsonResult(result: ExecResult): CliJsonResult {
  let json: any;
  try {
    json = JSON.parse(result.stdout ?? '');
  } catch {
    json = undefined;
  }
  return {
    status: result.exitCode,
    json,
    stdout: json ? '<JSON output>' : (result.stdout ?? ''),
    stderr: result.stderr ?? '',
  };
}
