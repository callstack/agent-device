import type { TelephonyEventInput } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

import { runAndroidAdb } from '../adb.ts';
import { androidAdbResultError } from '../adb-failure.ts';

const CONSOLE_REFUSED_HINT =
  'The emulator console refused the event. accept and cancel need a call from that same number (start one with telephony call <number>), and an emulator image without a modem has no telephony to simulate.';

/**
 * Simulates one telephony event through the emulator console (`adb emu gsm …` / `adb emu sms send
 * …`). The console answers `KO: <reason>` on stdout, with a zero exit code, when it refuses an
 * event, so the reply is checked as well as the exit code.
 */
export async function sendAndroidTelephonyEvent(
  device: DeviceInfo,
  input: TelephonyEventInput,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const args = emulatorConsoleArgs(input);
  const result = await runAndroidAdb(device, args, { signal: options.signal, allowFailure: true });
  if (result.exitCode !== 0) {
    // Names the console command without its number or message text.
    const command = args.slice(0, 3).join(' ');
    throw androidAdbResultError(`adb ${command} exited with code ${result.exitCode}`, result, {
      deviceId: device.id,
    });
  }
  const refusal = /^KO\b:?[ \t]*(.*)$/m.exec(result.stdout);
  if (refusal) {
    throw new AppError('COMMAND_FAILED', `The emulator console refused telephony ${input.action}`, {
      deviceId: device.id,
      reason: 'telephony-console-refused',
      stdout: result.stdout.trim(),
      ...(refusal[1] ? { consoleReason: refusal[1].trim() } : {}),
      hint: CONSOLE_REFUSED_HINT,
    });
  }
}

function emulatorConsoleArgs(input: TelephonyEventInput): string[] {
  switch (input.action) {
    case 'call':
    case 'accept':
    case 'cancel':
      return ['emu', 'gsm', input.action, input.number];
    case 'sms':
      return ['emu', 'sms', 'send', input.number, escapeConsoleSmsText(input.text)];
  }
}

/**
 * `adb emu` writes its arguments to the console as one space-joined line, and `sms send` takes the
 * rest of that line as the message. The console decodes `\\`, `\n`, `\xNN`, and `\uNNNN` escapes
 * in it and rejects any other backslash, so a literal backslash is doubled and a line break is
 * sent as `\n` rather than ending the console command.
 */
function escapeConsoleSmsText(text: string): string {
  return text.replaceAll('\\', String.raw`\\`).replaceAll('\n', String.raw`\n`);
}
