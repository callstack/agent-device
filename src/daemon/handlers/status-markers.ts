import { styleText } from 'node:util';

export type CliStatusMarkerStatus = 'pass' | 'fail' | 'warn' | 'skip';

export function formatCliStatusMarker(
  status: CliStatusMarkerStatus,
  options: { passFormat?: 'green' | 'yellow' } = {},
): string {
  const useColor =
    process.env.FORCE_COLOR !== undefined
      ? process.env.FORCE_COLOR !== '0'
      : process.env.NO_COLOR === undefined && Boolean(process.stderr.isTTY);
  if (status === 'pass') {
    const format = options.passFormat ?? 'green';
    return useColor ? styleText(format, '✓', { validateStream: false }) : '✓';
  }
  if (status === 'fail') {
    return useColor ? styleText('red', '⨯', { validateStream: false }) : '⨯';
  }
  if (status === 'warn') {
    return useColor ? styleText('yellow', '!', { validateStream: false }) : '!';
  }
  return useColor ? styleText('dim', '-', { validateStream: false }) : '-';
}
