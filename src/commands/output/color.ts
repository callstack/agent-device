import { styleText } from 'node:util';

export function supportsColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  const forceColor = process.env.FORCE_COLOR;
  if (typeof forceColor === 'string') {
    return forceColor !== '0';
  }
  if (typeof process.env.NO_COLOR === 'string') {
    return false;
  }
  return Boolean(stream.isTTY);
}

export function colorize(
  text: string,
  format: Parameters<typeof styleText>[0],
  options?: Parameters<typeof styleText>[2],
): string {
  return styleText(format, text, options);
}
