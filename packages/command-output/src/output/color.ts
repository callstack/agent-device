import type { EnvMap } from '@agent-device/kernel/source-value';
import { styleText } from 'node:util';
import { escapeTerminalText } from '@agent-device/kernel/success-text';

export type ColorStream = { isTTY?: boolean };

export function supportsColor(env: EnvMap, stream: ColorStream): boolean {
  const forceColor = env.FORCE_COLOR;
  if (typeof forceColor === 'string') {
    return forceColor !== '0';
  }
  if (typeof env.NO_COLOR === 'string') {
    return false;
  }
  return Boolean(stream.isTTY);
}

/**
 * Wraps `text` in the color codes for `format`. The text itself is escaped (`escapeTerminalText`), so the color codes
 * are the only control characters a colored line carries, and a formatter can write it through the raw path.
 */
export function colorize(
  text: string,
  format: Parameters<typeof styleText>[0],
  options?: Parameters<typeof styleText>[2],
): string {
  return styleText(format, escapeTerminalText(text), options);
}
