import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runCmd, whichCmd, type ExecOptions, type ExecResult } from '../../utils/exec.ts';

export type HarmonyHdcOptions = Pick<
  ExecOptions,
  'allowFailure' | 'timeoutMs' | 'binaryStdout' | 'signal'
>;

export const DEFAULT_HARMONY_HDC_TIMEOUT_MS = 15_000;

/** Runs an HDC command scoped to exactly one discovered HarmonyOS target. */
export async function runHarmonyHdc(
  device: Pick<DeviceInfo, 'id'>,
  args: string[],
  options?: HarmonyHdcOptions,
): Promise<ExecResult> {
  return await runCmd('hdc', ['-t', device.id, ...args], {
    timeoutMs: DEFAULT_HARMONY_HDC_TIMEOUT_MS,
    ...options,
  });
}

export async function ensureHdcAvailable(): Promise<void> {
  await ensureHarmonyToolchainPathConfigured();
  if (await whichCmd('hdc')) return;
  throw new AppError('TOOL_MISSING', 'hdc not found in PATH', {
    hint: 'Install HarmonyOS Command Line Tools, then add its sdk/default/openharmony/toolchains directory to PATH.',
  });
}

/**
 * DevEco's command-line tools do not amend PATH for non-interactive processes.
 * Honor the documented roots so the daemon sees the same HDC binary as a shell.
 */
async function ensureHarmonyToolchainPathConfigured(
  env: NodeJS.ProcessEnv = process.env,
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
    try {
      await fs.access(path.join(root, 'hdc'), fs.constants.X_OK);
      executableRoots.push(root);
    } catch {
      // Continue through explicit alternatives; the final missing-tool error names recovery.
    }
  }
  if (executableRoots.length === 0) return;
  const currentEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  env.PATH = [...new Set([...executableRoots, ...currentEntries])].join(path.delimiter);
}

export function harmonyDeviceForTarget(
  target: string,
  options: { name: string; emulator: boolean },
): DeviceInfo {
  return {
    platform: 'harmonyos',
    id: target,
    name: options.name,
    kind: options.emulator ? 'emulator' : 'device',
    target: 'mobile',
    booted: true,
  };
}
