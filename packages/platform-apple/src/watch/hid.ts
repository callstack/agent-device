import type { HostCommandResult } from '@agent-device/contracts/platform-runtime-host';

/** Accept only a live watch Simulator display that advertises the HID transport we use. */
export function hasWatchSimulatorHidDisplay(
  result: Pick<HostCommandResult, 'stdout' | 'stderr' | 'exitCode'>,
): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  const width = Number(/Default width:\s*(\d+)/.exec(output)?.[1]);
  const height = Number(/Default height:\s*(\d+)/.exec(output)?.[1]);
  const scale = Number(/Preferred UI Scale:\s*([\d.]+)/.exec(output)?.[1]);
  return (
    result.exitCode === 0 &&
    output.includes('com.apple.CoreSimulator.HID.LegacyHID') &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    Number.isFinite(scale) &&
    width > 0 &&
    height > 0 &&
    scale > 0
  );
}
