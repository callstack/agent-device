import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  assertDeviceShellArgv,
  deviceShellArgv,
  type ShellWord,
} from '@agent-device/kernel/device-shell';
import path from 'node:path';
import {
  isExecutablePath,
  runCmd,
  type ExecOptions,
  type ExecResult,
} from '@agent-device/host-kit/command';
import { hostEnvironment } from '@agent-device/host-kit/process';

export type HarmonyHdcOptions = Pick<
  ExecOptions,
  'allowFailure' | 'timeoutMs' | 'binaryStdout' | 'signal'
>;

export const DEFAULT_HARMONY_HDC_TIMEOUT_MS = 15_000;

/**
 * Runs a non-shell HDC command scoped to exactly one discovered HarmonyOS target. A `shell`
 * argv is refused here; it belongs to {@link runHarmonyShell}.
 */
export async function runHarmonyHdc(
  device: Pick<DeviceInfo, 'id'>,
  args: readonly string[],
  options?: HarmonyHdcOptions,
): Promise<ExecResult> {
  assertDeviceShellArgv(args, 'hdc');
  return await runCmd('hdc', ['-t', device.id, ...args], {
    timeoutMs: DEFAULT_HARMONY_HDC_TIMEOUT_MS,
    ...options,
  });
}

/** Runs `hdc shell <words>` for the target; every word is escaped for HDC's double-quoted transport. */
export async function runHarmonyShell(
  device: Pick<DeviceInfo, 'id'>,
  words: readonly ShellWord[],
  options?: HarmonyHdcOptions,
): Promise<ExecResult> {
  return await runHarmonyHdc(device, deviceShellArgv('hdc', 'shell', words), options);
}

/**
 * DevEco's command-line tools do not amend PATH for non-interactive processes.
 * Honor the documented roots so the daemon sees the same HDC binary as a shell.
 */
export async function ensureHarmonyToolchainPathConfigured(
  env: NodeJS.ProcessEnv = hostEnvironment(),
): Promise<void> {
  const toolchainRoots = [
    env.HDC_SDK_PATH,
    env.DEVECO_SDK_HOME
      ? path.join(env.DEVECO_SDK_HOME, 'default', 'openharmony', 'toolchains')
      : undefined,
    env.HARMONYOS_COMMAND_LINE_TOOLS
      ? path.join(env.HARMONYOS_COMMAND_LINE_TOOLS, 'sdk', 'default', 'openharmony', 'toolchains')
      : undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
  const executableRoots: string[] = [];
  for (const root of toolchainRoots) {
    if (await isExecutablePath(path.join(root, 'hdc'))) {
      executableRoots.push(root);
    }
  }
  if (executableRoots.length === 0) return;
  const currentEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  env.PATH = [...new Set([...executableRoots, ...currentEntries])].join(path.delimiter);
}
