import type { DeviceInfo } from '@agent-device/kernel/device';

import { runAndroidAdb } from './adb.ts';
import { androidAdbResultError } from './adb-failure.ts';

/** A console command answers in well under a second; this bounds a console that stopped answering. */
const EMULATOR_CONSOLE_TIMEOUT_MS = 10_000;

type EmulatorConsoleReply = Readonly<{
  stdout: string;
  /** The reason after `KO:` when the console refused the command (empty for a bare `KO`). */
  refusal?: string;
}>;

/**
 * Runs one emulator console command (`adb emu <command…>`). adb exits 0 whether the console answers
 * `OK` or `KO: <reason>`, so a refusal comes back in the reply for the caller to classify with its
 * own reason; only a failed adb exit throws, naming the first two command words.
 */
export async function runEmulatorConsole(
  device: DeviceInfo,
  command: readonly string[],
  signal: AbortSignal | undefined,
): Promise<EmulatorConsoleReply> {
  const result = await runAndroidAdb(device, ['emu', ...command], {
    signal,
    allowFailure: true,
    timeoutMs: EMULATOR_CONSOLE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw androidAdbResultError(
      `adb emu ${command.slice(0, 2).join(' ')} exited with code ${result.exitCode}`,
      result,
      { deviceId: device.id },
    );
  }
  const refusal = /^KO\b:?[ \t]*(.*)$/m.exec(result.stdout);
  return refusal
    ? { stdout: result.stdout, refusal: refusal[1]!.trim() }
    : { stdout: result.stdout };
}
