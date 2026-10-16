import type { TelephonyEventInput } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

import { runEmulatorConsole } from '../emulator-console.ts';

const CONSOLE_REFUSED_HINT =
  'The emulator console refused the event. accept needs a call from that same number (start one with telephony call <number>), and an emulator image without a modem has no telephony to simulate.';

/** Simulates one telephony event through the emulator console (`gsm …` / `sms send …`). */
export async function sendAndroidTelephonyEvent(
  device: DeviceInfo,
  input: TelephonyEventInput,
  signal: AbortSignal,
): Promise<void> {
  const reply = await runEmulatorConsole(device, consoleCommand(input), signal);
  if (reply.refusal !== undefined) {
    throw new AppError('COMMAND_FAILED', `The emulator console refused telephony ${input.action}`, {
      deviceId: device.id,
      reason: 'telephony-console-refused',
      stdout: reply.stdout.trim(),
      ...(reply.refusal ? { consoleReason: reply.refusal } : {}),
      hint: CONSOLE_REFUSED_HINT,
    });
  }
}

function consoleCommand(input: TelephonyEventInput): string[] {
  switch (input.action) {
    case 'call':
    case 'accept':
    case 'cancel':
      return ['gsm', input.action, input.number];
    case 'sms':
      return ['sms', 'send', input.number, escapeConsoleSmsText(input.text)];
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
