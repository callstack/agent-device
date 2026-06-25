import { colorize, supportsColor } from './utils/output.ts';

export type CliStatusMarkerStatus = 'pass' | 'fail' | 'warn' | 'skip';

export function formatCliStatusMarker(
  status: CliStatusMarkerStatus,
  options: { passFormat?: 'green' | 'yellow' } = {},
): string {
  const useColor = supportsColor(process.stderr);
  if (status === 'pass') {
    const format = options.passFormat ?? 'green';
    return useColor ? colorizeStatusMarker('✓', format) : '✓';
  }
  if (status === 'fail') return useColor ? colorizeStatusMarker('⨯', 'red') : '⨯';
  if (status === 'warn') return useColor ? colorizeStatusMarker('!', 'yellow') : '!';
  return useColor ? colorizeStatusMarker('-', 'dim') : '-';
}

function colorizeStatusMarker(text: string, format: Parameters<typeof colorize>[1]): string {
  return colorize(text, format, { validateStream: false });
}
