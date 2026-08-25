import { runCmd } from '../utils/exec.ts';

export const TOOLCHAIN_TIMEOUT_MS = 3_000;

export async function commandFirstLine(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await runCmd(cmd, args, { allowFailure: true, timeoutMs: TOOLCHAIN_TIMEOUT_MS });
    if (result.exitCode !== 0) return undefined;
    return firstOutputLine(result.stdout);
  } catch {
    return undefined;
  }
}

export function firstOutputLine(output: string): string | undefined {
  return output
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
}
