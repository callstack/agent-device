import { runCmd } from '@agent-device/host-kit/command';

export const TOOLCHAIN_TIMEOUT_MS = 3_000;

export async function commandFirstLine(cmd: string, args: string[]): Promise<string | undefined> {
  const output = await commandOutput(cmd, args);
  return output === undefined ? undefined : firstOutputLine(output);
}

/** Stdout of a toolchain probe that exited 0, or undefined when the tool is missing or failed. */
export async function commandOutput(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await runCmd(cmd, args, { allowFailure: true, timeoutMs: TOOLCHAIN_TIMEOUT_MS });
    return result.exitCode === 0 ? result.stdout : undefined;
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
