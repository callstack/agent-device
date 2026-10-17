import { styleText } from 'node:util';
import type { EnvMap } from '@agent-device/kernel/source-value';

export type CliStatusMarkerStatus = 'pass' | 'fail' | 'warn' | 'skip';

/** `FORCE_COLOR` decides when set; otherwise color needs a TTY and no `NO_COLOR`. */
export function shouldColorStatusMarkers(env: EnvMap, stderrIsTTY: boolean): boolean {
  return env.FORCE_COLOR !== undefined
    ? env.FORCE_COLOR !== '0'
    : env.NO_COLOR === undefined && stderrIsTTY;
}

export function formatCliStatusMarker(
  status: CliStatusMarkerStatus,
  options: { useColor: boolean; passFormat?: 'green' | 'yellow' },
): string {
  const { useColor } = options;
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
