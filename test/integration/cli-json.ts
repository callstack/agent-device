import { runCmd, runCmdSync, type ExecResult } from '../../src/utils/exec.ts';

const CLI_TIMEOUT_MS = 120_000;

export type CliJsonResult = {
  status: number;
  json?: any;
  stdout: string;
  stderr: string;
};

export function runSourceCliJsonSync(
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
): CliJsonResult {
  const result = runCmdSync(
    process.execPath,
    ['--experimental-strip-types', 'src/bin.ts', ...args],
    {
      allowFailure: true,
      env: options?.env,
      timeoutMs: CLI_TIMEOUT_MS,
    },
  );
  return cliJsonResult(result);
}

export async function runBuiltCliJson(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CliJsonResult> {
  const result = await runCmd(process.execPath, ['bin/agent-device.mjs', ...args], {
    allowFailure: true,
    env,
    timeoutMs: CLI_TIMEOUT_MS,
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
