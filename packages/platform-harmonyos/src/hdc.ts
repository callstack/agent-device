import type { DeviceInfo } from '@agent-device/kernel/device';
import path from 'node:path';
import {
  assertDeviceShellArgv,
  deviceShellArgv,
  type ShellWord,
} from '@agent-device/kernel/device-shell';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import type {
  HarmonyCommandResult,
  HarmonyCommandRunner,
  HarmonyRunOptions,
} from './command-host.ts';

export const DEFAULT_HARMONY_HDC_TIMEOUT_MS = 15_000;

export type HarmonyHdcOptions = HarmonyRunOptions;

/**
 * The HDC route the whole family takes: one launcher, with each call scoped to exactly one
 * discovered target. Built once from the plugin's host command runner, so HDC is spawned by the
 * daemon host that owns the request's environment and exec trace, never by this bundle's own copy
 * of the host kit.
 */
export type HarmonyHdcRunner = Readonly<{
  /** HDC from a documented toolchain root, or the bare name for the host `PATH` to resolve. */
  executable(): Promise<string>;
  /** Runs HDC with no target selection, for the host-level command discovery starts from. */
  launch(args: readonly string[], options?: HarmonyHdcOptions): Promise<HarmonyCommandResult>;
  /** Runs a non-shell HDC command. A `shell` argv is refused here; it belongs to {@link runShell}. */
  run(
    device: Pick<DeviceInfo, 'id'>,
    args: readonly string[],
    options?: HarmonyHdcOptions,
  ): Promise<HarmonyCommandResult>;
  /** Runs `hdc shell <words>`; every word is escaped for HDC's double-quoted transport. */
  runShell(
    device: Pick<DeviceInfo, 'id'>,
    words: readonly ShellWord[],
    options?: HarmonyHdcOptions,
  ): Promise<HarmonyCommandResult>;
}>;

/**
 * Builds the family's HDC route. The executable is resolved per call, so a toolchain installed
 * after the daemon started is used without a restart. A spawn the host cannot start arrives as the
 * host's typed `TOOL_MISSING` rejection, which every HDC command here answers with the curated
 * missing-toolchain error naming the documented roots.
 */
export function createHarmonyHdcRunner(commands: HarmonyCommandRunner): HarmonyHdcRunner {
  const spawn = async (args: readonly string[], options?: HarmonyHdcOptions) => {
    const executable = await commands.resolveHdc();
    try {
      return await commands.run(executable, args, {
        timeoutMs: DEFAULT_HARMONY_HDC_TIMEOUT_MS,
        ...options,
      });
    } catch (error) {
      throw missingHdcError(executable, error);
    }
  };
  return Object.freeze({
    executable: async () => await commands.resolveHdc(),
    launch: async (args, options) => await spawn(targetArgv(args), options),
    run: async (device, args, options) =>
      await spawn(targetArgv(args, deviceShellPrefix(device)), options),
    // Its argv is already minted by deviceShellArgv, so it is not checked again.
    runShell: async (device, words, options) =>
      await spawn(deviceShellArgv('hdc', 'shell', words, deviceShellPrefix(device)), options),
  });
}

const MISSING_HDC_HINT =
  'Install HarmonyOS Command Line Tools, then add its sdk/default/openharmony/toolchains directory to PATH or set HDC_SDK_PATH.';

/**
 * The curated missing-toolchain error for the host's typed `TOOL_MISSING` rejection of an HDC spawn
 * (the host rejects a spawn it cannot start rather than reporting an unusable exit code). Any other
 * failure passes through untouched, so a canceled or timed-out command keeps its own verdict.
 */
function missingHdcError(executable: string, error: unknown): unknown {
  const failure = asAppError(error);
  if (failure.code !== 'TOOL_MISSING') return error;
  const location = path.isAbsolute(executable) ? `at ${executable}` : 'in PATH';
  return new AppError(
    'TOOL_MISSING',
    `hdc not found ${location}`,
    { hint: MISSING_HDC_HINT },
    error,
  );
}

/** The target selection HDC addresses one device with. */
function deviceShellPrefix(device: Pick<DeviceInfo, 'id'>): readonly string[] {
  return ['-t', device.id];
}

/**
 * HDC argv for one discovered target: the target selection ahead of the command. A `shell` argv
 * reaching this point would be quoted twice by HDC, so it is refused — shell words take
 * {@link HarmonyHdcRunner.runShell}, which mints its argv with {@link deviceShellArgv}.
 */
function targetArgv(args: readonly string[], prefix: readonly string[] = []): readonly string[] {
  const argv = [...prefix, ...args];
  assertDeviceShellArgv(argv, 'hdc');
  return argv;
}
